import type { ClankerProject, Origin, ProjectId, TrackerId, TrackerProject } from "@clanker/api";
import type { Connections } from "../connections/connections";
import { isLinearId, type LinearTracker } from "../linear/tracker";
import { ProjectNotFoundError, type Projects } from "../projects/projects";
import type { ProjectBinding } from "./issues";

/** El core no puede listar los proyectos de este tracker (sin adapter, sin cuenta conectada o el tracker falló): el mensaje dice qué hacer. */
export class TrackerProjectsError extends Error {}

export interface TrackerProjectsDeps {
  connections: Pick<Connections, "list">;
  /** El adapter de Linear para el workspace `account`. */
  linear: (account: string) => LinearTracker;
  projects: Pick<Projects, "get" | "renameTrackerRef">;
}

/** Cómo se nombra el proyecto del tracker de un proyecto de Clanker, para leer su cola. */
export type ProjectBindings = (project: Pick<ClankerProject, "id" | "tracker" | "trackerRef">) => Promise<ProjectBinding>;

/** El `trackerRef` del proyecto tal cual está guardado: lo que usan los trackers sin otros nombres para un proyecto y los tests. */
export const storedBinding: ProjectBindings = (project) =>
  Promise.resolve({ projectId: project.id, project: { tracker: project.tracker, id: project.trackerRef } });

export interface TrackerProjects {
  /**
   * Los proyectos del tracker de todas sus cuentas conectadas, los de la persona primero y luego por nombre.
   * Lanza `TrackerProjectsError`.
   */
  list(tracker: TrackerId): Promise<TrackerProject[]>;
  /**
   * El `trackerRef` canónico de lo que una persona pegó para nombrar un proyecto (en Linear, su UUID: acepta también
   * el slugId, el identificador y la URL). Lo que ya es un UUID, y todo tracker que no sabe resolver, vuelve igual.
   * Lanza `TrackerProjectsError` si ninguna cuenta conectada tiene el proyecto.
   */
  resolve(tracker: TrackerId, ref: string, account?: string | null): Promise<string>;
  /**
   * Un proyecto de Linear guardado antes de que se normalizara (su `trackerRef` es el identificador visible, p. ej.
   * `P-ENG-1525`, no el UUID) pasa a guardar el UUID del mismo proyecto: misma cola, mismos issues, mismo cursor
   * (`projects.renameTrackerRef`). Lo que ya está normalizado vuelve igual. Lanza `TrackerProjectsError` si no puede
   * resolverlo (Linear sin conectar o sin acceso al proyecto).
   */
  normalize(id: ProjectId, origin: Origin): Promise<ClankerProject>;
  /**
   * El proyecto del tracker de donde sale la cola del proyecto, normalizando antes su `trackerRef` si hace falta.
   * Es el único lugar donde la cola (sync, cambios) lee ese ref. Lanza `TrackerProjectsError`.
   */
  binding: ProjectBindings;
}

export function createTrackerProjects({ connections, linear, projects }: TrackerProjectsDeps): TrackerProjects {
  function linearAccounts(): string[] {
    const accounts = connections.list().filter((c) => c.provider === "linear");
    if (accounts.length === 0) {
      throw new TrackerProjectsError("Linear no está conectado: conéctalo en Conexiones para elegir un proyecto.");
    }
    return accounts.map((c) => c.account);
  }

  const self: TrackerProjects = {
    async resolve(tracker, ref, account) {
      if (tracker !== "linear" || isLinearId(ref)) return ref;
      const accounts = account ? [account] : linearAccounts();
      for (const account of accounts) {
        try {
          const project = await linear(account).resolveProject(ref);
          if (project) return project.ref.id;
        } catch (error) {
          throw new TrackerProjectsError(`No pude buscar "${ref}" en el workspace ${account} de Linear: ${(error as Error).message}`, { cause: error });
        }
      }
      throw new TrackerProjectsError(
        `No encontré el proyecto "${ref}" en Linear (${accounts.join(", ")}): pega su URL o su id, o elígelo de la lista.`,
      );
    },

    async normalize(id, origin) {
      const project = projects.get(id);
      if (!project) throw new ProjectNotFoundError(id);
      if (project.tracker !== "linear" || isLinearId(project.trackerRef)) return project;
      let uuid: string;
      try {
        uuid = await self.resolve("linear", project.trackerRef, project.trackerAccount);
      } catch (error) {
        throw new TrackerProjectsError(
          `${project.name} guarda "${project.trackerRef}" (el identificador de su proyecto de Linear, no su id) y no pude resolverlo: ${(error as Error).message.replace(/\.?$/, ".")} Conecta Linear en Conexiones con una cuenta que vea ese proyecto, o elígelo de nuevo en Ajustes, en "Proyecto del tracker".`,
          { cause: error },
        );
      }
      return projects.renameTrackerRef(id, uuid, origin);
    },

    async binding(project) {
      const { trackerRef } = await self.normalize(project.id, "core");
      return { projectId: project.id, project: { tracker: project.tracker, id: trackerRef } };
    },

    async list(tracker) {
      if (tracker !== "linear") {
        throw new TrackerProjectsError(`Clanker Yard no sabe listar los proyectos de ${tracker}: escribe el id del proyecto a mano.`);
      }
      const accounts = linearAccounts().map((account) => ({ account }));
      const perAccount = await Promise.all(
        accounts.map(async ({ account }) => {
          try {
            return (await linear(account).listProjects()).map((p): TrackerProject => ({ ...p, account }));
          } catch (error) {
            throw new TrackerProjectsError(`No pude leer los proyectos del workspace ${account} de Linear: ${(error as Error).message}`, { cause: error });
          }
        }),
      );
      return perAccount
        .flat()
        .sort((a, b) => Number(b.mine === true) - Number(a.mine === true) || a.name.localeCompare(b.name) || a.account.localeCompare(b.account));
    },
  };
  return self;
}
