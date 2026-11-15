import type { Actor, PrNode, RawComment, RawContext, RawReview, RawThread, ReviewState } from "./pr-query";

// Nodos de PR con la forma de la GraphQL API de GitHub (`pr-query.ts`). Los campos y enums son los del
// esquema real; los nombres de los checks, logins y labels son inventados.

const SHA = "a".repeat(40);
export const HEAD_SHA = SHA;
export const OLD_SHA = "b".repeat(40);

export const user = (login: string): Actor => ({ __typename: "User", login, avatarUrl: `https://avatars.example/${login}` });
export const bot = (login: string): Actor => ({ __typename: "Bot", login, avatarUrl: `https://avatars.example/${login}` });

export function prNode(overrides: Partial<PrNode> = {}): PrNode {
  return {
    number: 4251,
    title: "Add the thing",
    url: "https://github.com/acme/api/pull/4251",
    updatedAt: "2026-11-10T12:00:00Z",
    additions: 12,
    deletions: 3,
    commentCount: overrides.comments?.length ?? 0,
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

export function thread(by: Actor | null, body: string, opts: { resolved?: boolean; replies?: [Actor, string][]; at?: string } = {}): RawThread {
  const at = opts.at ?? "2026-11-10T10:00:00Z";
  const comments = [[by, body] as const, ...(opts.replies ?? [])];
  return {
    id: `PRRT_kwDOfixture${nextId++}`,
    isResolved: opts.resolved ?? false,
    comments: { nodes: comments.map(([author, text]) => ({ fullDatabaseId: String(nextId++), body: text, createdAt: at, author })) },
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
