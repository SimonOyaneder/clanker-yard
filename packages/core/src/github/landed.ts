import { git, tryGit } from "../git/git";

// Un PR que una cola de merge (bors y parecidas) cierra sin mergearlo: la cola pushea su propio commit (un squash) a la
// branch por defecto y cierra el PR, así que GitHub lo da por cerrado y nunca por mergeado. Para el stack es un merge:
// lo que importa es si su contenido ya está en la base. Qué repos se mergean así lo dice el pack (su estrategia de
// merge por comando, `merge.via: "comment"`); quien llama lo revisa antes.

/**
 * El primer commit de `origin/<defaultBranch>` (por la primera línea) que ya trae todo lo que cambia `headSha`, o
 * `undefined` si la base no lo trae (o no se puede saber: falta un commit en el repo local, o el PR no cambia nada
 * respecto de donde salió). "Ya lo trae" es que fusionar la punta del PR en ese commit no cambia su árbol
 * (`merge-tree`); como un cambio que llegó a la base no se va (salvo un revert), la búsqueda es binaria. El repo de
 * `path` ya tiene que estar traído (`workspaces.fetch`).
 */
export async function landedCommit(path: string, { headSha, defaultBranch }: { headSha: string; defaultBranch: string }): Promise<string | undefined> {
  const tip = await tryGit(path, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${defaultBranch}`]);
  if (tip === undefined || (await tryGit(path, ["cat-file", "-e", `${headSha}^{commit}`])) === undefined) return undefined;
  const base = await tryGit(path, ["merge-base", tip, headSha]);
  if (base === undefined) return undefined;
  if ((await treeOf(path, headSha)) === (await treeOf(path, base))) return undefined;
  if (!(await brings(path, tip, headSha))) return undefined;

  const commits = (await git(path, ["rev-list", "--first-parent", "--reverse", `${base}..${tip}`])).split("\n").filter(Boolean);
  let lo = 0;
  let hi = commits.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (await brings(path, commits[mid]!, headSha)) hi = mid;
    else lo = mid + 1;
  }
  return commits[lo];
}

const treeOf = (path: string, rev: string) => git(path, ["rev-parse", `${rev}^{tree}`]);

/** Fusionar `headSha` en `commit` no le cambia nada: ya lo trae. Un conflicto es que no. */
async function brings(path: string, commit: string, headSha: string): Promise<boolean> {
  const merged = await tryGit(path, ["merge-tree", "--write-tree", commit, headSha]);
  return merged !== undefined && merged.split("\n")[0] === (await treeOf(path, commit));
}
