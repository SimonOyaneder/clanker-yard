import { and, desc, eq, ne } from "drizzle-orm";
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

  const taken = new Set<string>();
  for (const { params } of store.db
    .select({ params: runs.params })
    .from(runs)
    .where(and(eq(runs.subjectType, "issue"), ne(runs.subjectId, issue.id)))
    .all()) {
    if (typeof params.branch === "string") taken.add(params.branch);
  }
  if (repoPath !== undefined) {
    const refs = await tryGit(repoPath, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"]);
    for (const ref of refs?.split("\n") ?? []) taken.add(ref.replace(/^refs\/(heads|remotes\/origin)\//, ""));
  }

  const base = suggestedBranch(issue);
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  return name;
}
