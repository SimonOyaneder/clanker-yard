import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";

export const MAX_LOG_BYTES = 10 * 1024 * 1024;
/** Archivos que se conservan contando el activo: `core.log`, `core.log.1` … `core.log.4`. */
export const LOG_FILES = 5;

export interface CoreLogger {
  /** Una línea JSON `{ts, level, msg}`. */
  write(level: "info" | "warn" | "error", message: string): void;
}

/** `core.log` en JSONL con rotación por tamaño. */
export function openCoreLog(
  dir: string,
  { maxBytes = MAX_LOG_BYTES, files = LOG_FILES } = {},
): CoreLogger {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "core.log");
  let size = sizeOf(file);

  function rotate(): void {
    rmSync(`${file}.${files - 1}`, { force: true });
    for (let i = files - 2; i >= 1; i--) renameIfExists(`${file}.${i}`, `${file}.${i + 1}`);
    renameIfExists(file, `${file}.1`);
    size = 0;
  }

  return {
    write(level, message) {
      const line = `${JSON.stringify({ ts: new Date().toISOString(), level, msg: message })}\n`;
      const bytes = Buffer.byteLength(line);
      if (size > 0 && size + bytes > maxBytes) rotate();
      appendFileSync(file, line);
      size += bytes;
    },
  };
}

/** Manda `console.*` del core a `core.log`: el stdio del core va a `ignore` cuando lo lanza la app. */
export function routeConsoleTo(logger: CoreLogger): void {
  console.log = (...args) => logger.write("info", format(...args));
  console.info = console.log;
  console.warn = (...args) => logger.write("warn", format(...args));
  console.error = (...args) => logger.write("error", format(...args));
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function renameIfExists(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
