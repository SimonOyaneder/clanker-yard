import { GraphqlResponseError } from "@octokit/graphql";
import type { GitHubClient } from "./client";

// La query de detalle de un PR (`docs/design.html#d-ops`, "CodeHost: polling con ETags"). Los nombres de
// campos y enums son los de la GraphQL API de GitHub (docs.github.com/en/graphql/reference).

export interface Actor {
  /** `User`, `Bot`, `Organization`, `Mannequin`... */
  __typename: string;
  login: string;
  avatarUrl?: string;
}

interface Page<T> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: T[];
}

export type ReviewState = "PENDING" | "COMMENTED" | "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED";

export interface RawReview {
  /** BigInt: GitHub lo serializa como string. */
  fullDatabaseId: string;
  state: ReviewState;
  body: string;
  submittedAt: string | null;
  commit: { oid: string } | null;
  /** `null` si la cuenta ya no existe. */
  author: Actor | null;
}

export interface RawComment {
  body: string;
  createdAt: string;
  author: Actor | null;
}

export interface RawThread {
  isResolved: boolean;
  /** Solo el primero: es el que abre el thread y dice de quién es. */
  comments: { nodes: { fullDatabaseId: string; body: string; author: Actor | null }[] };
}

export type RawContext =
  | {
      __typename: "CheckRun";
      name: string;
      status: "COMPLETED" | "IN_PROGRESS" | "PENDING" | "QUEUED" | "REQUESTED" | "WAITING";
      conclusion:
        | "ACTION_REQUIRED"
        | "CANCELLED"
        | "FAILURE"
        | "NEUTRAL"
        | "SKIPPED"
        | "STALE"
        | "STARTUP_FAILURE"
        | "SUCCESS"
        | "TIMED_OUT"
        | null;
      isRequired: boolean;
    }
  | {
      __typename: "StatusContext";
      context: string;
      state: "ERROR" | "EXPECTED" | "FAILURE" | "PENDING" | "SUCCESS";
      isRequired: boolean;
    };

/** Un PR con todo lo que `buildPrState` lee, ya con todas las páginas de threads y de checks. */
export interface PrNode {
  number: number;
  repo: { name: string; defaultBranch: string | null };
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus: "BEHIND" | "BLOCKED" | "CLEAN" | "DIRTY" | "DRAFT" | "HAS_HOOKS" | "UNKNOWN" | "UNSTABLE";
  mergeCommit: { oid: string } | null;
  author: Actor | null;
  labels: { name: string; color: string; description: string | null }[];
  /** Quiénes tienen una review pedida pendiente; un equipo (`Team`) no trae `login` y no está aquí. */
  requestedReviewers: Actor[];
  /** Las últimas 100. */
  reviews: RawReview[];
  /** Los últimos 100 comentarios de la conversación. */
  comments: RawComment[];
  reviewThreads: RawThread[];
  /** Los checks del último commit (el head). */
  head: { oid: string; contexts: RawContext[] };
}

/** El repo o el PR no existen, o la cuenta no los ve (GitHub no distingue). */
export class PrNotFoundError extends Error {
  constructor(repo: string, number: number) {
    super(`No existe el PR ${repo}#${number} o la cuenta no lo ve.`);
  }
}

const PAGE_SIZE = 100;
const PAGE_INFO = "pageInfo { hasNextPage endCursor }";
const THREAD = `isResolved comments(first: 1) { nodes { fullDatabaseId body author { __typename login } } }`;
const CONTEXT = `__typename
  ... on CheckRun { name status conclusion isRequired(pullRequestNumber: $number) }
  ... on StatusContext { context state isRequired(pullRequestNumber: $number) }`;
const ACTOR = "__typename login avatarUrl";

const PR_QUERY = `
query PrDetail($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    name
    defaultBranchRef { name }
    pullRequest(number: $number) {
      id number state isDraft headRefName headRefOid baseRefName reviewDecision mergeable mergeStateStatus
      mergeCommit { oid }
      author { ${ACTOR} }
      labels(first: ${PAGE_SIZE}) { nodes { name color description } }
      reviewRequests(first: ${PAGE_SIZE}) {
        nodes { requestedReviewer { __typename ... on User { login avatarUrl } ... on Bot { login avatarUrl } } }
      }
      reviews(last: ${PAGE_SIZE}) {
        nodes { fullDatabaseId state body submittedAt commit { oid } author { ${ACTOR} } }
      }
      comments(last: ${PAGE_SIZE}) { nodes { body createdAt author { ${ACTOR} } } }
      reviewThreads(first: ${PAGE_SIZE}) { ${PAGE_INFO} nodes { ${THREAD} } }
      commits(last: 1) {
        nodes { commit { oid statusCheckRollup { contexts(first: ${PAGE_SIZE}) { ${PAGE_INFO} nodes { ${CONTEXT} } } } } }
      }
    }
  }
}`;

