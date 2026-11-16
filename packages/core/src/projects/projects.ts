import { type ClankerProject, type NewProject, type Origin, type ProjectDefaults, ProjectDefaultsPatch, type ProjectId, type ProjectPatch, type ProjectRepo } from "@clanker/api";
import { and, asc, eq } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import type * as z from "zod";
import type { Defs } from "../defs/defs";
import { newId } from "../store/conventions";
import { readMetaJson } from "../store/meta-json";
import { issues, meta, projectRepos, projects, repos, syncCursors } from "../store/schema";
import { issuesCursorKey } from "../tracker/issues";
import type { Store, Tx } from "../store/store";

type ProjectRow = typeof projects.$inferSelect;
/** Lo que `projects.update` cambia en la fila: todo menos la lista de repos, que vive en `project_repos`. */
type ProjectColumns = Omit<ProjectRow, "id">;

/** El proyecto que se pidió no existe. */
export class ProjectNotFoundError extends Error {
  constructor(id: ProjectId) {
    super(`No existe el proyecto ${id}.`);
  }
}

/** Los datos no forman un proyecto válido: el mensaje dice qué cambiar. Nada se guardó. */
export class InvalidProjectError extends Error {}

export interface Projects {
  /** Por slug. */
  list(): ClankerProject[];
  get(id: ProjectId): ClankerProject | undefined;
  /**
   * Con tracker `local`, `trackerRef` es el id del proyecto. Lanza `InvalidProjectError` si el slug o
   * el par (tracker, trackerRef) ya existen, si el flujo o el perfil por defecto no existen, o si un
   * repo no está registrado, se repite o comparte un label con otro. Emite `project.created`.
   */
  create(input: z.output<typeof NewProject>, origin: Origin): ClankerProject;
  /**
   * Lo que `create` usa para el flujo, el perfil, `parallel` y `maxCostUsd` que no se pidieron: lo guardado en
   * Ajustes o, sin nada guardado, sin flujo ni perfil, 1 en paralelo y sin tope. Un flujo o perfil por defecto que
   * ya no existe se ignora al crear.
   */
  defaults(): ProjectDefaults;
  /** Cambia los defaults de proyectos nuevos (lo que no se pasa no cambia) sin tocar proyectos existentes. Lanza `InvalidProjectError` si el flujo o el perfil no existen. */
  setDefaults(patch: ProjectDefaultsPatch): ProjectDefaults;
  /**
   * Cambia solo los campos presentes (`repos` reemplaza la lista). Emite `project.updated` con lo que
   * cambió y, si cambió el estado, `project.paused`, `project.resumed` o `project.archived`; sin cambios no emite nada.
   */
  update(id: ProjectId, patch: ProjectPatch, origin: Origin): ClankerProject;
  /**
   * Reemplaza el `trackerRef` por otro nombre del MISMO proyecto del tracker (en Linear, el UUID de un proyecto
   * guardado con su identificador): conserva sus issues y mueve el cursor de sync a la clave nueva. No sirve para
   * cambiar de proyecto (para eso es `update`). Emite `project.updated`; sin cambio no emite nada. Lanza
   * `ProjectNotFoundError` o `InvalidProjectError` si otro proyecto ya usa ese `trackerRef`.
   */
  renameTrackerRef(id: ProjectId, trackerRef: string, origin: Origin): ClankerProject;
  /**
   * Pausa el proyecto: el Scheduler deja de lanzar sus issues. Lo que ya corre (sus corridas, el carril de
   * mantenimiento) y los demás proyectos no se tocan. Emite `project.paused`; ya pausado no emite nada. Lanza
   * `ProjectNotFoundError` si no existe e `InvalidProjectError` si está archivado.
   */
  pause(id: ProjectId, origin: Origin): ClankerProject;
  /** Lo contrario de `pause`: emite `project.resumed`. Los mismos errores. */
  resume(id: ProjectId, origin: Origin): ClankerProject;
}

