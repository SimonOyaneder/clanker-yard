import type { ClankerProject, NewProject, Origin, ProjectId, ProjectPatch } from "@clanker/api";
import { and, asc, eq } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import type * as z from "zod";
import type { Defs } from "../defs/defs";
import { newId } from "../store/conventions";
import { projects } from "../store/schema";
import type { Store } from "../store/store";

type ProjectRow = typeof projects.$inferSelect;

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
   * el par (tracker, trackerRef) ya existen, o si el flujo o el perfil por defecto no existen. Emite
   * `project.created`.
   */
  create(input: z.output<typeof NewProject>, origin: Origin): ClankerProject;
  /**
   * Cambia solo los campos presentes. Emite `project.updated` con lo que cambió y, si cambió el
   * estado, `project.paused`, `project.resumed` o `project.archived`; sin cambios no emite nada.
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

  return {
    list: () => store.db.select().from(projects).orderBy(asc(projects.slug)).all(),

    get: (id) => store.db.select().from(projects).where(eq(projects.id, id)).get(),

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
        const values: Omit<ProjectRow, "id"> = {
          slug: input.slug,
          name: input.name,
          tracker: input.tracker,
          trackerRef,
          defaultFlowId: input.defaultFlowId ?? null,
          defaultProfileId: input.defaultProfileId ?? null,
          parallel: input.parallel,
          status: "active",
          flowParams: input.flowParams,
        };
        const row = tx.db.insert(projects).values({ ...values, id }).returning().get();
        tx.emit({
          type: "project.created",
          origin,
          projectId: id,
          payload: { projectId: id, fields: Object.keys(values) },
        });
        return row;
      });
    },

    update(id, patch, origin) {
      assertDefaults(patch);
      return store.tx((tx) => {
        const current = tx.db.select().from(projects).where(eq(projects.id, id)).get();
        if (!current) throw new ProjectNotFoundError(id);
        const changes = Object.fromEntries(
          Object.entries(patch).filter(([field, value]) => value !== undefined && !isDeepStrictEqual(current[field as keyof ProjectRow], value)),
        ) as Partial<ProjectRow>;
        const fields = Object.keys(changes);
        if (fields.length === 0) return current;
        const row = tx.db.update(projects).set(changes).where(eq(projects.id, id)).returning().get();
        if (!row) throw new ProjectNotFoundError(id);
        const { status, ...others } = changes;
        const scope = { origin, projectId: id } as const;
        if (Object.keys(others).length > 0) {
          tx.emit({ type: "project.updated", ...scope, payload: { projectId: id, fields: Object.keys(others) } });
        }
        if (status !== undefined) {
          tx.emit({ type: STATUS_EVENT[status], ...scope, payload: { projectId: id, fields: ["status"] } });
        }
        return row;
      });
    },
  };
}

