import { basename } from "node:path";
import type { Hunk } from "../git/tree";

/** Desde este parecido de líneas, un archivo nuevo es el borrado con retoques (un move). */
const SIMILAR = 0.8;

interface WholeFile {
  path: string;
  /** Las líneas no vacías del archivo que se borra o se crea. */
  lines: string[];
  /** Los commits (índices del plan) que llevan sus hunks. */
  commits: Set<number>;
}

/**
 * Los moves que el plan parte entre commits: un archivo se borra en un commit y otro igual o casi igual
 * (>= 80% de líneas en común; sin contenido, el mismo nombre) se crea en otro. `hunks.json` no detecta
 * renames, así que git solo los ve como rename si borrar y crear van juntos. Una línea por move, con
 * lo que el committer debe hacer.
 */
export function splitMoves(hunks: Hunk[], assigned: Map<string, number>): string[] {
  const deleted = wholeFiles(hunks, assigned, "deleted file mode", "-");
  const created = wholeFiles(hunks, assigned, "new file mode", "+");
  const problems: string[] = [];
  for (const from of deleted) {
    const to = created.find((candidate) => !sameSingleCommit(from.commits, candidate.commits) && isMove(from, candidate));
    if (to === undefined) continue;
    problems.push(
      `El move de ${from.path} a ${to.path} va en un solo commit: ${from.path} se borra en ${commitsLabel(from.commits)} ` +
        `y ${to.path} se crea en ${commitsLabel(to.commits)}. Borra y crea los dos en el mismo commit para que git lo vea como rename, ` +
        `y deja los cambios de contenido en otro commit.`,
    );
  }
  return problems;
}

function wholeFiles(hunks: Hunk[], assigned: Map<string, number>, mode: string, sign: "-" | "+"): WholeFile[] {
  const files = new Map<string, WholeFile>();
  for (const hunk of hunks) {
    if (!hunk.fileHeader.includes(`\n${mode} `)) continue;
    const commit = assigned.get(hunk.id);
    if (commit === undefined) continue;
    const file = files.get(hunk.path) ?? { path: hunk.path, lines: [], commits: new Set() };
    for (const line of hunk.body.split("\n")) {
      if (line.startsWith(sign) && line.slice(1).trim() !== "") file.lines.push(line.slice(1));
    }
    file.commits.add(commit);
    files.set(hunk.path, file);
  }
  return [...files.values()];
}

function sameSingleCommit(a: Set<number>, b: Set<number>): boolean {
  return a.size === 1 && b.size === 1 && [...a][0] === [...b][0];
}

function isMove(from: WholeFile, to: WholeFile): boolean {
  if (from.lines.length === 0 || to.lines.length === 0) {
    return from.lines.length === to.lines.length && basename(from.path) === basename(to.path);
  }
  const pool = new Map<string, number>();
  for (const line of from.lines) pool.set(line, (pool.get(line) ?? 0) + 1);
  let common = 0;
  for (const line of to.lines) {
    const left = pool.get(line) ?? 0;
    if (left > 0) {
      common += 1;
      pool.set(line, left - 1);
    }
  }
  return common / Math.max(from.lines.length, to.lines.length) >= SIMILAR;
}

function commitsLabel(commits: Set<number>): string {
  const numbers = [...commits].sort((a, b) => a - b).map((i) => i + 1);
  return numbers.length === 1 ? `el commit ${numbers[0]}` : `los commits ${numbers.join(", ")}`;
}
