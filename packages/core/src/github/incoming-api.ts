import type { GitHubClient } from "./client";
import { RequestError } from "@octokit/request-error";
import { eq } from "drizzle-orm";
import { syncCursors } from "../store/schema";
import type { Store } from "../store/store";

/** El 304 de la búsqueda no cancela un delay ni oculta una reasignación del mismo PR. */
export async function searchRequested(client: GitHubClient, store: Store, account: string, repo: string, page: number) {
  const key = `requested:${account}:${repo}:${page}`;
  const saved = store.db.select().from(syncCursors).where(eq(syncCursors.key, key)).get();
  try {
    const { data, headers } = await client.request("GET /search/issues", {
      q: `repo:${repo} is:pr is:open review-requested:@me`, per_page: 100, page,
      headers: saved?.etag && saved.cursor ? { "if-none-match": saved.etag } : {},
    });
    const result = { numbers: data.items.map((item) => item.number), more: data.items.length === 100 && page * 100 < data.total_count };
    if (!data.incomplete_results) {
      const values = { cursor: JSON.stringify(result), etag: headers.etag ?? null, checkedAt: Date.now() };
      store.tx((tx) => tx.db.insert(syncCursors).values({ key, ...values }).onConflictDoUpdate({ target: syncCursors.key, set: values }).run());
    }
    return result;
  } catch (error) {
    if (error instanceof RequestError && error.status === 304 && saved?.cursor) return JSON.parse(saved.cursor) as { numbers: number[]; more: boolean };
    throw error;
  }
}

export const REQUESTED = `query IncomingRequest($owner:String!, $name:String!, $n:Int!, $after:String) {
  repository(owner:$owner,name:$name) { pullRequest(number:$n) {
    id state headRefOid baseRefOid title body headRefName baseRefName
    reviewRequests(first:100,after:$after) { nodes { id requestedReviewer { ... on User { isViewer } } } pageInfo { hasNextPage endCursor } }
    reviews(states:[PENDING],first:1) { nodes { id viewerDidAuthor } }
  } }
}`;
export const CREATE_DRAFT = `mutation IncomingDraft($pr:ID!,$head:GitObjectID!) {
  addPullRequestReview(input:{pullRequestId:$pr,commitOID:$head}) { pullRequestReview { id } }
}`;
export const ADD_FINDING = `mutation IncomingFinding($review:ID!,$path:String!,$line:Int,$kind:PullRequestReviewThreadSubjectType!,$body:String!) {
  addPullRequestReviewThread(input:{pullRequestReviewId:$review,path:$path,line:$line,side:RIGHT,subjectType:$kind,body:$body}) { thread { id } }
}`;

interface Pull {
  id: string; state: string; headRefOid: string; baseRefOid: string;
  headRefName: string; baseRefName: string; title: string; body: string;
  reviews: { nodes: { id: string; viewerDidAuthor: boolean }[] };
  reviewRequests: {
    nodes: { id: string; requestedReviewer: { isViewer?: boolean } | null }[];
    pageInfo: { hasNextPage: boolean; endCursor: string };
  };
}

export async function currentRequest(client: GitHubClient, repo: string, number: number) {
  const [owner, name] = repo.split("/");
  let after: string | null = null;
  do {
    const data: { repository: { pullRequest: Pull | null } } = await client.graphql(REQUESTED, { owner, name, n: number, after });
    const pr = data.repository.pullRequest;
    if (pr?.state !== "OPEN") return;
    const match = pr.reviewRequests.nodes.find((node) => node.requestedReviewer?.isViewer);
    if (match) return { pr, requestId: match.id, draft: pr.reviews.nodes.find((r) => r.viewerDidAuthor)?.id };
    after = pr.reviewRequests.pageInfo.hasNextPage ? pr.reviewRequests.pageInfo.endCursor : null;
  } while (after);
}
