// Subpath `@clanker/api/node`: paths por SO, `core.json` y `ensureCore` (`docs/design.html#d-data`).
// Solo Node; la UI no lo importa.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as z from "zod";
import { createClient, type Client } from "./client";
import { API_MAJOR } from "./contract";
import type { ClientOrigin } from "./domain";

export interface ClankerDirs {
  /** `clanker.db`, `core.json`, `core.lock`, `artifacts/`, `transcripts/`, `backups/`, `worktrees/`. */
  dataDir: string;
  /** `core.log`. */
  logDir: string;
}

export interface ClankerDirsOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/**
 * Dónde vive todo en cada SO. `CLANKER_HOME` pisa todo (tests y fixtures): datos en esa carpeta y
 * logs en `<CLANKER_HOME>/logs`.
 */
export function clankerDirs(opts: ClankerDirsOptions = {}): ClankerDirs {
  const { platform = process.platform, env = process.env, home = homedir() } = opts;
  const p = platform === "win32" ? path.win32 : path.posix;

  if (env.CLANKER_HOME) return { dataDir: env.CLANKER_HOME, logDir: p.join(env.CLANKER_HOME, "logs") };

  switch (platform) {
    case "darwin":
      return {
        dataDir: p.join(home, "Library", "Application Support", "Clanker Yard"),
        logDir: p.join(home, "Library", "Logs", "Clanker Yard"),
      };
    case "win32":
      return {
        dataDir: p.join(env.APPDATA ?? p.join(home, "AppData", "Roaming"), "Clanker Yard"),
        logDir: p.join(env.LOCALAPPDATA ?? p.join(home, "AppData", "Local"), "Clanker Yard"),
      };
    default:
      return {
        dataDir: p.join(env.XDG_DATA_HOME || p.join(home, ".local", "share"), "clanker-yard"),
        logDir: p.join(env.XDG_STATE_HOME || p.join(home, ".local", "state"), "clanker-yard"),
      };
  }
}

/** Lo que el core publica en `core.json` cuando ya escucha: cómo llegar a él. */
export const CoreJson = z.object({
  pid: z.int().positive(),
  port: z.int().positive(),
  /** Va en `Authorization: Bearer`. */
  token: z.string(),
  version: z.string(),
  apiMajor: z.int().nonnegative(),
  bootId: z.string(),
});
export type CoreJson = z.infer<typeof CoreJson>;

export const coreJsonPath = (dataDir: string) => path.join(dataDir, "core.json");

