import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunSpec } from "./runtime";

/**
 * Lo que comparten los runtimes que lanzan procesos (`docs/design.html#d-agents`, "Libertad de los agentes y
 * credenciales"): el agente corre con un `GH_CONFIG_DIR` vacío y un git config global generado por el core, así un
 * `git push` o un `gh pr comment` suyo falla por falta de auth.
 */

/**
 * El `GIT_CONFIG_GLOBAL` del agente: la identidad del usuario en el repo y ningún credential helper. Un archivo por
 * identidad (y no uno compartido) porque runs de repos distintos corren a la vez. Sin identidad no hay `[user]`.
 */
export async function writeGitConfig(dir: string, identity: RunSpec["gitIdentity"]): Promise<string> {
  const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  const user = identity ? `[user]\n\tname = ${quote(identity.name)}\n\temail = ${quote(identity.email)}\n` : "";
  const content = `${user}[credential]\n\thelper =\n`;
  const file = join(dir, createHash("sha256").update(content).digest("hex").slice(0, 16));
  await writeFile(file, content);
  return file;
}

/** Lo que `resume` necesita y `ResumeSpec` no trae (modelo, prompt del rol, herramientas): se guarda al iniciar. */
interface StoredSession {
  spec: RunSpec;
}

/**
 * Las sesiones que inició un runtime, en `<dir>/<sessionId>.json`, para retomarlas aunque el core se haya reiniciado.
 * Sin el contexto: cada lanzamiento lo vuelve a leer del original.
 */
export function createSessionStore(dir: string, runtimeId: string) {
  const fileOf = (sessionId: string) => join(dir, `${sessionId}.json`);
  return {
    async save(sessionId: string, spec: RunSpec): Promise<void> {
      const stored: StoredSession = { spec: { ...spec, native: undefined, references: [], stepRunId: undefined } };
      await writeFile(fileOf(sessionId), JSON.stringify(stored));
    },
    /** La spec con que se inició la sesión. Lanza si este runtime no la inició. */
    async load(sessionId: string): Promise<RunSpec> {
      const file = fileOf(sessionId);
      try {
        return (JSON.parse(await readFile(file, "utf8")) as StoredSession).spec;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        throw new Error(`No hay registro de la sesión ${sessionId} en ${file}: el runtime ${runtimeId} solo retoma las sesiones que él inició.`);
      }
    },
  };
}

/**
 * La preparación de las carpetas de un runtime, una sola vez por proceso: la carpeta de `gh` siempre vacía (lo que un
 * agente haya dejado en una corrida anterior no cuenta como login) y las demás creadas, más lo propio del runtime
 * (`extra`). Si falla, el próximo run lo vuelve a intentar.
 */
export function agentDirsPreparer({ ghConfigDir, dirs, extra }: { ghConfigDir: string; dirs: string[]; extra?: () => Promise<void> }) {
  let prepared: Promise<void> | undefined;
  return (): Promise<void> => {
    prepared ??= (async () => {
      await rm(ghConfigDir, { recursive: true, force: true });
      for (const dir of [ghConfigDir, ...dirs]) await mkdir(dir, { recursive: true });
      await extra?.();
    })().catch((error: unknown) => {
      prepared = undefined;
      throw error;
    });
    return prepared;
  };
}
