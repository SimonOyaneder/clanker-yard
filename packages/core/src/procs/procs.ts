import { execFileSync, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq, ne } from "drizzle-orm";
import { procs, type PROC_KINDS } from "../store/schema";
import type { Store } from "../store/store";

/** Cuánto espera `stop` tras SIGKILL a que el SO entregue el cierre de lo que mató. */
const KILLED_WAIT_MS = 2_000;

export interface Procs {
  /** El `boot_id` de este core: el que llevan sus filas. */
  readonly bootId: string;
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
  /**
   * El apagado del core: SIGTERM al grupo de cada proceso que este core tiene vivo y SIGKILL a los que
   * sigan vivos pasados `killAfterMs`. Resuelve cuando todos cerraron. Solo toca grupos que este core
   * lanzó y cuyo pid sigue con la hora de inicio registrada.
   */
  stop(killAfterMs: number): Promise<void>;
}

export interface ProcsOptions {
  store: Store;
  /** El `boot_id` de este core. */
  bootId: string;
}

interface Live {
  pid: number;
  startedAt: number;
  closed: Promise<void>;
}

/**
 * Manda `signal` al grupo de `pid` solo si el pid sigue siendo el proceso que se registró (misma hora de
 * inicio): un pid reusado por otro programa no se toca. `false` si no lo mandó.
 */
function signalGroup({ pid, pgid = pid, startedAt }: { pid: number; pgid?: number; startedAt: number }, signal: NodeJS.Signals): boolean {
  if (startTimeOf(pid) !== startedAt) return false;
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    // El grupo terminó entre medio.
    return false;
  }
}

export function createProcs({ store, bootId }: ProcsOptions): Procs {
  const live = new Map<number, Live>();

  return {
    bootId,

    track(child, { kind, stepRunId }) {
      const { pid } = child;
      if (pid === undefined) return;
      const startedAt = startTimeOf(pid);
      // Sin hora de inicio el proceso ya murió (o no hay `ps`): no hay nada que vigilar.
      if (startedAt === undefined) return;
      store.tx((tx) => tx.db.insert(procs).values({ pid, pgid: pid, bootId, kind, stepRunId, startedAt }).run());
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      live.set(pid, { pid, startedAt, closed });
      child.once("close", () => {
        live.delete(pid);
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
      for (const orphan of orphans) if (signalGroup(orphan, "SIGKILL")) killed++;
      store.tx((tx) => tx.db.delete(procs).where(ne(procs.bootId, bootId)).run());
      return killed;
    },

    async stop(killAfterMs) {
      const running = [...live.values()];
      for (const proc of running) signalGroup(proc, "SIGTERM");
      const allClosed = Promise.all(running.map((proc) => proc.closed));
      await Promise.race([allClosed, delay(killAfterMs, undefined, { ref: false })]);
      const stubborn = running.filter((proc) => live.has(proc.pid));
      for (const proc of stubborn) signalGroup(proc, "SIGKILL");
      await Promise.race([allClosed, delay(KILLED_WAIT_MS, undefined, { ref: false })]);
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
