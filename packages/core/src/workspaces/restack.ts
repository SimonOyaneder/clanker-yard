import { GitError } from "../git/git";
import { excerpt } from "./exec";

// La mecánica de git del restack de un PR (`docs/design.html#d-ops`, restack): sus commits propios, sin
// los merges de la base, vuelven a aplicarse uno a uno sobre la base nueva. No toca el worktree ni la
// branch: solo crea objetos, así que un conflicto o un corte no deja nada a medias. Las precondiciones,
// el push y mover la branch los hace `workspaces.restack`.

/** `git` en el worktree; `env` se suma al entorno y `input` va al stdin. */
export type Git = (args: string[], env?: Record<string, string>, input?: string) => Promise<string>;

/**
 * - `ok`: `head` es la punta nueva, `commits` los commits propios aplicados sobre `onto`.
 * - `conflict`: `applying` no aplica limpio sobre la base nueva (`conflicts` son los archivos) o su
 *   patch-id cambió al aplicarse (`conflicts` vacío): el cambio que quedaría no es el que se escribió.
 * - `foreign-merge`: `merge` es un merge de una branch que no es de la base ni de lo que esta contiene.
 * - `empty`: no quedan commits propios.
 */
export type RestackPlan =
  | { status: "ok"; head: string; commits: number }
  | { status: "conflict"; applying: string; conflicts: string[]; failures: string }
  | { status: "foreign-merge"; merge: string; failures: string }
  | { status: "empty" };

/**
 * Los commits propios de `HEAD` son los de su primer padre desde `from` (la última punta de la base
 * vieja), menos los merges cuyo segundo padre ya está en `from` o en `onto`: son los de la base que
 * release-bot[bot] trae a la branch. Cada commit propio se aplica con `merge-tree` (un cherry-pick sin
 * worktree) conservando autor, fecha y mensaje, y su patch-id tiene que ser el original.
 */
export async function planRestack(git: Git, { onto, from, committer }: { onto: string; from: string; committer: Record<string, string> }): Promise<RestackPlan> {
  const own: string[] = [];
  for (const line of (await git(["rev-list", "--first-parent", "--reverse", "--parents", `${from}..HEAD`])).split("\n").filter(Boolean)) {
    const [sha, , ...others] = line.split(" ") as [string, string, ...string[]];
    if (others.length === 0) {
      own.push(sha);
      continue;
    }
    for (const parent of others) {
      if (!(await isAncestor(git, parent, from)) && !(await isAncestor(git, parent, onto))) {
        return {
          status: "foreign-merge",
          merge: sha,
          failures: `${sha.slice(0, 9)} es un merge de ${parent.slice(0, 9)}, que no está en la base: no se sabe cuáles de sus commits son propios.`,
        };
      }
    }
  }
  if (own.length === 0) return { status: "empty" };

  let tip = onto;
  for (const commit of own) {
    const merged = await cherryPickTree(git, tip, commit);
    if (!merged.ok) return { status: "conflict", applying: commit, conflicts: merged.conflicts, failures: merged.failures };
    tip = await commitTree(git, merged.tree, tip, commit, committer);
    if ((await patchId(git, commit)) !== (await patchId(git, tip))) {
      return {
        status: "conflict",
        applying: commit,
        conflicts: [],
        failures: `${commit.slice(0, 9)} cambió al aplicarse sobre la base nueva (otro patch-id): la base ya trae parte de ese cambio o lo altera.`,
      };
    }
  }
  return { status: "ok", head: tip, commits: own.length };
}

export async function isAncestor(git: Git, ancestor: string, descendant: string): Promise<boolean> {
  return git(["merge-base", "--is-ancestor", ancestor, descendant]).then(
    () => true,
    (error) => {
      if (error instanceof GitError) return false;
      throw error;
    },
  );
}

/** El árbol de aplicar `commit` sobre `tip` (con `commit^` de base), o los archivos en conflicto. */
function cherryPickTree(git: Git, tip: string, commit: string) {
  return mergeTree(git, tip, commit, [`--merge-base=${commit}^`]);
}

/** El árbol de juntar `theirs` en `ours` con `merge-tree` (sin worktree), o los archivos en conflicto. */
export async function mergeTree(git: Git, ours: string, theirs: string, options: string[] = []) {
  try {
    const out = await git(["merge-tree", "--write-tree", "--name-only", ...options, ours, theirs]);
    return { ok: true as const, tree: out.split("\n")[0]! };
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    // Con conflicto `merge-tree` sale con 1: el árbol, los archivos en conflicto, una línea en blanco y los mensajes.
    const [, ...rest] = error.stdout.split("\n");
    const blank = rest.indexOf("");
    const conflicts = rest.slice(0, blank === -1 ? rest.length : blank).filter(Boolean);
    if (conflicts.length === 0) throw error;
    return { ok: false as const, conflicts, failures: `Conflicto en ${conflicts.join(", ")}.\n${excerpt(error.stdout)}` };
  }
}

async function commitTree(git: Git, tree: string, parent: string, original: string, committer: Record<string, string>): Promise<string> {
  const [name, email, date] = (await git(["log", "-1", "--format=%an%n%ae%n%aI", original])).split("\n") as [string, string, string];
  const message = await git(["log", "-1", "--format=%B", original]);
  return git(
    ["-c", "commit.gpgsign=false", "commit-tree", tree, "-p", parent, "-F", "-"],
    { ...committer, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date },
    `${message}\n`,
  );
}

/** El patch-id estable de lo que `commit` cambia respecto de su padre. */
async function patchId(git: Git, commit: string): Promise<string> {
  const patch = await git(["diff-tree", "-p", "--no-commit-id", "--no-ext-diff", "--no-textconv", commit]);
  return (await git(["patch-id", "--stable"], {}, patch.length === 0 ? "" : `${patch}\n`)).split(/\s+/)[0] ?? "";
}
