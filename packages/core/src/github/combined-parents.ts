import { and, eq, inArray } from "drizzle-orm";
import { combinedBases, prParents, pullRequests } from "../store/schema";
import type { Store } from "../store/store";
import type { CombinedParent } from "../workspaces/combine";

type CombinedBase = typeof combinedBases.$inferSelect;
type PrRow = typeof pullRequests.$inferSelect;

/**
 * Los padres vivos (abiertos o locales) de `child` sobre su base combinada, en el orden de la base: salen de su
 * `pr_parents`, que es lo que se mantiene al día (republicar un PR lo repunta al nuevo; un padre mergeado se suelta al
 * restackear), y no de las branches que la base guardó al armarse, que pueden ser nombres que ya no existen. `merged`
 * es la branch de un padre que se acaba de mergear y el caché todavía no cerró. Sin `pr_parents` (un PR viejo) se cae a
 * las branches de la base. `undefined` si no se puede saber quiénes son: ni `pr_parents` ni ninguna branch de la base
 * es de un PR conocido (en ese caso nadie debe disolver la base).
 */
export function liveCombinedParents(store: Store, child: Pick<PrRow, "id" | "repoId">, combined: CombinedBase, merged?: string): Pick<CombinedParent, "key" | "branch">[] | undefined {
  const linked = store.db
    .select({ pr: pullRequests })
    .from(prParents)
    .innerJoin(pullRequests, eq(pullRequests.id, prParents.parentId))
    .where(eq(prParents.childId, child.id))
    .all()
    .map((row) => row.pr);
  const prefix = combined.parents[0]?.key.split(/[#@]/)[0] ?? "";
  const keyOf = (pr: PrRow) => combined.parents.find((p) => p.branch === pr.headRef)?.key ?? (pr.number === null ? `${prefix}@${pr.headRef}` : `${prefix}#${pr.number}`);
  const order = (pr: PrRow) => {
    const at = combined.parents.findIndex((p) => p.branch === pr.headRef || p.key === keyOf(pr));
    return at === -1 ? Number.MAX_SAFE_INTEGER : at;
  };
  if (linked.length > 0) {
    return linked
      .filter((pr) => (pr.state === "open" || pr.state === "local") && pr.headRef !== merged)
      .sort((a, b) => order(a) - order(b))
      .map((pr) => ({ key: keyOf(pr), branch: pr.headRef }));
  }
  const known = store.db
    .select({ headRef: pullRequests.headRef, state: pullRequests.state })
    .from(pullRequests)
    .where(and(eq(pullRequests.repoId, child.repoId), inArray(pullRequests.headRef, combined.parents.map((p) => p.branch))))
    .all();
  if (known.length === 0) return undefined;
  const live = new Set(known.filter((p) => p.state === "open" || p.state === "local").map((p) => p.headRef));
  return combined.parents.filter((p) => p.branch !== merged && live.has(p.branch)).map(({ key, branch }) => ({ key, branch }));
}
