import { NodeId, type DefWriteKind } from "@clanker/api";

const DIR = { flow: "flows", role: "roles", profile: "profiles" } as const satisfies Record<DefWriteKind, string>;
const EXT = { flow: "json", role: "md", profile: "json" } as const satisfies Record<DefWriteKind, string>;

/** El archivo de `.clanker/` donde vive una def: `flows/<slug>.json`, `roles/<slug>.md`, `profiles/<slug>.json`. */
export const repoConfigPath = (kind: DefWriteKind, slug: string): string => `.clanker/${DIR[kind]}/${slug}.${EXT[kind]}`;

/** Las carpetas de `.clanker/` que el core lee. */
export const REPO_CONFIG_DIRS = Object.values(DIR).map((dir) => `.clanker/${dir}`);

/** El kind y el slug de un archivo de `.clanker/`, o `undefined` si la ruta no es de una def (ni con slug válido). */
export function parseRepoConfigPath(path: string): { kind: DefWriteKind; slug: string } | undefined {
  for (const kind of Object.keys(DIR) as DefWriteKind[]) {
    const prefix = `.clanker/${DIR[kind]}/`;
    const suffix = `.${EXT[kind]}`;
    if (!path.startsWith(prefix) || !path.endsWith(suffix)) continue;
    const slug = path.slice(prefix.length, path.length - suffix.length);
    return NodeId.safeParse(slug).success ? { kind, slug } : undefined;
  }
  return undefined;
}

/** El archivo no se puede leer como el kind que dice su ruta. */
export class RepoFileSyntaxError extends Error {}

/**
 * El contenido del archivo. Un flujo y un perfil son su body en JSON. Un rol es markdown: el `prompt` es el
 * texto y el resto del body (`context`, `tools`, `hooks`, `modes`) va arriba como JSON entre `---`, para
 * que el prompt se lea y se revise como texto en el PR.
 */
export function renderRepoFile(kind: DefWriteKind, body: unknown): string {
  if (kind !== "role") return `${JSON.stringify(body, null, 2)}\n`;
  const { prompt, ...rest } = body as { prompt: string };
  return `---\n${JSON.stringify(rest, null, 2)}\n---\n\n${prompt.trim()}\n`;
}

/** Lo inverso de `renderRepoFile`: el body sin validar. Lanza `RepoFileSyntaxError`. */
export function parseRepoFile(kind: DefWriteKind, text: string): unknown {
  if (kind !== "role") return parseJson(text);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) {
    throw new RepoFileSyntaxError("un rol empieza con un bloque JSON entre líneas `---` y sigue con su prompt en markdown");
  }
  const rest = parseJson(match[1]!);
  if (typeof rest !== "object" || rest === null || Array.isArray(rest)) throw new RepoFileSyntaxError("el bloque entre `---` debe ser un objeto JSON");
  return { ...rest, prompt: match[2]!.trim() };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new RepoFileSyntaxError(`no es JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
