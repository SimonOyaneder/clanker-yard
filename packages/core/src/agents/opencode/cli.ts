import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * La versión más vieja probada: la API de opencode 2 (`/api/...`, eventos `session.execution.*`) y los plugins de
 * servidor con herramientas. opencode 1 tiene otra API y no sirve.
 */
export const MIN_OPENCODE_VERSION = "2.3.0";

const CLI_TIMEOUT_MS = 20_000;

/** Corre `opencode <args>` con el entorno del agente y devuelve su stdout. Lanza con un mensaje accionable si no está. */
export type OpencodeCli = (args: string[]) => Promise<string>;

export function createOpencodeCli(executable: string, env: Record<string, string>): OpencodeCli {
  return async (args) => {
    try {
      const { stdout } = await run(executable, args, { env, timeout: CLI_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
      return stdout;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`No encuentro "${executable}" en el PATH del core: instala opencode (https://opencode.ai).`, { cause: error });
      }
      throw error;
    }
  };
}

/** `1.18.31` → `[1, 18, 31]`; lo que no es una versión, `undefined`. */
function parts(version: string): number[] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? match.slice(1).map(Number) : undefined;
}

/** `undefined` si la versión sirve, o qué hacer. */
export function versionProblem(output: string): string | undefined {
  const found = parts(output);
  if (!found) return `opencode --version respondió "${output.trim()}" y no sé qué versión es.`;
  const min = parts(MIN_OPENCODE_VERSION)!;
  for (let i = 0; i < 3; i++) {
    if (found[i]! > min[i]!) return undefined;
    if (found[i]! < min[i]!) return `opencode ${found.join(".")} es muy viejo: el core necesita ${MIN_OPENCODE_VERSION} o más nuevo (opencode upgrade, o el instalador de https://opencode.ai si es opencode 1).`;
  }
  return undefined;
}

/** Los modelos de `opencode models`: uno `proveedor/modelo` por línea, sin el logo ni líneas en blanco. */
export function parseModels(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[\w.-]+\/\S+$/.test(line));
}
