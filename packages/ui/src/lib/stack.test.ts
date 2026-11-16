import type { CachedPr } from "@clanker/api";
import { expect, test } from "vitest";
import { buildOpenPrs } from "@/demo/seed-prs";
import { openPrsOf } from "./prs";
import { buildStackForest, layoutStackGroups, listStackGroups } from "./stack";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const seed = () => openPrsOf(buildOpenPrs(NOW));
const keyOf = (forest: ReturnType<typeof buildStackForest>, id: string) =>
  forest.byId.get(id)!.state.key;

test("un PR cuelga del que tiene su base como head, en el mismo repo", () => {
  const forest = buildStackForest(seed());

  const edges = forest.edges.map(
    (e) => `${keyOf(forest, e.parentId)} <- ${keyOf(forest, e.childId)}`,
  );
  expect(edges).toContain("ledger#421 <- ledger#424");
  expect(edges).toContain("ledger#424 <- ledger#426");
  expect(edges).toContain("ledger#421 <- ledger#427");
});

test("una base combinada cuelga de todos sus padres registrados, aunque su base no sea la head de ninguno", () => {
  const forest = buildStackForest(seed());

  const edges = forest.edges
    .filter((e) => keyOf(forest, e.childId) === "payments-api#395")
    .map((e) => keyOf(forest, e.parentId));
  expect(edges.sort()).toEqual(["payments-api#388", "payments-api#391"]);
  expect([...forest.combined.values()]).toEqual([
    ["payments-api#391", "payments-api#388"],
  ]);
});

test("los stacks se listan del más grande al más chico, con el PR de la base primero", () => {
  const groups = listStackGroups(buildStackForest(seed()));

  expect(groups[0]?.prIds).toHaveLength(4);
  expect(groups.map((g) => g.prIds.length)).toEqual([4, 3, 1, 1, 1, 1, 1]);
});

test("un padre que ya no está abierto no deja un PR colgando: queda como raíz de su stack", () => {
  const prs = seed();
  const orphan = prs.find((p) => p.state.key === "ledger#424")!;
  const withMissingParent: CachedPr[] = [
    {
      ...orphan,
      state: { ...orphan.state, baseRef: "ya-mergeada" },
      parents: ["pr_inexistente"],
    },
  ];
  const forest = buildStackForest(openPrsOf(withMissingParent));

  expect(forest.roots).toEqual([orphan.id]);
  expect(forest.edges).toEqual([]);
});

test("las tarjetas de un stack no se montan aunque midan distinto, y las de un mismo nivel quedan alineadas arriba", () => {
  const forest = buildStackForest(seed());
  const groups = listStackGroups(forest);
  const stack = groups[0]!;
  // Una tarjeta mucho más alta que la estimada: con una altura fija se montaba sobre la de abajo.
  const tall = stack.prIds[0]!;
  const heightOf = (id: string) => (id === tall ? 420 : 196);
  const positions = layoutStackGroups(forest, groups, {
    width: 296,
    heightOf,
    maxRowWidth: 4 * 296 + 3 * 48,
    gap: 48,
  });

  const boxes = [...positions].map(([id, p]) => ({
    id,
    top: p.y,
    bottom: p.y + heightOf(id),
    left: p.x,
    right: p.x + 296,
  }));
  for (const a of boxes)
    for (const b of boxes) {
      if (a.id >= b.id) continue;
      const overlap =
        a.left < b.right &&
        b.left < a.right &&
        a.top < b.bottom &&
        b.top < a.bottom;
      expect(
        overlap,
        `${keyOf(forest, a.id)} y ${keyOf(forest, b.id)} se montan`,
      ).toBe(false);
    }
  for (const { parentId, childId } of forest.edges)
    expect(positions.get(childId)!.y).toBeGreaterThanOrEqual(
      positions.get(parentId)!.y + heightOf(parentId),
    );

  const children = forest.childrenOf.get(tall) ?? [];
  expect(new Set(children.map((id) => positions.get(id)!.y)).size).toBe(1);
});
