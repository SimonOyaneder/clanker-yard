import type { CachedPr, PrRef, PrState } from "@clanker/api"

/** Un PR abierto (o en draft) del caché del core del que Watch ya leyó su estado: lo único que la vista de PRs dibuja. */
export type OpenPr = CachedPr & { ref: PrRef; state: PrState }

/** Los PRs que se pueden dibujar: con estado leído y todavía abiertos. */
export function openPrsOf(prs: readonly CachedPr[]): OpenPr[] {
  return prs.filter((p): p is OpenPr => p.ref !== null && p.state !== null && (p.state.state === "open" || p.state.state === "draft"))
}

export const isDraft = (pr: OpenPr) => pr.state.state === "draft"

/** El nombre del repo sin su dueño: `ledger` de `acme/ledger`. */
export const repoNameOf = (pr: Pick<OpenPr, "ref">) => pr.ref.repo.split("/")[1] ?? pr.ref.repo
