import { spawn } from "node:child_process";
import { closeSync, fstatSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** Lo único que un comando de receta hereda del entorno del core: ni `GH_TOKEN` ni `LINEAR_*` ni credenciales de nadie. */
const INHERITED_ENV = ["PATH", "HOME", "USER", "LANG", "TMPDIR", "SHELL"] as const;

/** Un extracto que se le da a un agente: las últimas líneas, donde los runners ponen el resumen de fallas. */
export const EXCERPT_MAX_LINES = 60;
const EXCERPT_MAX_LINE_CHARS = 500;
/** Cuánto de la cola de la salida se lee para armar el extracto, por mucho que haya salido. */
const TAIL_READ_BYTES = 128 * 1024;

export interface ExecRequest {
  cwd: string;
  command: string;
  /** Se suma a la lista blanca del entorno heredado. */
  env: Record<string, string>;
  /** La salida completa se agrega aquí, bajo un encabezado con el comando y un pie con la salida. */
  logPath: string;
  signal: AbortSignal;
}

export interface ExecResult {
  exitCode: number;
  /** Las últimas `EXCERPT_MAX_LINES` líneas de la salida de este comando, sin colores. */
  extract: string;
}

/**
 * Corre `command` con `sh -c` en `cwd`, con stdout y stderr entrelazados en el log (nada de la salida
 * se guarda en memoria). Un `signal` abortado mata el grupo de procesos del comando y lanza su razón.
 */
export async function execLogged({ cwd, command, env, logPath, signal }: ExecRequest): Promise<ExecResult> {
  signal.throwIfAborted();
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, "a+");
  try {
    writeSync(fd, `$ ${command}\n`);
    const outputStart = fstatSync(fd).size;
    const { code, killedBy } = await run(command, cwd, { ...inheritedEnv(), ...env }, fd, signal);
    const outputEnd = fstatSync(fd).size;
    const extract = excerpt(...readTail(fd, outputStart, outputEnd));
    writeSync(fd, `${killedBy ? `[terminó por ${killedBy}]` : `[exit ${code}]`}\n\n`);
    signal.throwIfAborted();
    return { exitCode: code ?? 1, extract };
  } finally {
    closeSync(fd);
  }
}

function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function run(
  command: string,
  cwd: string,
  env: Record<string, string>,
  fd: number,
  signal: AbortSignal,
): Promise<{ code: number | null; killedBy: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    // `detached` da su propio grupo de procesos: matar solo el `sh` dejaría vivos a sus hijos.
    const child = spawn("sh", ["-c", command], { cwd, env, stdio: ["ignore", fd, fd], detached: true });
    const abort = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // El grupo ya terminó.
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      signal.removeEventListener("abort", abort);
      reject(new Error(`No se pudo lanzar "${command}" en ${cwd}: ${error.message}`, { cause: error }));
    });
    child.once("close", (code, killedBy) => {
      signal.removeEventListener("abort", abort);
      resolve({ code, killedBy });
    });
  });
}

function readTail(fd: number, start: number, end: number): [text: string, cut: boolean] {
  const from = Math.max(start, end - TAIL_READ_BYTES);
  const buffer = Buffer.alloc(end - from);
  readSync(fd, buffer, 0, buffer.length, from);
  return [buffer.toString("utf8"), from > start];
}

/**
 * Las últimas `EXCERPT_MAX_LINES` líneas de `text`, sin secuencias de color y con cada línea
 * recortada. Si `text` es la cola de algo más largo (`cut`), su primera línea puede estar a medias y se descarta.
 */
export function excerpt(text: string, cut = false): string {
  // Los colores ANSI (`ESC [ ... letra`).
  const lines = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (cut) lines.shift();
  return lines
    .slice(-EXCERPT_MAX_LINES)
    .map((line) => (line.length > EXCERPT_MAX_LINE_CHARS ? `${line.slice(0, EXCERPT_MAX_LINE_CHARS)}…` : line))
    .join("\n");
}
