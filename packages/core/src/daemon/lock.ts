import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { connectToCore, isPidAlive } from "@clanker/api/node";

/** Cuánto espera a un core vivo que todavía no responde health (está arrancando) antes de rendirse. */
const BOOT_WAIT_MS = 10_000;
const POLL_MS = 50;
/**
 * Romper un lock viejo toma microsegundos: un `core.lock.break` más viejo que esto lo dejó un proceso
 * que murió a mitad, y se borra.
 */
const BREAK_GUARD_STALE_MS = 5_000;

export interface CoreLock {
  /** Borra `core.lock` si sigue siendo nuestro. */
  release(): void;
}

/**
 * Single instance. `core.lock` se crea con `open(…, "wx")` y guarda el pid del core.
 *
 * - `CoreLock`: el lock es nuestro.
 * - `"running"`: ya hay un core vivo y sano; quien llama debe salir con código 0.
 * - Si el pid del lock murió, el lock es viejo: se borra y se reintenta. Si vive pero no responde
 *   health (arrancando), espera hasta `BOOT_WAIT_MS`; pasado eso lanza, por si el pid lo reusó otro proceso.
 */
export async function acquireCoreLock(dataDir: string): Promise<CoreLock | "running"> {
  const lockPath = join(dataDir, "core.lock");
  const deadline = Date.now() + BOOT_WAIT_MS;

  for (;;) {
    if (createLock(lockPath)) return { release: () => releaseLock(lockPath) };

    const holder = readPid(lockPath);
    if (holder !== undefined) {
      if (!isPidAlive(holder)) {
        // Si otro lo está rompiendo, se espera como cualquier vuelta: sin `continue` no hay busy loop.
        if (breakStaleLock(lockPath, holder)) continue;
      } else {
        const core = await connectToCore(dataDir, "cli");
        if (core?.info.pid === holder) return "running";
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        holder === undefined
          ? `${lockPath} no tiene un pid válido. Bórralo si no hay un core corriendo.`
          : `${lockPath} lo tiene el pid ${holder}, que está vivo pero no responde health. ` +
              "Si no es un core de Clanker Yard, bórralo.",
      );
    }
    await sleep(POLL_MS);
  }
}

function createLock(lockPath: string): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, String(process.pid));
  } finally {
    closeSync(fd);
  }
  return true;
}

/** `undefined` si el archivo no existe o aún está vacío (su dueño lo acaba de crear). */
function readPid(lockPath: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const pid = Number.parseInt(text, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Borra un lock cuyo pid murió. Va detrás de `core.lock.break` para que dos cores que arrancan
 * juntos no borren, el segundo, el lock nuevo que acaba de crear el primero. `false` si otro lo
 * está rompiendo.
 */
function breakStaleLock(lockPath: string, deadPid: number): boolean {
  const guard = `${lockPath}.break`;
  try {
    closeSync(openSync(guard, "wx"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (Date.now() - modifiedAt(guard) > BREAK_GUARD_STALE_MS) rmSync(guard, { force: true });
    return false;
  }
  try {
    if (readPid(lockPath) === deadPid) rmSync(lockPath, { force: true });
  } finally {
    rmSync(guard, { force: true });
  }
  return true;
}

/** `Infinity` si ya no existe: quien lo tenía lo acaba de soltar. */
function modifiedAt(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Infinity;
    throw error;
  }
}

function releaseLock(lockPath: string): void {
  if (readPid(lockPath) === process.pid) rmSync(lockPath, { force: true });
}
