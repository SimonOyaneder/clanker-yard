import type { ReviewInboxRow } from "@clanker/api";
import { desc, eq } from "drizzle-orm";
import type { Connections } from "../connections/connections";
import { incomingReviews, repos, runs } from "../store/schema";
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

/** Reads GitHub on opening/refreshing the inbox. A completed run alone never implies a submitted review. */
export async function reviewInbox(store: Store, connections: Pick<Connections, "list" | "githubClient">) {
  const accounts = connections.list().filter((c) => c.provider === "github" && c.status === "active");
  const rows: ReviewInboxRow[] = [];
  for (const { account } of accounts) {
    const client = connections.githubClient(account);
    const assignments = store.db.select({ repo: repos.remote, number: incomingReviews.number, run: runs.status, outcome: runs.outcome, runId: incomingReviews.runId })
      .from(incomingReviews).innerJoin(repos, eq(repos.id, incomingReviews.repoId)).leftJoin(runs, eq(runs.id, incomingReviews.runId))
      .where(eq(incomingReviews.account, account)).orderBy(desc(incomingReviews.dueAt)).all();
    const local = new Map<string, typeof assignments[number]>();
    for (const assignment of assignments) {
      const key = `https://github.com/${assignment.repo}/pull/${assignment.number}`.toLowerCase();
      if (assignment.repo && !local.has(key)) local.set(key, assignment);
    }
    const found = new Map<string, ReviewInboxRow>();
    function add(pr: Pull, requested: boolean) {
      if (pr.state !== "OPEN" || pr.viewerDidAuthor) return;
      const key = pr.url.toLowerCase();
      if (found.has(key)) return;
      const assignment = local.get(key);
      found.set(key, { account, repo: pr.repository.nameWithOwner, number: pr.number, title: pr.title, url: pr.url, isDraft: pr.isDraft,
        review: pr.draft.totalCount ? "draft" : requested ? "requested" : pr.published.totalCount ? "published" : "none",
        scheduled: requested && !!assignment && !assignment.runId, run: assignment?.run ?? null, outcome: assignment?.outcome ?? null });
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
    rows.push(...found.values());
  }
  return { connected: accounts.length > 0, rows };
}
