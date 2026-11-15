import type { MergeStrategy, PrRef } from "@clanker/api";
import { and, eq } from "drizzle-orm";
import type { Connections } from "../connections/connections";
import { pullRequests, syncCursors } from "../store/schema";
import type { Store } from "../store/store";
import type { Repos } from "../workspaces/repos";
import { fetchDefaultBranchChecks } from "./pr-query";

// Lo que el core sabe de un PR o de su repo y la estrategia de merge necesita para evaluarse: el `hold` que
// marcó el usuario y si la estrategia del pack aplica al repo (`docs/design.html#d-ops`, "Packs", y la
// decisión #33).

const DAY_MS = 24 * 60 * 60 * 1000;
/** Cuánto vale haber visto el check (un repo no lo abandona de un día para otro) y cuánto no haberlo visto (puede adoptarlo). */
const SEEN_FOR_MS = 7 * DAY_MS;
const ABSENT_FOR_MS = DAY_MS;

export interface MergeScope {
  /** `pull_requests.hold` del PR; `false` si el core no lo conoce. */
  hold(ref: PrRef): boolean;
  /**
   * Si la estrategia de merge del pack aplica al repo del PR. Sin `appliesWhen` aplica siempre. El override
   * del repo (`Repos.setMergeStrategy`) manda; si no hay, aplica donde el check `appliesWhen.checkSeenOnDefault`
   * (merge-queue) aparece en los últimos commits de la branch por defecto. Esa lectura de GitHub se recuerda un día
   * si no lo vio y una semana si sí (`sync_cursors`).
   */
  applies(ref: PrRef, strategy: MergeStrategy): Promise<boolean>;
}

export interface MergeScopeDeps {
  store: Store;
  repos: Pick<Repos, "byRemote">;
  connections: Pick<Connections, "githubClient">;
  now?: () => number;
}

export function createMergeScope({ store, repos, connections, now = Date.now }: MergeScopeDeps): MergeScope {
  return {
    hold(ref) {
      const repo = repos.byRemote(ref.repo);
      if (!repo) return false;
      const row = store.db
        .select({ hold: pullRequests.hold })
        .from(pullRequests)
        .where(and(eq(pullRequests.repoId, repo.id), eq(pullRequests.number, ref.number)))
        .get();
      return row?.hold ?? false;
    },

    async applies(ref, { appliesWhen }) {
      if (!appliesWhen) return true;
      const override = repos.byRemote(ref.repo)?.mergeStrategy;
      if (override) return override === "on";

      const { checkSeenOnDefault: check } = appliesWhen;
      const key = `merge-applies:${ref.repo}:${check}`;
      const known = store.db.select().from(syncCursors).where(eq(syncCursors.key, key)).get();
      const seen = known?.cursor === "seen";
      if (known && now() - known.checkedAt < (seen ? SEEN_FOR_MS : ABSENT_FOR_MS)) return seen;

      const [owner, name] = ref.repo.split("/") as [string, string];
      const found = (await fetchDefaultBranchChecks(connections.githubClient(ref.account), { owner, name })).has(check);
      const values = { cursor: found ? "seen" : "absent", checkedAt: now() };
      store.tx((tx) => tx.db.insert(syncCursors).values({ key, ...values }).onConflictDoUpdate({ target: syncCursors.key, set: values }).run());
      return found;
    },
  };
}
