import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
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