const STATUS_EVENT = {
  active: "project.resumed",
  paused: "project.paused",
  archived: "project.archived",
} as const;

const DEFAULTS_KEY = "project_defaults";
const BASE_DEFAULTS: ProjectDefaults = { defaultFlowId: null, defaultProfileId: null, parallel: 1, maxCostUsd: null };

export function createProjects({ store, defs }: { store: Store; defs: Defs }): Projects {
  /** El flujo y el perfil por defecto se guardan por slug: tienen que resolver a una def viva. */
  function assertDefaults({ defaultFlowId, defaultProfileId }: Pick<ProjectPatch, "defaultFlowId" | "defaultProfileId">) {
    if (defaultFlowId && !defs.resolve("flow", defaultFlowId)) {
      throw new InvalidProjectError(`No existe el flujo "${defaultFlowId}" para usar por defecto.`);
    }
    if (defaultProfileId && !defs.resolve("profile", defaultProfileId)) {
      throw new InvalidProjectError(`No existe el perfil "${defaultProfileId}" para usar por defecto.`);
    }
  }

  /** Cada repo debe estar registrado y aparecer una sola vez; un label manda a un solo repo. */
  function assertRepos(tx: Pick<Tx, "db">, bound: readonly ProjectRepo[]) {
    const seenRepos = new Set<string>();
    const labelOwner = new Map<string, string>();
    for (const { repoId, labels } of bound) {
      if (!tx.db.select({ id: repos.id }).from(repos).where(eq(repos.id, repoId)).get()) {
        throw new InvalidProjectError(`No existe el repo ${repoId}: regístralo con repos.add.`);
      }
      if (seenRepos.has(repoId)) throw new InvalidProjectError(`El repo ${repoId} está dos veces en la lista.`);
      seenRepos.add(repoId);
      for (const label of labels) {
        const owner = labelOwner.get(label);
        if (owner !== undefined && owner !== repoId) {
          throw new InvalidProjectError(`El label "${label}" manda a dos repos (${owner} y ${repoId}): déjalo en uno.`);
        }
        labelOwner.set(label, repoId);
      }
    }
  }

  function boundRepos(db: Store["db"], projectId: ProjectId): ProjectRepo[] {
    return db
      .select({ repoId: projectRepos.repoId, labels: projectRepos.labels })
      .from(projectRepos)
      .where(eq(projectRepos.projectId, projectId))
      .orderBy(asc(projectRepos.ord))
      .all();
  }

  function setRepos(tx: Pick<Tx, "db">, projectId: ProjectId, bound: readonly ProjectRepo[]) {
    tx.db.delete(projectRepos).where(eq(projectRepos.projectId, projectId)).run();
    bound.forEach(({ repoId, labels }, ord) =>
      tx.db.insert(projectRepos).values({ projectId, repoId, ord, labels }).run(),
    );
  }

  const withRepos = (db: Store["db"], row: ProjectRow): ClankerProject => ({ ...row, repos: boundRepos(db, row.id) });

  const projectsApi: Projects = {
    list: () => store.db.select().from(projects).orderBy(asc(projects.slug)).all().map((row) => withRepos(store.db, row)),

    get(id) {
      const row = store.db.select().from(projects).where(eq(projects.id, id)).get();
      return row && withRepos(store.db, row);
    },

    defaults() {
      return { ...BASE_DEFAULTS, ...readMetaJson(store.db, DEFAULTS_KEY, ProjectDefaultsPatch) };
    },

    setDefaults(patch) {
      assertDefaults(patch);
      const next: ProjectDefaults = { ...projectsApi.defaults(), ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) };
      const value = JSON.stringify(next);
      store.tx((tx) => tx.db.insert(meta).values({ key: DEFAULTS_KEY, value }).onConflictDoUpdate({ target: meta.key, set: { value } }).run());
      return next;
    },

    create(input, origin) {
      const fallback = projectsApi.defaults();
      const live = (kind: "flow" | "profile", slug: string | null) => (slug !== null && defs.resolve(kind, slug) ? slug : null);
      const defaultFlowId = input.defaultFlowId ?? live("flow", fallback.defaultFlowId);
      const defaultProfileId = input.defaultProfileId ?? live("profile", fallback.defaultProfileId);
      assertDefaults({ defaultFlowId, defaultProfileId });
      return store.tx((tx) => {
        const id = newId("prj");
        const trackerRef = input.tracker === "local" ? id : input.trackerRef;
        if (trackerRef === undefined) {
          throw new InvalidProjectError(`Falta trackerRef: un proyecto de ${input.tracker} lo necesita.`);
        }
        if (tx.db.select({ id: projects.id }).from(projects).where(eq(projects.slug, input.slug)).get()) {
          throw new InvalidProjectError(`Ya existe un proyecto con el slug "${input.slug}".`);
        }
        if (
          tx.db
            .select({ id: projects.id })
            .from(projects)
            .where(and(eq(projects.tracker, input.tracker), eq(projects.trackerRef, trackerRef)))
            .get()
        ) {
          throw new InvalidProjectError(`Ya hay un proyecto de ${input.tracker} para "${trackerRef}".`);
        }
        assertRepos(tx, input.repos);
        const values: ProjectColumns = {
          slug: input.slug,
          name: input.name,
          tracker: input.tracker,
          trackerRef,
          trackerAccount: input.trackerAccount ?? null,
          defaultFlowId,
          defaultProfileId,
          parallel: input.parallel ?? fallback.parallel,
          stackOn: input.stackOn,
          statusMapping: input.statusMapping,
          status: "active",
          flowParams: input.flowParams,
          queueFilter: input.queueFilter,
          conventions: input.conventions,
          maxCostUsd: input.maxCostUsd === undefined ? fallback.maxCostUsd : input.maxCostUsd,
        };
        const row = tx.db.insert(projects).values({ ...values, id }).returning().get();
        setRepos(tx, id, input.repos);
        tx.emit({
          type: "project.created",
          origin,
          projectId: id,
          payload: { projectId: id, fields: [...Object.keys(values), "repos"] },
        });
        return { ...row, repos: boundRepos(tx.db, id) };
      });
    },

    update(id, patch, origin) {
      assertDefaults(patch);
      return store.tx((tx) => {
        const current = tx.db.select().from(projects).where(eq(projects.id, id)).get();
        if (!current) throw new ProjectNotFoundError(id);
        const { repos: newRepos, ...columns } = patch;
        const changes = Object.fromEntries(
          Object.entries(columns).filter(([field, value]) => value !== undefined && !isDeepStrictEqual(current[field as keyof ProjectRow], value)),
        ) as Partial<ProjectColumns>;
        if (changes.trackerRef !== undefined || changes.trackerAccount !== undefined) {
          if (current.tracker === "local") {
            throw new InvalidProjectError("Un proyecto local no cambia de trackerRef ni de cuenta: es el id del proyecto.");
          }
          if (
            changes.trackerRef !== undefined &&
            tx.db.select({ id: projects.id }).from(projects).where(and(eq(projects.tracker, current.tracker), eq(projects.trackerRef, changes.trackerRef))).get()
          ) {
            throw new InvalidProjectError(`Ya hay un proyecto de ${current.tracker} para "${changes.trackerRef}".`);
          }
          // Fijar la cuenta de un proyecto que no la tenía no cambia de dónde salen sus issues; lo demás sí.
          const movesQueue = changes.trackerRef !== undefined || current.trackerAccount !== null;
          if (movesQueue && tx.db.select({ id: issues.id }).from(issues).where(eq(issues.projectId, id)).get()) {
            throw new InvalidProjectError(
              `${current.name} ya tiene issues de "${current.trackerRef}" en el caché: para trabajar sobre otro proyecto de ${current.tracker} crea un proyecto nuevo.`,
            );
          }
          if (movesQueue) tx.db.delete(syncCursors).where(eq(syncCursors.key, issuesCursorKey(current.tracker, current.trackerRef))).run();
        }
        const reposChanged = newRepos !== undefined && !isDeepStrictEqual(boundRepos(tx.db, id), newRepos);
        if (Object.keys(changes).length === 0 && !reposChanged) return withRepos(tx.db, current);
        if (newRepos !== undefined && reposChanged) {
          assertRepos(tx, newRepos);
          setRepos(tx, id, newRepos);
        }
        // Las categorías del caché salen del mapeo al sincronizar: sin cursor, el próximo sync relee todo el proyecto.
        if (changes.statusMapping !== undefined) {
          tx.db.delete(syncCursors).where(eq(syncCursors.key, issuesCursorKey(current.tracker, current.trackerRef))).run();
        }
        const row =
          Object.keys(changes).length === 0
            ? current
            : tx.db.update(projects).set(changes).where(eq(projects.id, id)).returning().get();
        if (!row) throw new ProjectNotFoundError(id);
        const { status, ...others } = changes;
        const fields = [...Object.keys(others), ...(reposChanged ? ["repos"] : [])];
        const scope = { origin, projectId: id } as const;
        if (fields.length > 0) {
          tx.emit({ type: "project.updated", ...scope, payload: { projectId: id, fields } });
        }
        if (status !== undefined) {
          tx.emit({ type: STATUS_EVENT[status], ...scope, payload: { projectId: id, fields: ["status"] } });
        }
        return withRepos(tx.db, row);
      });
    },

    renameTrackerRef(id, trackerRef, origin) {
      return store.tx((tx) => {
        const current = tx.db.select().from(projects).where(eq(projects.id, id)).get();
        if (!current) throw new ProjectNotFoundError(id);
        if (current.trackerRef === trackerRef) return withRepos(tx.db, current);
        if (tx.db.select({ id: projects.id }).from(projects).where(and(eq(projects.tracker, current.tracker), eq(projects.trackerRef, trackerRef))).get()) {
          throw new InvalidProjectError(`Ya hay un proyecto de ${current.tracker} para "${trackerRef}".`);
        }
        const row = tx.db.update(projects).set({ trackerRef }).where(eq(projects.id, id)).returning().get();
        if (!row) throw new ProjectNotFoundError(id);
        const oldKey = issuesCursorKey(current.tracker, current.trackerRef);
        const cursor = tx.db.select().from(syncCursors).where(eq(syncCursors.key, oldKey)).get();
        if (cursor) {
          const moved = { ...cursor, key: issuesCursorKey(current.tracker, trackerRef) };
          tx.db.insert(syncCursors).values(moved).onConflictDoUpdate({ target: syncCursors.key, set: moved }).run();
          tx.db.delete(syncCursors).where(eq(syncCursors.key, oldKey)).run();
        }
        tx.emit({ type: "project.updated", origin, projectId: id, payload: { projectId: id, fields: ["trackerRef"] } });
        return withRepos(tx.db, row);
      });
    },

    pause: (id, origin) => setStatus(id, "paused", origin),
    resume: (id, origin) => setStatus(id, "active", origin),
  };

  /** Pausar o retomar no desarchiva: `update` con `status` lo permitiría sin querer. */
  function setStatus(id: ProjectId, status: "active" | "paused", origin: Origin): ClankerProject {
    const current = store.db.select({ status: projects.status }).from(projects).where(eq(projects.id, id)).get();
    if (!current) throw new ProjectNotFoundError(id);
    if (current.status === "archived") throw new InvalidProjectError(`El proyecto ${id} está archivado: no se puede ${status === "paused" ? "pausar" : "retomar"}.`);
    return projectsApi.update(id, { status }, origin);
  }
  return projectsApi;
}

