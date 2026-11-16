import type { TrackerId, TrackerProject } from "@clanker/api";
import type { Connections } from "../connections/connections";
import { isLinearId, type LinearTracker } from "../linear/tracker";

/** El core no puede listar los proyectos de este tracker (sin adapter, sin cuenta conectada o el tracker falló): el mensaje dice qué hacer. */
export class TrackerProjectsError extends Error {}

export interface TrackerProjectsDeps {
  connections: Pick<Connections, "list">;
  /** El adapter de Linear para el workspace `account`. */
  linear: (account: string) => LinearTracker;
}

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
  resolve(tracker: TrackerId, ref: string): Promise<string>;
}

export function createTrackerProjects({ connections, linear }: TrackerProjectsDeps): TrackerProjects {
  function linearAccounts(): string[] {
    const accounts = connections.list().filter((c) => c.provider === "linear");
    if (accounts.length === 0) {
      throw new TrackerProjectsError("Linear no está conectado: conéctalo en Conexiones para elegir un proyecto.");
    }
    return accounts.map((c) => c.account);
  }

  return {
    async resolve(tracker, ref) {
      if (tracker !== "linear" || isLinearId(ref)) return ref;
      const accounts = linearAccounts();
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
}
