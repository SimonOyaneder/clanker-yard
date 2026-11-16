import { and, desc, eq } from "drizzle-orm";
import type { CachedIssue } from "@clanker/api";
import { tryGit } from "../git/git";
import { runs } from "../store/schema";
import type { Store } from "../store/store";

const MAX_BRANCH_LENGTH = 50;

/**
 * El nombre de la branch de una issue, como las de la gente (`eng-9286-reject-frozen-account-transfers`): el que
 * sugiere el tracker sin el prefijo `usuario/`, o la key en minúscula y un slug del título.
 */
export function suggestedBranch(issue: Pick<CachedIssue, "ref" | "title" | "branchName">): string {
  if (issue.branchName !== undefined) return issue.branchName.slice(issue.branchName.indexOf("/") + 1);
  const key = slug(issue.ref.key);
  const words = slug(issue.title).split("-").filter(Boolean);
  let name = key;
  for (const word of words) {
    if (name.length + 1 + word.length > MAX_BRANCH_LENGTH) break;
    name += `-${word}`;
  }
  return name;
}

function slug(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * La branch de la issue: la de su corrida anterior si la hubo (reanudar o reintentar sigue en la misma branch);
 * si no, `suggestedBranch` con `-2`, `-3`... mientras la tenga otra issue (una corrida suya o una branch del repo,
 * local o de `origin` según el último fetch). Las corridas anteriores a este nombre usan el id de la issue.
 */
export async function issueBranch(store: Store, issue: CachedIssue, repoPath: string | undefined): Promise<string> {
  const previous = store.db
    .select({ params: runs.params })
    .from(runs)
    .where(and(eq(runs.subjectType, "issue"), eq(runs.subjectId, issue.id)))
    .orderBy(desc(runs.startedAt))
    .all()
    .map((r) => r.params.branch)
    .find((b): b is string => typeof b === "string" && b !== "");
  if (previous !== undefined) return previous;

  return uniqueBranch(suggestedBranch(issue), await takenBranches(store, repoPath, (run) => run.subjectId !== issue.id));
}

/**
 * Una branch nueva para la issue aunque ya haya corrido: `suggestedBranch` con `-2`, `-3`... mientras la tenga cualquier
 * corrida (también las de esta issue), una branch del repo, o `reserved` (los nombres que otra llamada ya repartió).
 * Rehacer un PR la necesita: `issueBranch` devolvería la branch que ya tiene.
 */
export async function freshIssueBranch(store: Store, issue: CachedIssue, repoPath: string | undefined, reserved: ReadonlySet<string> = new Set()): Promise<string> {
  return uniqueBranch(suggestedBranch(issue), await takenBranches(store, repoPath, () => true, reserved));
}

function uniqueBranch(base: string, taken: ReadonlySet<string>): string {
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  return name;
}

/**
 * Los nombres de branch en uso: los `params.branch` de las corridas que pasan `ofRun` y las branches del repo (locales o
 * de `origin` según el último fetch). Una corrida `canceled` o `failed` solo reserva su nombre si la branch llegó al
 * remoto: si nunca se pusheó, no hay nada que proteger y el reintento puede usarlo.
 */
async function takenBranches(
  store: Store,
  repoPath: string | undefined,
  ofRun: (run: { subjectId: string }) => boolean,
  reserved: ReadonlySet<string> = new Set(),
): Promise<Set<string>> {
  const taken = new Set(reserved);
  const remote = new Set<string>();
  if (repoPath !== undefined) {
    const refs = await tryGit(repoPath, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"]);
    for (const ref of refs?.split("\n") ?? []) {
      const name = ref.replace(/^refs\/(heads|remotes\/origin)\//, "");
      taken.add(name);
      if (ref.startsWith("refs/remotes/origin/")) remote.add(name);
    }
  }
  for (const run of store.db.select({ subjectId: runs.subjectId, status: runs.status, params: runs.params }).from(runs).where(eq(runs.subjectType, "issue")).all()) {
    const { branch } = run.params;
    if (!ofRun(run) || typeof branch !== "string") continue;
    if ((run.status === "canceled" || run.status === "failed") && !remote.has(branch)) continue;
    taken.add(branch);
  }
  return taken;
}
