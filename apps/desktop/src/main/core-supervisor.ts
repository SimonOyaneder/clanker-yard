import { existsSync } from "node:fs";
import path from "node:path";
import { connectToCore, ensureCore, type CoreConnection } from "@clanker/api/node";

export type CoreState =
  | { status: "starting" }
  | { status: "live"; version: string; port: number; token: string; bootId: string }
  | { status: "down"; reason: string };

export interface CoreSupervisorOptions {
  dataDir: string;
  logDir: string;
  /** `core/main.js` empaquetado. */
  entry: string;
  /** Cada cuánto comprueba que el core sigue vivo, por defecto 2 s. */
  pollMs?: number;
}

export interface CoreSupervisor {
  state(): CoreState;
  /** Cada cambio de estado; no repite un `live` con el mismo core. */
  onChange(cb: (state: CoreState) => void): () => void;
  /** Conecta con el core o lo lanza. Nunca lanza: si falla deja el estado en `down` con el motivo. */
  start(): Promise<void>;
  /** Pide `system.shutdown({ drain: true })` al core vivo (el menú "Salir y detener agentes"). */
  shutdownCore(): Promise<void>;
  /** Deja de vigilar. No toca el core: cerrar la app no lo detiene. */
  close(): void;
}

/**
 * Lanza el core si no está y lo vigila. No lo relanza solo: si cae pasa a `down` y espera
 * `start()` (el botón Reintentar). Si vuelve por su cuenta, por ejemplo porque la CLI lo
 * levantó, pasa a `live` sin hacer nada.
 */
export function createCoreSupervisor(opts: CoreSupervisorOptions): CoreSupervisor {
  let state: CoreState = { status: "starting" };
  let connection: CoreConnection | undefined;
  let launching = false;
  let checking = false;
  const listeners = new Set<(state: CoreState) => void>();

  function setState(next: CoreState): void {
    const same =
      next.status === state.status &&
      (next.status !== "live" || (state.status === "live" && state.bootId === next.bootId)) &&
      (next.status !== "down" || (state.status === "down" && state.reason === next.reason));
    if (same) return;
    state = next;
    for (const cb of listeners) cb(state);
  }

  function live(core: CoreConnection): void {
    connection = core;
    setState({ status: "live", version: core.health.coreVersion, port: core.info.port, token: core.info.token, bootId: core.info.bootId });
  }

  async function start(): Promise<void> {
    if (launching) return;
    launching = true;
    connection = undefined;
    setState({ status: "starting" });
    try {
      if (!existsSync(opts.entry)) {
        throw new Error(`No existe ${opts.entry}. Corre npm run build -w @clanker/core.`);
      }
      live(await ensureCore({ dataDir: opts.dataDir, logDir: opts.logDir, entry: opts.entry, origin: "ui" }));
    } catch (error) {
      setState({ status: "down", reason: error instanceof Error ? error.message : String(error) });
    } finally {
      launching = false;
    }
  }

  async function check(): Promise<void> {
    if (launching || checking) return;
    checking = true;
    try {
      const core = await connectToCore(opts.dataDir, "ui");
      if (launching) return;
      if (core) live(core);
      else if (state.status === "live") {
        connection = undefined;
        setState({
          status: "down",
          reason: `El core dejó de responder. Mira ${path.join(opts.logDir, "core.log")}.`,
        });
      }
    } catch (error) {
      // `core.json` ilegible: no hay core sano que mostrar.
      setState({ status: "down", reason: error instanceof Error ? error.message : String(error) });
    } finally {
      checking = false;
    }
  }

  const timer = setInterval(() => void check(), opts.pollMs ?? 2_000);
  timer.unref();

  return {
    state: () => state,
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    start,
    async shutdownCore() {
      await connection?.client.system.shutdown({ drain: true });
    },
    close: () => clearInterval(timer),
  };
}
