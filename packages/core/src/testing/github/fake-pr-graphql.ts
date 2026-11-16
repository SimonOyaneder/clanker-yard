import type { FakeRequest, RecordedResponse } from "./fake-github";
import type { PrNode } from "../../github/pr-query";

// El GraphQL de PRs del GitHub falso: responde a las queries de `pr-query.ts` con un `PrNode`, con las
// formas del esquema real. Lo usan los tests del core con un nodo suelto y el simulador del testkit
// con el estado de cada PR.

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

/** Un commit de la branch por defecto para `DefaultBranchChecks`: los checks y statuses de su rollup, o `null` si no tiene. */
export type DefaultBranchCommit = { checks: string[]; statuses: string[] } | null;

/** La respuesta de `DefaultBranchChecks` (`fetchDefaultBranchChecks`) para estos commits, del más nuevo al más viejo. */
export function defaultBranchChecksData(commits: DefaultBranchCommit[]) {
  const context = (commit: NonNullable<DefaultBranchCommit>) => [
    ...commit.checks.map((name) => ({ __typename: "CheckRun", name })),
    ...commit.statuses.map((context) => ({ __typename: "StatusContext", context })),
  ];
  const history = commits.map((commit) => ({ statusCheckRollup: commit === null ? null : { contexts: { nodes: context(commit) } } }));
  return { repository: { defaultBranchRef: { target: { history: { nodes: history } } } } };
}

/**
 * Responde a las queries de `pr-query.ts` con este PR, como el real: la primera página de threads y de
 * checks en `PrDetail` y las siguientes en `PrThreads` y `PrContexts`. `teamRequests` agrega reviews
 * pedidas a equipos, que GitHub entrega sin `login`.
 */
export function prGraphql(
  node: PrNode,
  { teamRequests = 0, id = "PR_kwDOexample", defaultBranchChecks = [] }: { teamRequests?: number; id?: string; defaultBranchChecks?: DefaultBranchCommit[] } = {},
) {
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
    if (query.includes("query DefaultBranchChecks")) return respond(defaultBranchChecksData(defaultBranchChecks));
    return respond({
      repository: {
        name: node.repo.name,
        defaultBranchRef: node.repo.defaultBranch === null ? null : { name: node.repo.defaultBranch },
        pullRequest: {
          id,
          number: node.number,
          title: node.title,
          url: node.url,
          updatedAt: node.updatedAt,
          additions: node.additions,
          deletions: node.deletions,
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
          comments: { totalCount: node.commentCount, nodes: node.comments },
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
