import { execFileSync, type ChildProcess } from "node:child_process";
import { and, eq, ne } from "drizzle-orm";
import { procs, type PROC_KINDS } from "../store/schema";
import type { Store } from "../store/store";

export interface Procs {
  /**
   * Registra el grupo de procesos de `child` bajo el `boot_id` de este core hasta que termine. `child`
   * debe haberse lanzado con `detached: true`: así su `pid` es también su grupo y matarlo no toca al core.
   */
  track(child: ChildProcess, meta: { kind: (typeof PROC_KINDS)[number]; stepRunId?: string }): void;
  /**
   * Mata los grupos de procesos que dejó un core de otro `boot_id` (un crash) y borra sus filas.
   * Solo mata si el pid sigue vivo con la misma hora de inicio que se registró: un pid reusado por
   * otro programa se deja en paz. Devuelve cuántos grupos mató.
   */
  killOrphans(): number;
}

export interface ProcsOptions {
  store: Store;
  /** El `boot_id` de este core. */
  bootId: string;
}

export function createProcs({ store, bootId }: ProcsOptions): Procs {
  return {
    track(child, { kind, stepRunId }) {
      const { pid } = child;
      if (pid === undefined) return;
      const startedAt = startTimeOf(pid);
      // Sin hora de inicio el proceso ya murió (o no hay `ps`): no hay nada que vigilar.
      if (startedAt === undefined) return;
      store.tx((tx) => tx.db.insert(procs).values({ pid, pgid: pid, bootId, kind, stepRunId, startedAt }).run());
      child.once("close", () => {
        // Un callback de evento no lanza: la fila sobrante la limpia el próximo arranque.
        try {
          store.tx((tx) => tx.db.delete(procs).where(and(eq(procs.bootId, bootId), eq(procs.pid, pid))).run());
        } catch (error) {
          console.error(`No se pudo borrar el proceso ${pid} de procs:`, error);
        }
      });
    },

    killOrphans() {
      const orphans = store.db.select().from(procs).where(ne(procs.bootId, bootId)).all();
      let killed = 0;
      for (const { pid, pgid, startedAt } of orphans) {
        if (startTimeOf(pid) !== startedAt) continue;
        try {
          process.kill(-pgid, "SIGKILL");
          killed++;
        } catch {
          // El grupo terminó entre medio.
        }
      }
      store.tx((tx) => tx.db.delete(procs).where(ne(procs.bootId, bootId)).run());
      return killed;
    },
  };
}

/** La hora de inicio de `pid` según el SO (resolución de 1 s), o `undefined` si no existe. */
function startTimeOf(pid: number): number | undefined {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const time = Date.parse(out);
    return Number.isNaN(time) ? undefined : time;
  } catch {
    // `ps -p` sale con 1 si el pid no existe.
    return undefined;
  }
}
