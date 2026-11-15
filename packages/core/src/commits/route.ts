import type { Hunk } from "../git/tree";
import type { Workspaces, WorkspaceRef } from "../workspaces/workspaces";

export const FIXUP_PREFIX = "fixup! ";

/** Un commit de la branch (entre su merge-base con la base y `HEAD`). */
export interface BranchCommit {
  sha: string;
  subject: string;
}

/** Los commits de la branch, del más viejo al más nuevo. */
export async function branchCommits(workspaces: Workspaces, ws: WorkspaceRef, base: string): Promise<BranchCommit[]> {
  const mergeBase = await workspaces.git(ws, "merge-base", "HEAD", base);
  const log = await workspaces.git(ws, "log", "--reverse", "--format=%H%x00%s", `${mergeBase}..HEAD`);
  return log
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [sha = "", subject = ""] = line.split("\x00");
      return { sha, subject };
    });
}

export interface HunkRoutes {
  /** Los hunks con commit destino: el commit original (nunca un `fixup!`) y sus hunks, del destino más viejo al más nuevo. */
  fixups: { target: BranchCommit; hunks: Hunk[] }[];
  /** Los que no tocan líneas de ningún commit de la branch: los decide el committer en modo route. */
  unrouted: Hunk[];
}

/**
 * El destino de cada hunk sale de `git blame` sobre `HEAD`: las líneas que el hunk quita o cambia son
 * de algún commit, y el hunk va a un `fixup!` de ese. Un hunk que toca líneas de varios commits va al
 * más nuevo: el autosquash pone el `fixup!` justo después de su destino, y ahí las líneas de un commit
 * posterior todavía no existen. Por lo mismo, si un commit posterior al destino es dueño de una línea
 * pegada a un cambio del hunk, el rebase choca: ese hunk también queda sin destino. Sin destino: además,
 * un hunk que solo agrega líneas, que cambia líneas de la base o que no se parte en líneas (binario,
 * modo, archivo vacío).
 *
 * Un `fixup!` que ya está en la branch (un PR con council nunca los squashea) cuenta como su commit
 * original, que es el destino de un `fixup!` nuevo.
 */
export async function routeHunks(
  workspaces: Workspaces,
  ws: WorkspaceRef,
  hunks: Hunk[],
  commits: BranchCommit[],
): Promise<HunkRoutes> {
  const owners = new Map<string, Map<number, string>>();
  const blame = async (path: string) => {
    if (!owners.has(path)) owners.set(path, await blameLines(workspaces, ws, path));
    return owners.get(path)!;
  };

  const bySha = new Map<string, Hunk[]>();
  const unrouted: Hunk[] = [];
  for (const hunk of hunks) {
    const { removed, adjacent } = touchedLines(hunk);
    let target: number | undefined;
    if (removed.length > 0) {
      const fileOwners = await blame(hunk.path);
      const newest = (lines: number[]) =>
        Math.max(-1, ...lines.map((line) => originalIndex(commits, fileOwners.get(line)) ?? -1));
      target = newest(removed);
      if (target === -1 || newest(adjacent) > target) target = undefined;
    }
    if (target === undefined) unrouted.push(hunk);
    else bySha.set(commits[target]!.sha, [...(bySha.get(commits[target]!.sha) ?? []), hunk]);
  }
  const fixups = commits.filter((c) => bySha.has(c.sha)).map((target) => ({ target, hunks: bySha.get(target.sha)! }));
  return { fixups, unrouted };
}

/**
 * El mensaje de un `fixup!` de `target`: su subject, que es lo que `rebase --autosquash` busca. Si otro
 * commit de la branch tiene el mismo subject, el sha completo, que autosquash también acepta.
 */
export function fixupMessage(target: BranchCommit, commits: BranchCommit[]): string {
  const sameSubject = commits.filter((c) => c.subject === target.subject);
  return `${FIXUP_PREFIX}${sameSubject.length > 1 ? target.sha : target.subject}`;
}

/** La posición en `commits` del commit original de `sha`; `undefined` si no es de la branch. */
function originalIndex(commits: BranchCommit[], sha: string | undefined): number | undefined {
  const index = commits.findIndex((c) => c.sha === sha);
  if (index === -1) return undefined;
  let subject = commits[index]!.subject;
  if (!subject.startsWith(FIXUP_PREFIX)) return index;
  while (subject.startsWith(FIXUP_PREFIX)) subject = subject.slice(FIXUP_PREFIX.length);
  const original = commits.findIndex((c) => !c.subject.startsWith(FIXUP_PREFIX) && (c.subject === subject || c.sha === subject));
  return original === -1 ? undefined : original;
}

/** El commit de cada línea de `path` en `HEAD`, que lo tiene: solo se pide con hunks que quitan líneas. */
async function blameLines(workspaces: Workspaces, ws: WorkspaceRef, path: string): Promise<Map<number, string>> {
  const lines = new Map<number, string>();
  const out = await workspaces.git(ws, "blame", "--porcelain", "HEAD", "--", path);
  // Cada línea del archivo abre con `<sha> <línea original> <línea final>`; su contenido lleva un tab delante.
  for (const entry of out.split("\n")) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(entry);
    if (header) lines.set(Number(header[2]), header[1]!);
  }
  return lines;
}

/**
 * Las líneas (de `HEAD`) que el hunk quita o cambia, y las que quedan pegadas a cada cambio sin ser
 * parte de él: la de antes y la de después de cada tramo de `-` y `+`.
 */
function touchedLines(hunk: Hunk): { removed: number[]; adjacent: number[] } {
  const start = /^@@ -(\d+)/.exec(hunk.header);
  if (!start) return { removed: [], adjacent: [] };
  const removed: number[] = [];
  const adjacent: number[] = [];
  let line = Number(start[1]);
  let changing = false;
  for (const text of hunk.body.split("\n").slice(1)) {
    const change = text.startsWith("-") || text.startsWith("+");
    if (change && !changing) adjacent.push(line - 1);
    if (text.startsWith(" ") && changing) adjacent.push(line);
    if (text.startsWith("-")) removed.push(line++);
    else if (text.startsWith(" ")) line++;
    if (change || text.startsWith(" ")) changing = change;
  }
  if (changing) adjacent.push(line);
  return { removed, adjacent };
}

/** El rango de `path` en `HEAD` que cubre el hunk, para ligar un hallazgo del PR (que apunta a una línea de `HEAD`) con su arreglo. */
export function oldRange(hunk: Hunk): { from: number; to: number } {
  const match = /^@@ -(\d+)(?:,(\d+))?/.exec(hunk.header);
  if (!match) return { from: 0, to: 0 };
  const from = Number(match[1]);
  return { from, to: from + Math.max(Number(match[2] ?? 1), 1) - 1 };
}