// Las páginas que siguen se piden por el id del PR: el resto de la query no se repite.
const MORE_THREADS = `
query PrThreads($id: ID!, $after: String!) {
  node(id: $id) { ... on PullRequest { reviewThreads(first: ${PAGE_SIZE}, after: $after) { ${PAGE_INFO} nodes { ${THREAD} } } } }
}`;
const MORE_CONTEXTS = `
query PrContexts($id: ID!, $number: Int!, $after: String!) {
  node(id: $id) {
    ... on PullRequest {
      commits(last: 1) {
        nodes { commit { statusCheckRollup { contexts(first: ${PAGE_SIZE}, after: $after) { ${PAGE_INFO} nodes { ${CONTEXT} } } } } }
      }
    }
  }
}`;

interface RawPr {
  id: string;
  number: number;
  state: PrNode["state"];
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  reviewDecision: PrNode["reviewDecision"];
  mergeable: PrNode["mergeable"];
  mergeStateStatus: PrNode["mergeStateStatus"];
  mergeCommit: PrNode["mergeCommit"];
  author: Actor | null;
  labels: { nodes: PrNode["labels"] };
  reviewRequests: { nodes: { requestedReviewer: (Pick<Actor, "__typename"> & Partial<Actor>) | null }[] };
  reviews: { nodes: RawReview[] };
  comments: { nodes: RawComment[] };
  reviewThreads: Page<RawThread>;
  commits: { nodes: { commit: { oid: string; statusCheckRollup: { contexts: Page<RawContext> } | null } }[] };
}

/**
 * Trae un PR con una query de detalle y completa con más requests las páginas de threads y de checks
 * que no entraron en la primera (los conteos del PrState no pueden quedar a medias). Lanza
 * `PrNotFoundError` si no existe; un corte por cuota o un 401 salen como los lanza el cliente.
 */
export async function fetchPr(client: GitHubClient, repo: { owner: string; name: string }, number: number): Promise<PrNode> {
  let data: { repository: { name: string; defaultBranchRef: { name: string } | null; pullRequest: RawPr } };
  try {
    data = await client.graphql(PR_QUERY, { owner: repo.owner, name: repo.name, number });
  } catch (error) {
    if (error instanceof GraphqlResponseError && error.errors?.some((e) => e.type === "NOT_FOUND")) {
      throw new PrNotFoundError(`${repo.owner}/${repo.name}`, number);
    }
    throw error;
  }
  const { pullRequest: pr } = data.repository;
  // Un PR sin commits (el head quedó igual a la base) no tiene checks.
  const head = pr.commits.nodes.at(0)?.commit;

  const threads = await allPages(pr.reviewThreads, async (after) => {
    const more = await client.graphql<{ node: { reviewThreads: Page<RawThread> } }>(MORE_THREADS, { id: pr.id, after });
    return more.node.reviewThreads;
  });
  const contexts = await allPages(head?.statusCheckRollup?.contexts, async (after) => {
    const more = await client.graphql<{ node: { commits: RawPr["commits"] } }>(MORE_CONTEXTS, { id: pr.id, number, after });
    const rollup = more.node.commits.nodes.at(0)?.commit.statusCheckRollup;
    // El head se movió entre las dos requests: los checks de este commit ya no se pueden completar.
    if (!rollup) throw new Error(`El head de ${repo.owner}/${repo.name}#${number} cambió mientras se leía: vuelve a pedir el PR.`);
    return rollup.contexts;
  });

  return {
    number: pr.number,
    repo: { name: data.repository.name, defaultBranch: data.repository.defaultBranchRef?.name ?? null },
    state: pr.state,
    isDraft: pr.isDraft,
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid,
    baseRefName: pr.baseRefName,
    reviewDecision: pr.reviewDecision,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    mergeCommit: pr.mergeCommit,
    author: pr.author,
    labels: pr.labels.nodes,
    requestedReviewers: pr.reviewRequests.nodes.flatMap(({ requestedReviewer: r }) => (r?.login ? [r as Actor] : [])),
    reviews: pr.reviews.nodes,
    comments: pr.comments.nodes,
    reviewThreads: threads,
    head: { oid: head?.oid ?? pr.headRefOid, contexts },
  };
}

async function allPages<T>(first: Page<T> | undefined, next: (after: string) => Promise<Page<T>>): Promise<T[]> {
  if (!first) return [];
  const all = [...first.nodes];
  for (let page = first; page.pageInfo.hasNextPage; ) {
    page = await next(page.pageInfo.endCursor!);
    all.push(...page.nodes);
  }
  return all;
}
