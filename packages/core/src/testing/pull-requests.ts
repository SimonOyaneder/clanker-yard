import { newId } from "../store/conventions";
import { prParents, pullRequests } from "../store/schema";
import type { Store } from "../store/store";

type Row = typeof pullRequests.$inferInsert;

/** Una fila de `pull_requests` para un test: el repo y el número (`null` y su branch en un PR `local`), y lo que el test necesita distinto de los defaults. */
export type SeedPr = Pick<Row, "repoId"> & Partial<Row> & ({ number: number } | { number: null; headRef: string }) & {
  /** Los ids de los PRs de los que cuelga (`pr_parents`). */
  parents?: string[];
};

/**
 * Inserta un PR como lo dejaría `pr.publish` o Watch, sin pasar por GitHub: por defecto abierto, fuera de draft, del
 * sistema (`owned`) y con la branch `pr-<número>` sobre `main`. Devuelve su id.
 */
export function seedPr(store: Store, { parents = [], ...pr }: SeedPr): string {
  const id = pr.id ?? newId("pr");
  store.tx((tx) => {
    tx.db
      .insert(pullRequests)
      .values({ nodeId: pr.number === null ? null : `PR_${pr.number}`, headRef: `pr-${pr.number}`, baseRef: "main", headSha: "", state: "open", isDraft: false, owned: true, ...pr, id })
      .run();
    for (const parentId of parents) tx.db.insert(prParents).values({ childId: id, parentId }).run();
  });
  return id;
}
