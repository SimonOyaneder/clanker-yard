import type { RepoId } from "@clanker/api";
import { and, eq } from "drizzle-orm";
import { isAncestor, tryGit } from "../git/git";
import { recordMarks } from "../github/marks";
import type { Repos } from "../repos/repos";
import { prParents, pullRequests, runs } from "../store/schema";
import type { Store } from "../store/store";

// Cuando los padres de una base combinada chocan con la branch por defecto, lo habitual es que alguna cadena de
// stack se armó sobre una punta vieja de esa branch y otro PR ya mergeado tocó lo mismo: ningún PR choca con su
// propia base, así que Watch no ve conflicto y nada lo rebasea (BA-9228 y BA-9236 esperaron por eso). Esperar a
// que se mergee un padre no alcanza: el padre de abajo puede llevar días en review.

/** La marca de `watch_marks` de un rebase pedido: una vez por raíz, punta de la raíz y punta de la branch por defecto. */
const STALE_ROOT = "stale-root";

type PrRow = typeof pullRequests.$inferSelect;

export interface StaleRootsDeps {
  store: Store;
  repos: Pick<Repos, "config">;
  now?: () => number;
}

/**
 * Pide rebasear sobre la branch por defecto las raíces atrasadas de las cadenas de estos padres (sus `branch`):
 * la raíz de una cadena es el PR abierto del que cuelga sin otro PR abierto debajo. Atrasada es que la punta de la
 * branch por defecto no está en su historia. El pedido es un `pr.conflict` como el de `prs.rebase`, que arranca el
 * flujo del pack; su restack baja por la cadena y, si un hijo choca, su `pr.conflict` lo atiende. Solo PRs del
 * sistema (`owned`), como `startTriggers`. Una vez por raíz, punta y punta de la branch por defecto: un rebase que
 * falla no se repite hasta que algo se mueva. Devuelve los PRs pedidos ahora (`repo#n`). Lee lo que el fetch de
 * `combineBase` dejó: no hace fetch.
 */
export function createStaleRoots({ store, repos, now = Date.now }: StaleRootsDeps) {
  const openPr = (repoId: RepoId, branch: string) =>
    store.db.select().from(pullRequests).where(and(eq(pullRequests.repoId, repoId), eq(pullRequests.headRef, branch), eq(pullRequests.state, "open"))).get();

  /** Los PRs abiertos de los que cuelga directamente: los de `pr_parents` y, si no hay, el de su base. */
  function parentsOf(pr: PrRow): PrRow[] {
    const linked = store.db
      .select({ pr: pullRequests })
      .from(prParents)
      .innerJoin(pullRequests, eq(pullRequests.id, prParents.parentId))
      .where(and(eq(prParents.childId, pr.id), eq(pullRequests.state, "open")))
      .all()
      .map((row) => row.pr);
    if (linked.length > 0) return linked;
    const base = openPr(pr.repoId, pr.baseRef);
    return base ? [base] : [];
  }

  function rootsOf(start: PrRow): PrRow[] {
    const roots = new Map<string, PrRow>();
    const seen = new Set<string>();
    const queue = [start];
    for (let pr = queue.shift(); pr !== undefined; pr = queue.shift()) {
      if (seen.has(pr.id)) continue;
      seen.add(pr.id);
      const parents = parentsOf(pr);
      if (parents.length === 0) roots.set(pr.id, pr);
      queue.push(...parents);
    }
    return [...roots.values()];
  }

  return async function rebaseStaleRoots(repoId: RepoId, branches: readonly string[]): Promise<string[]> {
    const cfg = repos.config(repoId);
    const remote = cfg.remote?.repo;
    if (!remote) return [];
    // Como `resolveBase` de Workspaces: la del remoto si está, si no la local.
    let defaultSha: string | undefined;
    for (const ref of [`refs/remotes/origin/${cfg.defaultBranch}`, `refs/heads/${cfg.defaultBranch}`]) {
      defaultSha = (await tryGit(cfg.path, ["rev-parse", "--verify", "--quiet", ref]))?.trim() || undefined;
      if (defaultSha) break;
    }
    if (!defaultSha) return [];
    const roots = new Map<string, PrRow>();
    for (const branch of branches) {
      const pr = openPr(repoId, branch);
      if (pr) for (const root of rootsOf(pr)) roots.set(root.id, root);
    }
    const requested: string[] = [];
    for (const root of roots.values()) {
      if (!root.owned || root.baseRef !== cfg.defaultBranch) continue;
      if (await isAncestor(cfg.path, defaultSha, root.headSha)) continue;
      const projectId = root.runId ? store.db.select({ id: runs.projectId }).from(runs).where(eq(runs.id, root.runId)).get()?.id : undefined;
      const emitted = store.tx((tx) => {
        if (recordMarks(tx, root.id, STALE_ROOT, [`${root.headSha}:${defaultSha}`], now()).length === 0) return false;
        tx.emit({
          type: "pr.conflict",
          origin: "core",
          ...(projectId && { projectId }),
          subject: { type: "pr", id: root.id },
          payload: { repo: remote, number: root.number, sha: root.headSha, base: root.baseRef },
        });
        return true;
      });
      if (emitted) requested.push(`${remote.split("/")[1]}#${root.number}`);
    }
    return requested;
  };
}

export type RebaseStaleRoots = ReturnType<typeof createStaleRoots>;
