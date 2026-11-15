import type { ClankerProject, NewProject, Origin, ProjectId, ProjectPatch, ProjectRepo } from "@clanker/api";
import { and, asc, eq } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import type * as z from "zod";
import type { Defs } from "../defs/defs";
import { newId } from "../store/conventions";
import { projectRepos, projects, repos } from "../store/schema";
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
   * Cambia solo los campos presentes (`repos` reemplaza la lista). Emite `project.updated` con lo que
   * cambió y, si cambió el estado, `project.paused`, `project.resumed` o `project.archived`; sin cambios no emite nada.
   */
  update(id: ProjectId, patch: ProjectPatch, origin: Origin): ClankerProject;
}

const STATUS_EVENT = {
  active: "project.resumed",
  paused: "project.paused",
  archived: "project.archived",
} as const;

export function createProjects(store: Store, defs: Defs): Projects {
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

  return {
    list: () => store.db.select().from(projects).orderBy(asc(projects.slug)).all().map((row) => withRepos(store.db, row)),

    get(id) {
      const row = store.db.select().from(projects).where(eq(projects.id, id)).get();
      return row && withRepos(store.db, row);
    },

    create(input, origin) {
      assertDefaults(input);
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
          defaultFlowId: input.defaultFlowId ?? null,
          defaultProfileId: input.defaultProfileId ?? null,
          parallel: input.parallel,
          stackOn: input.stackOn,
          status: "active",
          flowParams: input.flowParams,
          queueFilter: input.queueFilter,
          conventions: input.conventions,
          maxCostUsd: input.maxCostUsd,
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
        const reposChanged = newRepos !== undefined && !isDeepStrictEqual(boundRepos(tx.db, id), newRepos);
        if (Object.keys(changes).length === 0 && !reposChanged) return withRepos(tx.db, current);
        if (newRepos !== undefined && reposChanged) {
          assertRepos(tx, newRepos);
          setRepos(tx, id, newRepos);
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
  };
}

