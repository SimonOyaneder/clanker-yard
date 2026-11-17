import type { CachedPr, PrRef, PrState } from "@clanker/api"

export type GithubPr = CachedPr & { ref: PrRef; state: PrState; local: null }
export type LocalPr = CachedPr & { ref: null; state: null; local: NonNullable<CachedPr["local"]> }
export type OpenPr = GithubPr | LocalPr

export function openPrsOf(prs: readonly CachedPr[]): OpenPr[] {
  return prs.filter((p): p is OpenPr => p.local !== null || (p.ref !== null && p.state !== null && (p.state.state === "open" || p.state.state === "draft")))
}

export const isDraft = (pr: OpenPr) => pr.state?.state === "draft"

export const titleOf = (pr: OpenPr) => pr.local ? pr.local.title : pr.state.title
export const branchOf = (pr: OpenPr) => pr.local ? pr.local.branch : pr.state.headRef
export const baseOf = (pr: OpenPr) => pr.local ? pr.local.base : pr.state.baseRef
export const keyOf = (pr: OpenPr) => pr.local ? pr.local.branch : pr.state.key

/** El nombre del repo sin su dueño: `ledger` de `acme/ledger`. */
export const repoNameOf = (pr: Pick<CachedPr, "repo">) => pr.repo.split("/")[1] ?? pr.repo
