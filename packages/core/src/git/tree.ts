import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitRaw } from "./git";

/**
 * El árbol del worktree tal como está (commits, cambios y archivos nuevos), sin tocar su index real:
 * se parte de un index temporal con `HEAD` y se hace `add --all`. No se copia el index real: sin los
 * datos de stat git rehashea todo, pero un cambio del mismo tamaño dentro del mismo segundo del
 * checkout (el mtime de git en macOS es de un segundo) no se le puede escapar.
 */
export async function snapshotTree(cwd: string): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), "clanker-index-"));
  try {
    const env = { GIT_INDEX_FILE: join(tmp, "index") };
    await git(cwd, ["read-tree", "HEAD"], env);
    await git(cwd, ["add", "--all"], env);
    return await git(cwd, ["write-tree"], env);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Con prefijos `a/` `b/` fijos y sin renames: el patch no depende de la config de git de quien lo corra. */
export async function diffBetween(cwd: string, from: string, to: string): Promise<string> {
  return gitRaw(cwd, [
    "-c",
    "core.quotePath=false",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-renames",
    "--binary",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    from,
    to,
  ]);
}

/**
 * Un hunk del diff: `h12 app/models/x.rb @@ -10,6 +10,9 @@`. Un cambio de archivo que git no parte en
 * hunks (binario, archivo vacío nuevo o borrado, cambio de modo) es un solo hunk con una `header`
 * entre paréntesis: así el committer puede asignarlo a un commit como a cualquier otro.
 */
export interface Hunk {
  id: string;
  path: string;
  header: string;
  /** Lo que antecede al primer hunk del archivo (`diff --git`, modos, `---`, `+++`); en un cambio sin hunks, todo el cambio. */
  fileHeader: string;
  /** Las líneas del hunk, con su `@@`; vacío en un cambio sin hunks. */
  body: string;
}

/**
 * Un id por hunk, en el orden del patch: `h1`, `h2`... El mismo diff da siempre los mismos ids.
 * `fileHeader` más los `body` de varios hunks del mismo archivo (en orden) es un patch que `git apply` acepta.
 */
export function listHunks(diff: string): Hunk[] {
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const hunks: Hunk[] = [];
  const starts = lines.flatMap((line, i) => (line.startsWith("diff --git ") ? [i] : []));
  starts.forEach((start, n) => {
    const section = lines.slice(start, starts[n + 1] ?? lines.length);
    const firstHunk = section.findIndex((line) => line.startsWith("@@"));
    const fileHeader = `${section.slice(0, firstHunk === -1 ? undefined : firstHunk).join("\n")}\n`;
    const path = sectionPath(section);
    if (path === undefined) return;
    if (firstHunk === -1) {
      hunks.push({ id: `h${hunks.length + 1}`, path, header: unsplittableHeader(section), fileHeader, body: "" });
      return;
    }
    const bounds = section.flatMap((line, i) => (i >= firstHunk && line.startsWith("@@") ? [i] : []));
    bounds.forEach((from, k) => {
      const header = /^(@@ -\S+ \+\S+ @@)/.exec(section[from]!);
      if (!header) return;
      const body = `${section.slice(from, bounds[k + 1] ?? section.length).join("\n")}\n`;
      hunks.push({ id: `h${hunks.length + 1}`, path, header: header[1]!, fileHeader, body });
    });
  });
  return hunks;
}

/** El archivo de una sección del diff; para uno sin `---` y `+++` (binario, vacío), el de su línea `diff --git`. */
function sectionPath(section: string[]): string | undefined {
  let oldPath: string | undefined;
  let path: string | undefined;
  for (const line of section) {
    if (line.startsWith("@@")) break;
    if (line.startsWith("--- ")) oldPath = stripPrefix(line.slice(4), "a/");
    else if (line.startsWith("+++ ")) path = stripPrefix(line.slice(4), "b/") ?? oldPath;
  }
  return path ?? diffGitPath(section[0]!);
}

/** `diff --git a/x b/x` → `x`. Sin renames los dos nombres son iguales; un nombre entrecomillado (con `"` o `\`) no se lee. */
function diffGitPath(line: string): string | undefined {
  const names = line.slice("diff --git ".length);
  const length = (names.length - "a/ b/".length) / 2;
  if (!Number.isInteger(length) || !names.startsWith("a/")) return undefined;
  const path = names.slice(2, 2 + length);
  return names === `a/${path} b/${path}` ? path : undefined;
}

function unsplittableHeader(section: string[]): string {
  if (section.some((line) => line.startsWith("GIT binary patch") || line.startsWith("Binary files"))) return "(binario)";
  if (section.some((line) => line.startsWith("new file mode"))) return "(archivo vacío nuevo)";
  if (section.some((line) => line.startsWith("deleted file mode"))) return "(archivo vacío borrado)";
  return "(cambio de modo)";
}

/**
 * `undefined` si el nombre no lleva el prefijo: es el "no existe" de un archivo creado o borrado. Git
 * agrega un tab tras los nombres con espacios.
 */
function stripPrefix(name: string, prefix: string): string | undefined {
  const clean = name.replace(/\t.*$/, "");
  return clean.startsWith(prefix) ? clean.slice(prefix.length) : undefined;
}