/** `core.json` es de un solo usuario: tiene el token de la API. La escritura es atómica. */
export function writeCoreJson(dataDir: string, info: CoreJson): void {
  const file = coreJsonPath(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

export function removeCoreJson(dataDir: string): void {
  rmSync(coreJsonPath(dataDir), { force: true });
}

/** `undefined` si no hay `core.json`; lanza si existe pero no tiene la forma esperada. */
export function readCoreJson(dataDir: string): CoreJson | undefined {
  let text: string;
  try {
    text = readFileSync(coreJsonPath(dataDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = CoreJson.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(
      `${coreJsonPath(dataDir)} no tiene la forma esperada (${z.prettifyError(parsed.error)}). Bórralo si no hay un core corriendo.`,
    );
  }
  return parsed.data;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: el proceso existe pero es de otro usuario.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const HEALTH_TIMEOUT_MS = 2_000;

export interface CoreConnection {
  info: CoreJson;
  client: Client;
  /** Lo que respondió `system.health` en esta conexión. */
  health: CoreHealth;
}

type CoreHealth = Awaited<ReturnType<Client["system"]["health"]>>;

/**
 * Se conecta al core que describe `core.json` si su pid vive y `system.health` responde con el
 * mismo `bootId`. `undefined` si no hay core sano.
 */
export async function connectToCore(
  dataDir: string,
  origin: ClientOrigin,
): Promise<CoreConnection | undefined> {
  const info = readCoreJson(dataDir);
  if (!info || !isPidAlive(info.pid)) return undefined;
  const client = createClient({
    url: `http://127.0.0.1:${info.port}/rpc`,
    token: info.token,
    origin,
  });
  try {
    const health = await client.system.health(undefined, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return health.bootId === info.bootId ? { info, client, health } : undefined;
  } catch {
    // Sin respuesta: el core murió, está arrancando o el puerto lo tomó otro proceso.
    return undefined;
  }
}

export interface EnsureCoreOptions {
  /** Carpeta de datos; la app siempre la pasa, el core no adivina. Ver `clankerDirs`. */
  dataDir: string;
  /** Carpeta de `core.log`. Sin ella el core usa la de `clankerDirs()`. */
  logDir?: string;
  /** `core/main.js` empaquetado: lo lanza `process.execPath` con `ELECTRON_RUN_AS_NODE=1`. */
  entry: string;
  origin: ClientOrigin;
  /** El `apiMajor` de quien llama; un core con otro se reemplaza. Por defecto el `API_MAJOR` de este paquete. */
  apiMajor?: number;
  /** Cuánto esperar a un core nuevo, por defecto 15 s. */
  timeoutMs?: number;
  /** Cuánto esperar a que un core con otro `apiMajor` termine de apagarse (drain), por defecto 70 s. */
  shutdownTimeoutMs?: number;
}

const START_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 70_000;
const POLL_MS = 50;

/**
 * Devuelve la conexión a un core sano de este `apiMajor`, lanzándolo si hace falta. Si el que corre
 * tiene otro `apiMajor` (pasa al actualizar la app) le pide `system.shutdown({ drain: true })` y
 * lanza el nuevo. Varias llamadas concurrentes terminan con un solo core: los sobrantes salen solos
 * al ver `core.lock` (ver `packages/core/src/process/lock.ts`).
 */
export async function ensureCore(opts: EnsureCoreOptions): Promise<CoreConnection> {
  const { dataDir, origin } = opts;
  const running = await connectToCore(dataDir, origin);
  const apiMajor = opts.apiMajor ?? API_MAJOR;
  if (running?.health.apiMajor === apiMajor) return running;

  if (running) {
    await running.client.system.shutdown({ drain: true });
    await waitUntil(
      () => !isPidAlive(running.info.pid),
      opts.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS,
      `El core ${running.info.pid} (apiMajor ${running.health.apiMajor}) no terminó de apagarse`,
    );
  }
  return launchCore(opts, running?.info.bootId);
}

async function launchCore(opts: EnsureCoreOptions, previousBootId?: string): Promise<CoreConnection> {
  const { dataDir, origin } = opts;
  mkdirSync(dataDir, { recursive: true });
  const args = [opts.entry, "--data-dir", dataDir];
  if (opts.logDir) args.push("--log-dir", opts.logDir);

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  let launchError: Error | undefined;
  child.once("error", (error) => (launchError = error));
  child.once("exit", (code) => {
    // Código 0: ya había otro core (o lo estaba levantando una llamada concurrente) y este salió.
    if (code !== 0) launchError = new Error(`el core salió con código ${code}`);
  });
  child.unref();

  const timeoutMs = opts.timeoutMs ?? START_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (launchError) throw coreStartError(opts, launchError.message);
    const core = await connectToCore(dataDir, origin);
    if (core && core.info.bootId !== previousBootId) return core;
    await sleep(POLL_MS);
  }
  throw coreStartError(opts, `no respondió health en ${timeoutMs} ms`);
}

function coreStartError(opts: EnsureCoreOptions, reason: string): Error {
  const logDir = opts.logDir ?? clankerDirs().logDir;
  return new Error(
    `No se pudo arrancar el core (${reason}). Mira ${path.join(logDir, "core.log")}.`,
  );
}

async function waitUntil(done: () => boolean, timeoutMs: number, failure: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() >= deadline) throw new Error(`${failure} en ${timeoutMs} ms.`);
    await sleep(POLL_MS);
  }
}
