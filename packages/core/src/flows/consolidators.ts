import { createHash } from "node:crypto";
import * as z from "zod";
import type { BranchResult, ConsolidatorDef } from "./catalog";
import { isRecord } from "../defs/defs";

// Los consolidadores que trae el motor: el join de un parallel es código con tests, no un LLM
// (`docs/design.html#d-flows`, "Parallel y join"). Los registra `createFlows`.

/** De mejor a peor. */
const WORST_LADDER = ["ok", "changes", "fail", "error"];

/** El peor outcome entre las ramas; sin ramas, `ok`. El output es lo que dejó cada rama. */
export const worst: ConsolidatorDef = {
  name: "worst",
  outcomes: ["ok", "changes", "fail"],
  run(byBranch) {
    let worstIndex = 0;
    for (const [branch, { outcome }] of Object.entries(byBranch)) {
      const index = WORST_LADDER.indexOf(outcome);
      if (index < 0) {
        throw new Error(`worst no conoce el outcome "${outcome}" de la rama "${branch}" (conoce: ${WORST_LADDER.join(", ")}).`);
      }
      worstIndex = Math.max(worstIndex, index);
    }
    return { outcome: WORST_LADDER[worstIndex] ?? "ok", output: { branches: byBranch } };
  },
};

/** De mejor a peor: el `@end` de una corrida hija. */
const FLOW_LADDER = ["done", "blocked", "failed"];

/**
 * El join de un forEach de subflujos: el peor `@end` entre las hijas (`done`, `blocked`, `failed`); sin hijas,
 * `done`. `worst` no sirve ahí porque sus outcomes son los de los pasos, no los de un flujo.
 */
export const worstFlow: ConsolidatorDef = {
  name: "flows.worst",
  outcomes: FLOW_LADDER,
  run(byBranch) {
    let worstIndex = 0;
    for (const [branch, { outcome }] of Object.entries(byBranch)) {
      const index = FLOW_LADDER.indexOf(outcome);
      if (index < 0) {
        throw new Error(`flows.worst no conoce el outcome "${outcome}" de la rama "${branch}" (conoce: ${FLOW_LADDER.join(", ")}).`);
      }
      worstIndex = Math.max(worstIndex, index);
    }
    return { outcome: FLOW_LADDER[worstIndex] ?? "done", output: { branches: byBranch } };
  },
};

const ItemsMergeArgs = z.strictObject({
  items: z.string().min(1).describe("Campo del output de cada rama con su lista de ítems."),
  rank: z.string().min(1).describe("Campo de cada ítem con su rango."),
  changesIf: z.array(z.string()).describe("Rangos que, si queda algún ítem con uno de ellos, dan `changes`."),
  order: z.array(z.string()).min(1).optional().describe("Rangos de mayor a menor. Por defecto red, yellow, white."),
  window: z.int().nonnegative().optional().describe("Líneas de distancia para tratar dos ítems como el mismo. Por defecto 3."),
  idKeys: z.array(z.string()).min(1).optional().describe("Campos del ítem que forman su id estable. Por defecto branch, path, claim."),
  onlyIfTrivial: z.array(z.string()).optional().describe("Rangos cuyos ítems pasan solo con `trivial`. Por defecto white."),
});

type Item = { [field: string]: unknown; branch: string };

/**
 * Junta las listas de ítems de las ramas (los hallazgos de los reviewers): agrupa por `path` y
 * línea (a lo más `window` de distancia, y nunca dos ítems de la misma rama: el reviewer ya
 * distinguió lo suyo), se queda con el de mayor rango de cada grupo, deja pasar los ítems de los
 * rangos de `onlyIfTrivial` solo si son `trivial`, y los ordena de mayor a menor rango.
 *
 * Cada ítem lleva `branch` (la rama que lo reportó) y un `id` que es el hash de sus `idKeys`: el
 * mismo hallazgo tiene el mismo id en la ronda siguiente sin comparar texto.
 */
export const itemsMerge: ConsolidatorDef<typeof ItemsMergeArgs> = {
  name: "items.merge",
  args: ItemsMergeArgs,
  outcomes: ["ok", "changes"],
  run(byBranch, args) {
    const order = args.order ?? ["red", "yellow", "white"];
    const window = args.window ?? 3;
    const idKeys = args.idKeys ?? ["branch", "path", "claim"];
    const gated = new Set(args.onlyIfTrivial ?? ["white"]);

    const rankOf = (item: Item): number => {
      const index = order.indexOf(String(item[args.rank]));
      if (index < 0) {
        throw new Error(
          `El ítem de la rama "${item.branch}" tiene ${args.rank} "${String(item[args.rank])}", que no está en order (${order.join(", ")}).`,
        );
      }
      return index;
    };

    const groups: { anchor: number; members: Item[] }[] = [];
    for (const item of itemsOf(byBranch, args.items)) {
      rankOf(item);
      const line = Number(item.line);
      const group = groups.find(
        (g) =>
          Math.abs(g.anchor - line) <= window &&
          g.members[0]?.path === item.path &&
          !g.members.some((m) => m.branch === item.branch),
      );
      if (group) group.members.push(item);
      else groups.push({ anchor: line, members: [item] });
    }

    const merged = groups
      .map(({ members }) => members.reduce((best, item) => (beats(item, best, rankOf) ? item : best)))
      .filter((item) => !gated.has(String(item[args.rank])) || item.trivial === true)
      .map((item): Item => ({ ...item, id: stableId(item, idKeys) }))
      .sort((a, b) => rankOf(a) - rankOf(b));

    const changes = merged.some((item) => args.changesIf.includes(String(item[args.rank])));
    return { outcome: changes ? "changes" : "ok", output: { [args.items]: merged } };
  },
};

/** Mayor rango gana; a igual rango, el trivial; a igual todo, el que ya estaba (el de la rama anterior). */
function beats(item: Item, best: Item, rankOf: (item: Item) => number): boolean {
  const byRank = rankOf(best) - rankOf(item);
  if (byRank !== 0) return byRank > 0;
  return item.trivial === true && best.trivial !== true;
}

function itemsOf(byBranch: Record<string, BranchResult>, field: string): Item[] {
  const items: Item[] = [];
  for (const [branch, { output }] of Object.entries(byBranch)) {
    const list = isRecord(output) ? output[field] : undefined;
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) throw new Error(`El campo "${field}" de la rama "${branch}" no es una lista.`);
    for (const item of list) {
      if (!isRecord(item)) throw new Error(`Un ítem de "${field}" de la rama "${branch}" no es un objeto.`);
      items.push({ ...item, branch });
    }
  }
  return items;
}

function stableId(item: Item, keys: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify(keys.map((key) => item[key] ?? null)))
    .digest("hex")
    .slice(0, 12);
}


