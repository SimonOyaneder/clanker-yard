import type { Actor, PrNode, RawComment, RawContext, RawReview, RawThread, ReviewState } from "./pr-query";
import type { FakeRequest, RecordedResponse } from "./fake-github";

// Nodos de PR con la forma de la GraphQL API de GitHub (`pr-query.ts`) y un responder GraphQL para el
// GitHub falso. Los campos y enums son los del esquema real; los nombres de los checks, logins y labels
// son inventados.

const SHA = "a".repeat(40);
export const HEAD_SHA = SHA;
export const OLD_SHA = "b".repeat(40);

export const user = (login: string): Actor => ({ __typename: "User", login, avatarUrl: `https://avatars.example/${login}` });
export const bot = (login: string): Actor => ({ __typename: "Bot", login, avatarUrl: `https://avatars.example/${login}` });

export function prNode(overrides: Partial<PrNode> = {}): PrNode {
  return {
    number: 4251,
    repo: { name: "api", defaultBranch: "main" },
    state: "OPEN",
    isDraft: false,
    headRefName: "feat/x",
    headRefOid: SHA,
    baseRefName: "main",
    reviewDecision: null,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    mergeCommit: null,
    author: user("octocat"),
    labels: [],
    requestedReviewers: [],
    reviews: [],
    comments: [],
    reviewThreads: [],
    head: { oid: SHA, contexts: [] },
    ...overrides,
  };
}

let nextId = 1000;

export function review(by: Actor | null, state: ReviewState, opts: { body?: string; sha?: string; at?: string } = {}): RawReview {
  return {
    fullDatabaseId: String(nextId++),
    state,
    body: opts.body ?? "",
    submittedAt: opts.at ?? "2026-11-10T10:00:00Z",
    commit: { oid: opts.sha ?? SHA },
    author: by,
  };
}

export function comment(by: Actor | null, body: string, at = "2026-11-10T10:00:00Z"): RawComment {
  return { body, createdAt: at, author: by };
}

export function thread(by: Actor | null, body: string, opts: { resolved?: boolean; replies?: [Actor, string][] } = {}): RawThread {
  const comments = [[by, body] as const, ...(opts.replies ?? [])];
  return {
    isResolved: opts.resolved ?? false,
    comments: { nodes: comments.map(([author, text]) => ({ fullDatabaseId: String(nextId++), body: text, author })) },
  };
}

export const checkRun = (
  name: string,
  outcome: Extract<RawContext, { __typename: "CheckRun" }>["conclusion"] | "IN_PROGRESS",
  isRequired = false,
): RawContext => ({
  __typename: "CheckRun",
  name,
  status: outcome === "IN_PROGRESS" ? "IN_PROGRESS" : "COMPLETED",
  conclusion: outcome === "IN_PROGRESS" ? null : outcome,
  isRequired,
});

export const statusContext = (
  context: string,
  state: Extract<RawContext, { __typename: "StatusContext" }>["state"],
  isRequired = false,
): RawContext => ({ __typename: "StatusContext", context, state, isRequired });

const PAGE = 100;

/** Una conexión de GraphQL (`pageInfo` y `nodes`) con las páginas de a 100, el cursor es el offset. */
function page<T>(all: T[], after: string | undefined) {
  const start = after === undefined ? 0 : Number(after);
  const end = start + PAGE;
  return {
    pageInfo: { hasNextPage: end < all.length, endCursor: end < all.length ? String(end) : null },
    nodes: all.slice(start, end),
  };
}

/**
 * Responde a las queries de `pr-query.ts` con este PR, como el real: la primera página de threads y de
 * checks en `PrDetail` y las siguientes en `PrThreads` y `PrContexts`. `teamRequests` agrega reviews
 * pedidas a equipos, que GitHub entrega sin `login`.
 */
export function prGraphql(node: PrNode, { teamRequests = 0 }: { teamRequests?: number } = {}) {
  const rollup = (after?: string) => ({ statusCheckRollup: { contexts: page(node.head.contexts, after) } });
  const respond = (data: unknown): RecordedResponse => ({
    status: 200,
    headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4990", "x-ratelimit-reset": "1795000000", "x-ratelimit-resource": "graphql" },
    body: { data },
  });

  return (request: FakeRequest): RecordedResponse | undefined => {
    if (request.method !== "POST" || request.path !== "/graphql") return undefined;
    const { query, variables } = request.body as { query: string; variables: Record<string, unknown> };
    const after = variables.after as string | undefined;
    if (query.includes("query PrThreads")) {
      return respond({ node: { reviewThreads: page(node.reviewThreads, after) } });
    }
    if (query.includes("query PrContexts")) {
      return respond({ node: { commits: { nodes: [{ commit: rollup(after) }] } } });
    }
    return respond({
      repository: {
        name: node.repo.name,
        defaultBranchRef: node.repo.defaultBranch === null ? null : { name: node.repo.defaultBranch },
        pullRequest: {
          id: "PR_kwDOexample",
          number: node.number,
          state: node.state,
          isDraft: node.isDraft,
          headRefName: node.headRefName,
          headRefOid: node.headRefOid,
          baseRefName: node.baseRefName,
          reviewDecision: node.reviewDecision,
          mergeable: node.mergeable,
          mergeStateStatus: node.mergeStateStatus,
          mergeCommit: node.mergeCommit,
          author: node.author,
          labels: { nodes: node.labels },
          reviewRequests: {
            nodes: [
              ...node.requestedReviewers.map((requestedReviewer) => ({ requestedReviewer })),
              ...Array.from({ length: teamRequests }, () => ({ requestedReviewer: { __typename: "Team" } })),
            ],
          },
          reviews: { nodes: node.reviews },
          comments: { nodes: node.comments },
          reviewThreads: page(node.reviewThreads, undefined),
          commits: { nodes: [{ commit: { oid: node.head.oid, ...rollup() } }] },
        },
      },
    });
  };
}

/** Lo que responde GitHub cuando el repo o el PR no existen o el token no los ve: 200, `data` nulo y un error NOT_FOUND. */
export const graphqlNotFound: RecordedResponse = {
  status: 200,
  headers: { "x-ratelimit-remaining": "4990", "x-ratelimit-reset": "1795000000", "x-ratelimit-resource": "graphql" },
  body: {
    data: { repository: null },
    errors: [
      {
        type: "NOT_FOUND",
        path: ["repository"],
        locations: [{ line: 3, column: 3 }],
        message: "Could not resolve to a Repository with the name 'octocat/nope'.",
      },
    ],
  },
};
