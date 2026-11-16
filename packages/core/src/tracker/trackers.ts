import type { ClankerProject } from "@clanker/api";
import type { Connections } from "../connections/connections";
import type { Tracker } from "./tracker";

/** El proyecto no sabe de qué cuenta del tracker sacar su cola y no hay una sola para adivinar: el mensaje dice qué hacer. */
export class TrackerAccountError extends Error {}

/**
 * El adapter con que se trabaja un proyecto: el de su tracker y, en Linear, el de su cuenta (workspace).
 * `undefined` si el core no tiene adapter de ese tracker. Lanza `TrackerAccountError`.
 */
export type Trackers = (project: Pick<ClankerProject, "slug" | "tracker" | "trackerAccount">) => Tracker | undefined;

/** Un `Trackers` con un adapter por tipo de tracker, sin cuentas (lo que usan los trackers que no las tienen y los tests). */
export const trackersByKind =
  (byKind: Readonly<Record<string, Tracker>>): Trackers =>
  (project) =>
    byKind[project.tracker];

export interface TrackersDeps {
  local: Tracker;
  connections: Pick<Connections, "list">;
  /** El adapter de Linear para el workspace `account`; se crea una vez por cuenta. */
  linear: (account: string) => Tracker;
}

export function createTrackers({ local, connections, linear: linearFor }: TrackersDeps): Trackers {
  const linear = new Map<string, Tracker>();

  /** La cuenta del proyecto; si aún no la fijó, la única cuenta de Linear conectada. */
  function linearAccount(project: Pick<ClankerProject, "slug" | "trackerAccount">): string {
    if (project.trackerAccount !== null) return project.trackerAccount;
    const accounts = connections.list().filter((c) => c.provider === "linear").map((c) => c.account);
    if (accounts.length === 1) return accounts[0]!;
    throw new TrackerAccountError(
      accounts.length === 0
        ? `El proyecto ${project.slug} es de Linear y no hay una cuenta de Linear conectada: conéctala en Conexiones.`
        : `El proyecto ${project.slug} no tiene fijada su cuenta de Linear y hay varias conectadas (${accounts.join(", ")}): elige su proyecto de nuevo en Ajustes para fijarla.`,
    );
  }

  return (project) => {
    if (project.tracker === "local") return local;
    if (project.tracker !== "linear") return undefined;
    const account = linearAccount(project);
    let tracker = linear.get(account);
    if (!tracker) {
      tracker = linearFor(account);
      linear.set(account, tracker);
    }
    return tracker;
  };
}
