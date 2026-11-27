import type { ReviewInboxRow } from "@clanker/api";
import { desc, eq } from "drizzle-orm";
import type { Connections } from "../connections/connections";
import { incomingReviews, repos, runs, syncCursors } from "../store/schema";
import type { Store } from "../store/store";

const fields = `fragment InboxPull on PullRequest {
  id state isDraft viewerDidAuthor title url number repository { nameWithOwner }
  draft: reviews(author:$account,states:[PENDING],last:1) { totalCount }
  published: reviews(author:$account,states:[APPROVED,CHANGES_REQUESTED,COMMENTED,DISMISSED],last:1) { totalCount }
}`;
const requests = `timelineItems(first:100,after:$cursor,itemTypes:[REVIEW_REQUESTED_EVENT]) {
  nodes { ... on ReviewRequestedEvent { requestedReviewer { ... on User { isViewer } } } } pageInfo { hasNextPage endCursor }
}`;
export const MORE_ASSIGNMENTS = `query InboxAssignments($id:ID!, $cursor:String!) { node(id:$id) { ... on PullRequest { ${requests} } } }`;
export const SEARCH_REVIEWS = `query InboxSearch($q:String!, $account:String!, $after:String, $history:Boolean!, $cursor:String) {
  search(query:$q,type:ISSUE,first:100,after:$after) {
    nodes { ...InboxPull ... on PullRequest @include(if:$history) { ${requests} } } pageInfo { hasNextPage endCursor }
  }
} ${fields}`;

/** Numeric aliases and literal URLs from registered remotes only, in batches. */
export const trackedReviewsQuery = (urls: string[]) => `query InboxTracked($account:String!) {
  ${urls.map((url, i) => `p${i}:resource(url:${JSON.stringify(url)}) { ...InboxPull }`).join("\n")}
} ${fields}`;

interface Pull {
  id: string; isDraft: boolean; viewerDidAuthor: boolean; timelineItems?: HistoryPage;
  state: string; title: string; url: string; number: number; repository: { nameWithOwner: string };
  draft: { totalCount: number }; published: { totalCount: number };
}
interface HistoryPage {
  nodes: { requestedReviewer: { isViewer?: boolean } | null }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}
interface SearchPage { search: { nodes: Pull[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }

function localAssignments(store: Store, account: string) {
    const assignments = store.db.select({ repo: repos.remote, number: incomingReviews.number, dueAt: incomingReviews.dueAt, run: runs.status, outcome: runs.outcome, runId: incomingReviews.runId })
      .from(incomingReviews).innerJoin(repos, eq(repos.id, incomingReviews.repoId)).leftJoin(runs, eq(runs.id, incomingReviews.runId))
      .where(eq(incomingReviews.account, account)).orderBy(desc(incomingReviews.dueAt)).all();
    const local = new Map<string, typeof assignments[number]>();
    for (const assignment of assignments) {
      const key = `https://github.com/${assignment.repo}/pull/${assignment.number}`.toLowerCase();
      if (assignment.repo && !local.has(key)) local.set(key, assignment);
    }
    return local;
}

type GitHubRow = Omit<ReviewInboxRow, "runId" | "dueAt" | "run" | "scheduled" | "outcome"> & { requested: boolean };
async function collect(client: ReturnType<Connections["githubClient"]>, account: string, local: ReturnType<typeof localAssignments>) {
    const found = new Map<string, GitHubRow>();
    function add(pr: Pull, requested: boolean) {
      if (pr.state !== "OPEN" || pr.viewerDidAuthor) return;
      const key = pr.url.toLowerCase();
      if (found.has(key)) return;
      found.set(key, { account, repo: pr.repository.nameWithOwner, number: pr.number, title: pr.title, url: pr.url, isDraft: pr.isDraft,
        review: pr.draft.totalCount ? "draft" : requested ? "requested" : pr.published.totalCount ? "published" : "none",
        requested });
    }
    for (const qualifier of ["user-review-requested", "reviewed-by"]) {
      let after: string | null = null;
      const history = qualifier === "reviewed-by";
      do {
        const { search }: SearchPage = await client.graphql(SEARCH_REVIEWS, { q: `is:pr is:open -author:@me ${qualifier}:@me sort:updated-desc`, account, after, history });
        for (const pr of search.nodes) {
          if (!pr?.repository || pr.viewerDidAuthor || pr.state !== "OPEN") continue;
          const key = pr.url.toLowerCase();
          if (!history || local.has(key)) add(pr, !history);
          else if (!found.has(key)) {
            let page = pr.timelineItems;
            while (page) {
              if (page.nodes.some(event => event?.requestedReviewer?.isViewer)) { add(pr, false); break; }
              if (!page.pageInfo.hasNextPage) break;
              const next: { node: { timelineItems: HistoryPage } | null } = await client.graphql(MORE_ASSIGNMENTS, { id: pr.id, cursor: page.pageInfo.endCursor });
              page = next.node?.timelineItems;
            }
          }
        }
        after = search.pageInfo.hasNextPage ? search.pageInfo.endCursor : null;
      } while (after);
    }
    // A withdrawn assignment or discarded draft can disappear from both searches.
    const missing = [...local.keys()].filter((url) => !found.has(url));
    for (let i = 0; i < missing.length; i += 50) {
      const pulls = await client.graphql<Record<string, Pull | null>>(trackedReviewsQuery(missing.slice(i, i + 50)), { account });
      for (const pr of Object.values(pulls)) if (pr?.repository) add(pr, false);
    }
    return [...found.values()];
}

export function createReviewInbox(store: Store, connections: Pick<Connections, "list" | "githubClient">, enabledRepos: string[] = []) {
  const inFlight = new Map<string, Promise<void>>();
  const keyOf = (account: string) => `review-inbox:${account}`;
  function sync(account: string) {
    const pending = inFlight.get(account);
    if (pending) return pending;
    const work = collect(connections.githubClient(account), account, localAssignments(store, account)).then(rows => {
      const values = { cursor: JSON.stringify(rows), checkedAt: Date.now() };
      store.tx(tx => {
        tx.db.insert(syncCursors).values({ key: keyOf(account), ...values }).onConflictDoUpdate({ target: syncCursors.key, set: values }).run();
        tx.emit({ type: "reviewInbox.refresh", origin: "core", payload: {} });
      });
    }).finally(() => inFlight.delete(account));
    inFlight.set(account, work);
    return work;
  }
  async function list(refresh = false) {
    const accounts = connections.list().filter(c => c.provider === "github" && c.status === "active");
    if (refresh) await Promise.all(accounts.map(c => sync(c.account)));
    const rows: ReviewInboxRow[] = [];
    let checkedAt: number | null = null;
    for (const { account } of accounts) {
      const snapshot = store.db.select().from(syncCursors).where(eq(syncCursors.key, keyOf(account))).get();
      if (!snapshot?.cursor) continue;
      checkedAt = Math.min(checkedAt ?? Infinity, snapshot.checkedAt);
      const assignments = localAssignments(store, account);
      for (const { requested, ...row } of JSON.parse(snapshot.cursor) as GitHubRow[]) {
        const assignment = assignments.get(row.url.toLowerCase());
        rows.push({ ...row, scheduled: requested && !!assignment && !assignment.runId, dueAt: assignment?.dueAt ?? null,
          runId: assignment?.runId ?? null, run: assignment?.run ?? null, outcome: assignment?.outcome ?? null });
      }
    }
    return { connected: accounts.length > 0, rows, checkedAt, enabledRepos };
  }
  return { list, sync };
}
