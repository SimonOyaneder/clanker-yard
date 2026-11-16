import type { CachedPr } from "@clanker/api"
import { expect, test } from "vitest"
import { buildOpenPrs } from "@/demo/seed-prs"
import { openPrsOf } from "./prs"
import { buildStackForest, listStackGroups } from "./stack"

const NOW = Date.parse("2026-11-15T12:00:00Z")
const seed = () => openPrsOf(buildOpenPrs(NOW))
const keyOf = (forest: ReturnType<typeof buildStackForest>, id: string) => forest.byId.get(id)!.state.key

test("un PR cuelga del que tiene su base como head, en el mismo repo", () => {
  const forest = buildStackForest(seed())

  const edges = forest.edges.map((e) => `${keyOf(forest, e.parentId)} <- ${keyOf(forest, e.childId)}`)
  expect(edges).toContain("ledger#421 <- ledger#424")
  expect(edges).toContain("ledger#424 <- ledger#426")
  expect(edges).toContain("ledger#421 <- ledger#427")
})

test("una base combinada cuelga de todos sus padres registrados, aunque su base no sea la head de ninguno", () => {
  const forest = buildStackForest(seed())

  const edges = forest.edges.filter((e) => keyOf(forest, e.childId) === "payments-api#395").map((e) => keyOf(forest, e.parentId))
  expect(edges.sort()).toEqual(["payments-api#388", "payments-api#391"])
  expect([...forest.combined.values()]).toEqual([["payments-api#391", "payments-api#388"]])
})

test("los stacks se listan del más grande al más chico, con el PR de la base primero", () => {
  const groups = listStackGroups(buildStackForest(seed()))

  expect(groups[0]?.prIds).toHaveLength(4)
  expect(groups.map((g) => g.prIds.length)).toEqual([4, 3, 1, 1, 1, 1, 1])
})

test("un padre que ya no está abierto no deja un PR colgando: queda como raíz de su stack", () => {
  const prs = seed()
  const orphan = prs.find((p) => p.state.key === "ledger#424")!
  const withMissingParent: CachedPr[] = [{ ...orphan, state: { ...orphan.state, baseRef: "ya-mergeada" }, parents: ["pr_inexistente"] }]
  const forest = buildStackForest(openPrsOf(withMissingParent))

  expect(forest.roots).toEqual([orphan.id])
  expect(forest.edges).toEqual([])
})
