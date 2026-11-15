import { isAncestor, mergeTree, type Git } from "./restack";

// La mecánica de git de una base combinada (`docs/design.html#d-ops`, "Bases combinadas"): la punta
// de la branch por defecto con un merge --no-ff de cada padre encima, sin tocar ningún worktree. Solo crea
// objetos; mover la branch sintética y registrarla es de `workspaces.combineBase`.

/** Un PR padre de una base combinada: su branch en el remoto y la punta que se juntó. */
export interface CombinedParent {
  /** `repo#número`, como lo nombra la cola. */
  key: string;
  branch: string;
  sha: string;
}

/**
 * - `ok`: `head` es la punta de la base.
 * - `conflict`: `parent` no se puede juntar con lo que ya había (la branch por defecto y los padres anteriores,
 *   `merged`); `conflicts` son los archivos.
 */
export type CombinedPlan =
  | { status: "ok"; head: string }
  | { status: "conflict"; parent: CombinedParent; merged: string[]; conflicts: string[]; failures: string };

/**
 * Junta `parents`, en ese orden, sobre `onto` con un commit de merge cada uno. Un padre que `onto` ya
 * contiene (porque se mergeó, o porque cuelga de otro padre) no agrega commit. Los commits son
 * deterministas (la fecha es la de `onto`): rehacer la misma base da el mismo
 * sha, que es lo que deja reintentar un restack cortado a medias.
 */
export async function planCombinedBase(
  git: Git,
  { onto, parents, into, identity }: { onto: string; parents: readonly CombinedParent[]; into: string; identity: { name: string; email: string } },
): Promise<CombinedPlan> {
  const date = await git(["log", "-1", "--format=%cI", onto]);
  const env = {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
  let tip = onto;
  const merged: string[] = [];
  for (const parent of parents) {
    if (!(await isAncestor(git, parent.sha, tip))) {
      const result = await mergeTree(git, tip, parent.sha);
      if (!result.ok) return { status: "conflict", parent, merged, conflicts: result.conflicts, failures: result.failures };
      tip = await git(
        ["-c", "commit.gpgsign=false", "commit-tree", result.tree, "-p", tip, "-p", parent.sha, "-m", `Merge branch '${parent.branch}' into ${into}`],
        env,
      );
    }
    merged.push(parent.key);
  }
  return { status: "ok", head: tip };
}
