import { createHash } from "node:crypto";
import {
  healthyGitHub,
  prGraphql,
  recorded,
  startFakeGitHub,
  type Actor,
  type FakeGitHub,
  type FakeRequest,
  type PrNode,
  type RawComment,
  type RawContext,
  type RawReview,
  type RecordedResponse,
  type ReviewState,
} from "@clanker/core";
import { parse, valueFromASTUntyped, type FieldNode, type OperationDefinitionNode } from "graphql";
import type { TempGitRepo } from "./git";

// Un GitHub simulado con estado: REST y GraphQL de PRs, reviews, threads, comentarios y checks sobre un
// remoto bare real. Es un servidor HTTP en 127.0.0.1 (no msw): el core real, que corre en otro proceso en
// el E2E y en la demo, lo alcanza con `github.baseUrl`, y las requests pasan por Octokit y fetch de verdad.
// La mensajería es la de la API real (docs.github.com/rest, docs.github.com/graphql): lo que el simulador
// no sabe responder es un 404 o un error de GraphQL que lo dice, nunca un 200 inventado.

/** Primeros 5000 requests de la cuota primaria; GitHub informa `x-ratelimit-*` en cada respuesta. */
const QUOTA_LIMIT = 5000;
/** 2026-11-15 00:00:00 UTC en segundos: el reloj arranca ahí y avanza un segundo por evento. */
const CLOCK_START = Date.UTC(2026, 10, 15) / 1000;
const QUOTA_RESET = 1_795_000_000;
/** El id de usuario que trae el fixture `rate-limited`. */
const USER_ID = 583231;

export type QuotaResource = "core" | "graphql";
/** Resultado de un check, con los nombres de la conclusión de la REST API; `pending` es un check en curso. */
export type CheckOutcome =
  | "pending"
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required"
  | "stale"
  | "startup_failure";
export type StatusState = Extract<RawContext, { __typename: "StatusContext" }>["state"];
export type Who = string | Actor;
export interface Finding {
  body: string;
  path?: string;
  line?: number;
}
export interface ThreadRef {
  /** El node id de GraphQL (`PRRT_...`). */
  id: string;
  /** El id numérico del comentario que abre el thread (REST: `comment_id`). */
  commentId: number;
}

/** Un PR con la forma de `GET /repos/{owner}/{repo}/pulls` (los campos que el simulador mantiene). */
export interface SimPull {
  url: string;
  id: number;
  node_id: string;
  number: number;
  state: "open" | "closed";
  locked: boolean;
  draft: boolean;
  title: string;
  body: string | null;
  user: { login: string; id: number; type: string; site_admin: boolean };
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  head: { label: string; ref: string; sha: string };
  base: { label: string; ref: string; sha: string | undefined };
}

export interface GitHubSimOptions {
  /** Repo temporal cuyo remoto bare es el origin (`tempGitRepo({ remote: true })`). Las branches y los shas salen de él. */
  origin: TempGitRepo;
  /** `owner/repo` que sirve; por defecto el del fixture del PAT (`octocat/secret-project`). */
  repo?: string;
  /** Rama por defecto del repo (la base de los PRs). */
  defaultBranch?: string;
  /** Quien llama (`GET /user`, autor de lo que se escribe por la API). */
  account?: string;
  /** Si viene, solo este token es válido; sin él, cualquier `bearer` no vacío. */
  token?: string;
  /** Login del bot de review (`botLgtm`, `botFindings`). */
  bot?: string;
  /** Prefijo de los comentarios del council (`councilThread`). */
  councilPrefix?: string;
}

export interface SimPr {
  readonly number: number;
  /** El PR como lo sirve GraphQL ahora mismo. */
  node(): PrNode;
  /** El commit al que apunta la branch del PR en el bare, hoy. */
  headSha(): string;
  /** Una review del bot que aprueba: body `LGTM` sobre el head actual (o `sha`). */
  botLgtm(opts?: { body?: string; sha?: string }): void;
  /** Una review del bot con un thread por hallazgo. Devuelve los threads. */
  botFindings(findings: (string | Finding)[], opts?: { body?: string; sha?: string }): ThreadRef[];
  review(by: Who, state: ReviewState, opts?: { body?: string; sha?: string }): void;
  /** Un thread de review abierto por `by`, con su primer comentario. */
  thread(by: Who, body: string, opts?: { path?: string; line?: number; resolved?: boolean }): ThreadRef;
  /** Un thread de council: el primer comentario lleva el prefijo del council (por defecto, de la cuenta). */
  councilThread(body: string, opts?: { by?: Who; path?: string; line?: number }): ThreadRef;
  reply(thread: string, by: Who, body: string): void;
  resolve(thread: string, resolved?: boolean): void;
  /** Un comentario de la conversación del PR. */
  comment(by: Who, body: string): void;
  check(name: string, outcome: CheckOutcome, opts?: { required?: boolean; sha?: string }): void;
  status(context: string, state: StatusState, opts?: { required?: boolean; sha?: string }): void;
  /** Un solo check requerido (`ci`) en verde, rojo o en curso sobre el head actual. */
  ci(outcome: "green" | "red" | "pending", opts?: { name?: string }): void;
  requestReview(login: string): void;
  setDraft(draft: boolean): void;
  /** Mergea el PR: queda cerrado y mergeado, con el head de hoy como commit del merge. */
  merge(): void;
}

export interface GitHubSim {
  baseUrl: string;
  repo: string;
  account: string;
  /** Las requests que llegaron, en orden. */
  requests: FakeRequest[];
  /** Lanza si el PR no existe. */
  pr(number: number): SimPr;
  /** Todos los PRs como los serviría `GET /repos/{owner}/{repo}/pulls`, del más viejo al más nuevo. */
  pulls(): SimPull[];
  /** Abre un PR de una branch del bare sin pasar por la API (como si otro lo hubiera abierto). */
  openPr(input: { head: string; base?: string; title?: string; body?: string; draft?: boolean; author?: Who }): SimPr;
  /** Fija la cuota de un recurso; con `remaining: 0` GitHub corta con el error de cuota primaria. */
  setQuota(resource: QuotaResource, quota: { remaining: number; resetAt?: number }): void;
  /** Desde ahora, todo responde 401 `Bad credentials`. */
  revokeToken(): void;
  close(): Promise<void>;
}

interface SimComment {
  id: number;
  nodeId: string;
  body: string;
  author: Actor;
  createdAt: string;
  path?: string;
  line?: number;
}
interface SimThread {
  id: string;
  resolved: boolean;
  comments: SimComment[];
}
interface SimReview {
  id: number;
  state: ReviewState;
  body: string;
  author: Actor;
  submittedAt: string;
  sha: string;
}
interface PrData {
  number: number;
  nodeId: string;
  title: string;
  body: string | null;
  draft: boolean;
  state: "open" | "closed";
  head: string;
  base: string;
  author: Actor;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** Cuándo se mergeó y con qué commit (`merge()`); `null` mientras no. */
  merged: { at: string; sha: string } | null;
  /** El último sha visto de la branch: GitHub conserva el head de un PR aunque borren la branch. */
  lastSha: string;
  reviews: SimReview[];
  issueComments: SimComment[];
  threads: SimThread[];
  /** Checks por commit: un commit nuevo empieza sin ninguno. */
  contexts: Map<string, RawContext[]>;
  requested: Actor[];
}

const DOCS = "https://docs.github.com/rest";

/** Los inputs de las mutations que el simulador sabe responder, con los campos que acepta el schema de GitHub. */
const MUTATION_INPUTS: Record<string, { type: string; thread: string; fields: string[] }> = {
  resolveReviewThread: { type: "ResolveReviewThreadInput", thread: "threadId", fields: ["threadId", "clientMutationId"] },
  unresolveReviewThread: { type: "UnresolveReviewThreadInput", thread: "threadId", fields: ["threadId", "clientMutationId"] },
  addPullRequestReviewThreadReply: {
    type: "AddPullRequestReviewThreadReplyInput",
    thread: "pullRequestReviewThreadId",
    fields: ["pullRequestReviewThreadId", "pullRequestReviewId", "body", "clientMutationId"],
  },
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}): RecordedResponse => ({ status, headers, body });
const notFound = (): RecordedResponse =>
  json(404, { message: "Not Found", documentation_url: DOCS, status: "404" });
const invalid = (...errors: object[]): RecordedResponse =>
  json(422, {
    message: "Validation Failed",
    errors,
    documentation_url: "https://docs.github.com/rest/pulls/pulls#create-a-pull-request",
    status: "422",
  });

function etagOf(body: unknown): string {
  return `W/"${createHash("md5").update(JSON.stringify(body)).digest("hex")}"`;
}

export async function startGitHubSim(options: GitHubSimOptions): Promise<GitHubSim> {
  const {
    origin,
    repo = "octocat/secret-project",
    defaultBranch = "main",
    account = "octocat",
    token,
    bot = "review-bot[bot]",
    councilPrefix = "[clanker-council] ",
  } = options;
  const [owner, name] = repo.split("/") as [string, string];
  if (origin.remoteDir === undefined) throw new Error("startGitHubSim necesita un tempGitRepo con `remote: true`.");
  const bare = origin.remoteDir;

  const prs: PrData[] = [];
  /** Los checks que exige la branch protection (los que un helper marcó `required`): valen para todo commit. */
  const requiredChecks = new Set<string>();
  const quotas: Record<QuotaResource, { remaining: number; reset: number }> = {
    core: { remaining: QUOTA_LIMIT, reset: QUOTA_RESET },
    graphql: { remaining: QUOTA_LIMIT, reset: QUOTA_RESET },
  };
  let revoked = false;
  let clock = CLOCK_START;
  let nextId = 1000;
  const tick = () => new Date(++clock * 1000).toISOString().replace(".000Z", "Z");
  const id = () => nextId++;

  const viewer: Actor = { __typename: "User", login: account };
  const actor = (who: Who): Actor =>
    typeof who !== "string" ? who : { __typename: who.endsWith("[bot]") ? "Bot" : "User", login: who };
  const withAvatar = (a: Actor): Actor => ({ ...a, avatarUrl: `https://avatars.example/${a.login}` });

  // --- git: el bare es la fuente de verdad de las branches ---

  const git = (...args: string[]) => origin.git("--git-dir", bare, ...args);
  function rev(ref: string): string | undefined {
    try {
      return git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
    } catch {
      return undefined;
    }
  }
  const branchSha = (branch: string) => rev(`refs/heads/${branch}`);
  const headSha = (pr: PrData): string => (pr.lastSha = branchSha(pr.head) ?? pr.lastSha);
  const commitsAhead = (base: string, head: string) => Number(git("rev-list", "--count", `${base}..${head}`));
  /** Si fusionar head en base choca; `git merge-tree` sale con 1 cuando hay conflictos. */
  function conflicts(pr: PrData): boolean {
    const base = branchSha(pr.base);
    if (base === undefined) return false;
    try {
      git("merge-tree", "--write-tree", "--quiet", base, headSha(pr));
      return false;
    } catch (error) {
      if ((error as { cause?: { status?: number } }).cause?.status === 1) return true;
      throw error;
    }
  }

  // --- el modelo en lo que lee GraphQL ---

  function contextsOf(pr: PrData, sha: string): RawContext[] {
    return pr.contexts.get(sha) ?? [];
  }

  function reviewDecision(pr: PrData): PrNode["reviewDecision"] {
    const latest = new Map<string, ReviewState>();
    for (const r of pr.reviews) if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED") latest.set(r.author.login, r.state);
    const states = [...latest.values()];
    if (states.includes("CHANGES_REQUESTED")) return "CHANGES_REQUESTED";
    return states.includes("APPROVED") ? "APPROVED" : null;
  }

  /** Aproxima lo que calcula GitHub: draft, conflicto, checks requeridos que faltan, checks que fallan. */
  function mergeability(pr: PrData): Pick<PrNode, "mergeable" | "mergeStateStatus"> {
    const dirty = conflicts(pr);
    const contexts = contextsOf(pr, headSha(pr));
    const passing = (c: RawContext) =>
      c.__typename === "CheckRun" ? c.status === "COMPLETED" && ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion ?? "") : c.state === "SUCCESS";
    const mergeable = dirty ? "CONFLICTING" : "MERGEABLE";
    if (pr.draft) return { mergeable, mergeStateStatus: "DRAFT" };
    if (dirty) return { mergeable, mergeStateStatus: "DIRTY" };
    const name = (c: RawContext) => (c.__typename === "CheckRun" ? c.name : c.context);
    const missing = [...requiredChecks].some((required) => !contexts.some((c) => name(c) === required));
    if (missing || contexts.some((c) => c.isRequired && !passing(c))) return { mergeable, mergeStateStatus: "BLOCKED" };
    if (contexts.some((c) => !passing(c))) return { mergeable, mergeStateStatus: "UNSTABLE" };
    return { mergeable, mergeStateStatus: "CLEAN" };
  }

  const rawThread = (t: SimThread) => ({
    id: t.id,
    isResolved: t.resolved,
    comments: {
      nodes: t.comments.map((c) => ({
        id: c.nodeId,
        fullDatabaseId: String(c.id),
        body: c.body,
        author: withAvatar(c.author),
        createdAt: c.createdAt,
        ...(c.path === undefined ? {} : { path: c.path, line: c.line }),
      })),
    },
  });

  function node(pr: PrData): PrNode {
    const sha = headSha(pr);
    return {
      number: pr.number,
      repo: { name, defaultBranch },
      state: pr.merged ? "MERGED" : pr.state === "open" ? "OPEN" : "CLOSED",
      isDraft: pr.draft,
      headRefName: pr.head,
      headRefOid: sha,
      baseRefName: pr.base,
      reviewDecision: reviewDecision(pr),
      ...mergeability(pr),
      mergeCommit: pr.merged ? { oid: pr.merged.sha } : null,
      author: withAvatar(pr.author),
      labels: [],
      requestedReviewers: pr.requested.map(withAvatar),
      reviews: pr.reviews.map(
        (r): RawReview => ({
          fullDatabaseId: String(r.id),
          state: r.state,
          body: r.body,
          submittedAt: r.submittedAt,
          commit: { oid: r.sha },
          author: withAvatar(r.author),
        }),
      ),
      comments: pr.issueComments.map((c): RawComment => ({ body: c.body, createdAt: c.createdAt, author: withAvatar(c.author) })),
      reviewThreads: pr.threads.map(rawThread),
      head: { oid: sha, contexts: contextsOf(pr, sha) },
    };
  }

  // --- el modelo en lo que lee REST ---

  const userIds = new Map<string, number>();
  const userJson = (a: Actor) => {
    if (!userIds.has(a.login)) userIds.set(a.login, USER_ID + userIds.size);
    return { login: a.login, id: userIds.get(a.login)!, type: a.__typename, site_admin: false };
  };
  const pullJson = (pr: PrData): SimPull => ({
    url: `https://api.github.com/repos/${repo}/pulls/${pr.number}`,
    id: 5_000_000 + pr.number,
    node_id: pr.nodeId,
    number: pr.number,
    state: pr.state,
    locked: false,
    draft: pr.draft,
    title: pr.title,
    body: pr.body,
    user: userJson(pr.author),
    html_url: `https://github.com/${repo}/pull/${pr.number}`,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.closedAt,
    merged_at: pr.merged?.at ?? null,
    head: { label: `${owner}:${pr.head}`, ref: pr.head, sha: headSha(pr) },
    base: { label: `${owner}:${pr.base}`, ref: pr.base, sha: branchSha(pr.base) },
  });
  const commentJson = (c: SimComment, pr: PrData) => ({
    id: c.id,
    node_id: c.nodeId,
    body: c.body,
    user: userJson(c.author),
    created_at: c.createdAt,
    updated_at: c.createdAt,
    html_url: `https://github.com/${repo}/pull/${pr.number}#issuecomment-${c.id}`,
  });
  const reviewCommentJson = (c: SimComment, pr: PrData, inReplyTo?: number) => ({
    id: c.id,
    node_id: c.nodeId,
    body: c.body,
    user: userJson(c.author),
    created_at: c.createdAt,
    updated_at: c.createdAt,
    path: c.path ?? null,
    commit_id: headSha(pr),
    pull_request_url: `https://api.github.com/repos/${repo}/pulls/${pr.number}`,
    html_url: `https://github.com/${repo}/pull/${pr.number}#discussion_r${c.id}`,
    ...(inReplyTo === undefined ? {} : { in_reply_to_id: inReplyTo }),
  });

  // --- escribir en el modelo (la API y los helpers comparten esto) ---

  const newComment = (by: Who, body: string, extra: { path?: string; line?: number } = {}): SimComment => {
    const n = id();
    return { id: n, nodeId: `PRRC_kwDOfake${n}`, body, author: actor(by), createdAt: tick(), ...extra };
  };
  const newThread = (first: SimComment, resolved = false): SimThread => ({ id: `PRRT_kwDOfake${first.id}`, resolved, comments: [first] });

  function createPr(input: { head: string; base: string; title: string; body: string | null; draft: boolean; author: Actor }): PrData {
    const number = prs.length + 1;
    const at = tick();
    const sha = branchSha(input.head);
    if (sha === undefined) throw new Error(`La branch ${input.head} no existe en el remoto bare.`);
    const pr: PrData = {
      number,
      nodeId: `PR_kwDOfake${number}`,
      title: input.title,
      body: input.body,
      draft: input.draft,
      state: "open",
      head: input.head,
      base: input.base,
      author: input.author,
      createdAt: at,
      updatedAt: at,
      closedAt: null,
      merged: null,
      lastSha: sha,
      reviews: [],
      issueComments: [],
      threads: [],
      contexts: new Map(),
      requested: [],
    };
    prs.push(pr);
    return pr;
  }

  const findPr = (number: number) => prs.find((p) => p.number === number);
  const findThread = (threadId: string) => {
    for (const pr of prs) {
      const thread = pr.threads.find((t) => t.id === threadId);
      if (thread) return { pr, thread };
    }
    return undefined;
  };

  function setContext(pr: PrData, sha: string, context: RawContext) {
    const key = (c: RawContext) => (c.__typename === "CheckRun" ? `check:${c.name}` : `status:${c.context}`);
    const rest = contextsOf(pr, sha).filter((c) => key(c) !== key(context));
    pr.contexts.set(sha, [...rest, context]);
  }

  function handle(pr: PrData): SimPr {
    const addReview = (by: Actor, state: ReviewState, body: string, sha: string) =>
      pr.reviews.push({ id: id(), state, body, author: by, submittedAt: tick(), sha });
    const addThread = (by: Who, body: string, opts: { path?: string; line?: number; resolved?: boolean }): ThreadRef => {
      const first = newComment(by, body, { path: opts.path ?? "src/index.ts", line: opts.line ?? 1 });
      pr.threads.push(newThread(first, opts.resolved));
      return { id: `PRRT_kwDOfake${first.id}`, commentId: first.id };
    };
    const threadOf = (threadId: string) => {
      const thread = pr.threads.find((t) => t.id === threadId);
      if (!thread) throw new Error(`El PR #${pr.number} no tiene el thread ${threadId}.`);
      return thread;
    };
    const check: SimPr["check"] = (checkName, outcome, { required = requiredChecks.has(checkName), sha = headSha(pr) } = {}) => {
      if (required) requiredChecks.add(checkName);
      setContext(pr, sha, {
        __typename: "CheckRun",
        name: checkName,
        status: outcome === "pending" ? "IN_PROGRESS" : "COMPLETED",
        conclusion: outcome === "pending" ? null : (outcome.toUpperCase() as Exclude<Extract<RawContext, { __typename: "CheckRun" }>["conclusion"], null>),
        isRequired: required,
      });
    };
    return {
      number: pr.number,
      node: () => node(pr),
      headSha: () => headSha(pr),
      botLgtm: ({ body = "LGTM", sha } = {}) => void addReview(actor(bot), "APPROVED", body, sha ?? headSha(pr)),
      botFindings(findings, { body = "", sha } = {}) {
        addReview(actor(bot), "COMMENTED", body, sha ?? headSha(pr));
        return findings.map((f) => {
          const finding = typeof f === "string" ? { body: f } : f;
          return addThread(bot, finding.body, finding);
        });
      },
      review: (by, state, { body = "", sha } = {}) => void addReview(actor(by), state, body, sha ?? headSha(pr)),
      thread: (by, body, opts = {}) => addThread(by, body, opts),
      councilThread: (body, { by = viewer, ...opts } = {}) => addThread(by, `${councilPrefix}${body}`, opts),
      reply(threadId, by, body) {
        const thread = threadOf(threadId);
        thread.comments.push(newComment(by, body, { path: thread.comments[0]!.path, line: thread.comments[0]!.line }));
      },
      resolve(threadId, resolved = true) {
        threadOf(threadId).resolved = resolved;
      },
      comment: (by, body) => void pr.issueComments.push(newComment(by, body)),
      check,
      status(context, state, { required = requiredChecks.has(context), sha = headSha(pr) } = {}) {
        if (required) requiredChecks.add(context);
        setContext(pr, sha, { __typename: "StatusContext", context, state, isRequired: required });
      },
      ci(outcome, { name: checkName = "ci" } = {}) {
        const conclusion = { green: "success", red: "failure", pending: "pending" } as const;
        check(checkName, conclusion[outcome], { required: true });
      },
      requestReview: (login) => void pr.requested.push(actor(login)),
      setDraft(draft) {
        pr.draft = draft;
      },
      merge() {
        pr.state = "closed";
        pr.closedAt = pr.merged?.at ?? tick();
        pr.merged ??= { at: pr.closedAt, sha: headSha(pr) };
      },
    };
  }

  // --- REST ---

  /** `pr` busca el PR del primer grupo de la ruta (`/pulls/:n`). */
  type Route = (match: RegExpMatchArray, request: FakeRequest, pr: () => PrData | undefined) => RecordedResponse;
  const routes: [method: string, path: RegExp, handler: Route][] = [
    [
      "GET",
      /^\/pulls$/,
      (_, { query }) => {
        const { state = "open", head, base, per_page = "30", page = "1" } = query;
        const found = prs
          .filter((p) => (state === "all" || p.state === state) && (head === undefined || `${owner}:${p.head}` === head) && (base === undefined || p.base === base))
          .reverse();
        const size = Number(per_page);
        return json(200, found.slice((Number(page) - 1) * size, Number(page) * size).map(pullJson));
      },
    ],
    [
      "POST",
      /^\/pulls$/,
      (_, { body }) => {
        const input = (body ?? {}) as { title?: string; head?: string; base?: string; body?: string; draft?: boolean };
        if (!input.title) return invalid({ resource: "PullRequest", field: "title", code: "missing_field" });
        const head = input.head?.replace(`${owner}:`, "");
        if (!head || branchSha(head) === undefined) return invalid({ resource: "PullRequest", field: "head", code: "invalid" });
        if (!input.base || branchSha(input.base) === undefined) return invalid({ resource: "PullRequest", field: "base", code: "invalid" });
        if (prs.some((p) => p.state === "open" && p.head === head && p.base === input.base)) {
          return invalid({ resource: "PullRequest", code: "custom", message: `A pull request already exists for ${owner}:${head}.` });
        }
        if (commitsAhead(input.base, head) === 0) {
          return invalid({ resource: "PullRequest", code: "custom", message: `No commits between ${input.base} and ${head}` });
        }
        const pr = createPr({ head, base: input.base, title: input.title, body: input.body ?? null, draft: input.draft ?? false, author: viewer });
        return json(201, pullJson(pr));
      },
    ],
    [
      "GET",
      /^\/pulls\/(\d+)$/,
      (_, __, pr) => {
        const found = pr();
        if (!found) return notFound();
        const { mergeable, mergeStateStatus } = mergeability(found);
        return json(200, {
          ...pullJson(found),
          merged: found.merged !== null,
          mergeable: mergeable === "MERGEABLE",
          mergeable_state: mergeStateStatus.toLowerCase(),
        });
      },
    ],
    [
      "PATCH",
      /^\/pulls\/(\d+)$/,
      (_, { body }, pr) => {
        const found = pr();
        if (!found) return notFound();
        const input = (body ?? {}) as { title?: string; body?: string; state?: string; base?: string };
        if (input.base !== undefined && branchSha(input.base) === undefined) return invalid({ resource: "PullRequest", field: "base", code: "invalid" });
        if (input.state !== undefined && input.state !== "open" && input.state !== "closed") {
          return invalid({ resource: "PullRequest", field: "state", code: "invalid" });
        }
        if (input.title !== undefined) found.title = input.title;
        if (input.body !== undefined) found.body = input.body;
        if (input.base !== undefined) found.base = input.base;
        if (input.state !== undefined) {
          found.state = input.state;
          found.closedAt = input.state === "closed" ? tick() : null;
        }
        found.updatedAt = tick();
        return json(200, pullJson(found));
      },
    ],
    [
      "GET",
      /^\/issues\/(\d+)\/comments$/,
      (_, __, pr) => {
        const found = pr();
        return found ? json(200, found.issueComments.map((c) => commentJson(c, found))) : notFound();
      },
    ],
    [
      "POST",
      /^\/issues\/(\d+)\/comments$/,
      (_, { body }, pr) => {
        const found = pr();
        if (!found) return notFound();
        const text = (body as { body?: string } | undefined)?.body;
        if (!text) return invalid({ resource: "IssueComment", field: "body", code: "missing_field" });
        const comment = newComment(viewer, text);
        found.issueComments.push(comment);
        found.updatedAt = comment.createdAt;
        return json(201, commentJson(comment, found));
      },
    ],
    [
      "POST",
      /^\/pulls\/(\d+)\/comments\/(\d+)\/replies$/,
      (match, { body }, pr) => {
        const found = pr();
        const thread = found?.threads.find((t) => t.comments.some((c) => c.id === Number(match[2])));
        if (!found || !thread) return notFound();
        const text = (body as { body?: string } | undefined)?.body;
        if (!text) return invalid({ resource: "PullRequestReviewComment", field: "body", code: "missing_field" });
        const first = thread.comments[0]!;
        const reply = newComment(viewer, text, { path: first.path, line: first.line });
        thread.comments.push(reply);
        return json(201, reviewCommentJson(reply, found, first.id));
      },
    ],
    [
      "GET",
      /^\/commits\/(.+)\/check-runs$/,
      (match) => {
        const sha = rev(decodeURIComponent(match[1]!));
        if (sha === undefined) return json(422, { message: `No commit found for SHA: ${match[1]}`, documentation_url: DOCS, status: "422" });
        const runs = prs
          .flatMap((p) => contextsOf(p, sha))
          .filter((c): c is Extract<RawContext, { __typename: "CheckRun" }> => c.__typename === "CheckRun");
        const unique = [...new Map(runs.map((c) => [c.name, c])).values()];
        return json(200, {
          total_count: unique.length,
          check_runs: unique.map((c, i) => ({
            id: 8_000_000 + i,
            name: c.name,
            head_sha: sha,
            status: c.status.toLowerCase(),
            conclusion: c.conclusion?.toLowerCase() ?? null,
          })),
        });
      },
    ],
    [
      "GET",
      /^\/commits\/(.+)\/status$/,
      (match) => {
        const sha = rev(decodeURIComponent(match[1]!));
        if (sha === undefined) return json(422, { message: `No commit found for SHA: ${match[1]}`, documentation_url: DOCS, status: "422" });
        const statuses = [
          ...new Map(
            prs
              .flatMap((p) => contextsOf(p, sha))
              .flatMap((c) => (c.__typename === "StatusContext" ? [[c.context, c] as const] : [])),
          ).values(),
        ];
        const states = statuses.map((s) => s.state.toLowerCase());
        const state = states.some((s) => s === "failure" || s === "error") ? "failure" : states.includes("pending") ? "pending" : "success";
        return json(200, {
          state: statuses.length === 0 ? "pending" : state,
          sha,
          total_count: statuses.length,
          statuses: statuses.map((s) => ({ context: s.context, state: s.state.toLowerCase() })),
        });
      },
    ],
  ];

  function rest(request: FakeRequest): RecordedResponse | undefined {
    const repoRoute = request.path.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (!repoRoute) return healthyGitHub()(request);
    if (`${repoRoute[1]}/${repoRoute[2]}` !== repo) return notFound();
    const sub = repoRoute[3] ?? "";
    for (const [method, path, handler] of routes) {
      const match = sub.match(path);
      if (method === request.method && match) return handler(match, request, () => findPr(Number(match[1])));
    }
    // Sondas del PAT (`commits`, `issues`) y lo que el simulador no modela: la respuesta grabada.
    return healthyGitHub()(request) ?? notFound();
  }

  // --- GraphQL ---

  const graphqlNotFoundAt = (data: unknown, path: string[], message: string): RecordedResponse =>
    json(200, { data, errors: [{ type: "NOT_FOUND", path, locations: [{ line: 3, column: 3 }], message }] });
  const unsupported = (what: string): RecordedResponse =>
    json(200, { errors: [{ type: "SIMULATOR_UNSUPPORTED", message: `El GitHub simulado no sabe responder ${what}: agrégalo a github-sim.ts.` }] });

  function mutate(field: FieldNode, variables: Record<string, unknown>): { key: string; data?: unknown; error?: object; invalid?: string } {
    const key = field.alias?.value ?? field.name.value;
    const shape = MUTATION_INPUTS[field.name.value];
    if (!shape) throw new Error(`la mutation ${field.name.value}`);
    const args = Object.fromEntries((field.arguments ?? []).map((a) => [a.name.value, valueFromASTUntyped(a.value, variables)]));
    const input = (args.input ?? {}) as Record<string, string>;
    // GitHub valida el input contra el schema antes de ejecutar: un campo de otra mutation es un error del documento.
    const unknown = Object.keys(input).find((k) => !shape.fields.includes(k));
    if (unknown) return { key, invalid: `InputObject '${shape.type}' doesn't accept argument '${unknown}'` };
    const threadId = input[shape.thread];
    if (!threadId) return { key, invalid: `Argument '${shape.thread}' on InputObject '${shape.type}' is required. Expected type ID!` };
    const found = findThread(threadId);
    if (!found) {
      return { key, error: { type: "NOT_FOUND", path: [key], message: `Could not resolve to a node with the global id of '${threadId}'.` } };
    }
    if (field.name.value === "addPullRequestReviewThreadReply") {
      const first = found.thread.comments[0]!;
      const reply = newComment(viewer, input.body ?? "", { path: first.path, line: first.line });
      found.thread.comments.push(reply);
      return { key, data: { comment: { id: reply.nodeId, fullDatabaseId: String(reply.id), body: reply.body, createdAt: reply.createdAt, author: withAvatar(viewer) } } };
    }
    found.thread.resolved = field.name.value === "resolveReviewThread";
    return { key, data: { thread: rawThread(found.thread) } };
  }

  function graphql(request: FakeRequest): RecordedResponse {
    const { query, variables = {} } = (request.body ?? {}) as { query?: string; variables?: Record<string, unknown> };
    if (!query) return json(400, { message: "Problems parsing JSON", documentation_url: "https://docs.github.com/graphql", status: "400" });
    let operation: OperationDefinitionNode | undefined;
    try {
      operation = parse(query).definitions.find((d): d is OperationDefinitionNode => d.kind === "OperationDefinition");
    } catch (error) {
      return json(200, { errors: [{ message: (error as Error).message }] });
    }
    if (!operation) return unsupported("un documento sin operación");

    if (operation.operation === "mutation") {
      const data: Record<string, unknown> = {};
      const errors: object[] = [];
      for (const field of operation.selectionSet.selections) {
        if (field.kind !== "Field") return unsupported("fragmentos en una mutation");
        try {
          const result = mutate(field, variables);
          if (result.invalid) return json(200, { errors: [{ message: result.invalid }] });
          data[result.key] = result.data ?? null;
          if (result.error) errors.push(result.error);
        } catch (error) {
          return unsupported((error as Error).message);
        }
      }
      return json(200, errors.length === 0 ? { data } : { data, errors });
    }

    const queryName = operation.name?.value;
    if (queryName === "PrDetail") {
      const { owner: o, name: n, number } = variables as { owner: string; name: string; number: number };
      if (`${o}/${n}` !== repo) {
        return graphqlNotFoundAt({ repository: null }, ["repository"], `Could not resolve to a Repository with the name '${o}/${n}'.`);
      }
      const pr = findPr(number);
      if (!pr) {
        return graphqlNotFoundAt({ repository: { pullRequest: null } }, ["repository", "pullRequest"], `Could not resolve to a PullRequest with the number of ${number}.`);
      }
      return prGraphql(node(pr), { id: pr.nodeId })(request)!;
    }
    if (queryName === "PrThreads" || queryName === "PrContexts") {
      const pr = prs.find((p) => p.nodeId === variables.id);
      if (!pr) return graphqlNotFoundAt({ node: null }, ["node"], `Could not resolve to a node with the global id of '${String(variables.id)}'.`);
      return prGraphql(node(pr), { id: pr.nodeId })(request)!;
    }
    return unsupported(`la query ${queryName ?? "(sin nombre)"}`);
  }

  // --- el servidor: auth, cuota, ETags ---

  function respond(request: FakeRequest): RecordedResponse {
    const resource: QuotaResource = request.path === "/graphql" ? "graphql" : "core";
    const bearer = request.authorization?.match(/^(?:bearer|token) (.+)$/i)?.[1];
    if (revoked || !bearer || (token !== undefined && bearer !== token)) {
      return withQuota(recorded("user.bad-credentials"), resource, false);
    }
    const quota = quotas[resource];
    if (quota.remaining <= 0) return limited(resource);

    const response =
      request.path === "/graphql" && request.method === "POST"
        ? graphql(request)
        : (rest(request) ?? notFound());

    if (request.method === "GET" && response.status === 200) {
      const etag = etagOf(response.body);
      if (request.ifNoneMatch === etag) return withQuota({ status: 304, headers: { etag }, body: undefined }, resource, false);
      return withQuota({ ...response, headers: { ...response.headers, etag } }, resource, true);
    }
    return withQuota(response, resource, true);
  }

  function withQuota(response: RecordedResponse, resource: QuotaResource, counts: boolean): RecordedResponse {
    const quota = quotas[resource];
    if (counts) quota.remaining = Math.max(0, quota.remaining - 1);
    return {
      ...response,
      headers: {
        ...response.headers,
        "x-ratelimit-limit": String(QUOTA_LIMIT),
        "x-ratelimit-remaining": String(quota.remaining),
        "x-ratelimit-used": String(QUOTA_LIMIT - quota.remaining),
        "x-ratelimit-reset": String(quota.reset),
        "x-ratelimit-resource": resource,
      },
    };
  }

  /** Cuota primaria agotada: REST 403, GraphQL 200 con `errors` (docs: "Rate limits for the REST API" y "...for the GraphQL API"). */
  function limited(resource: QuotaResource): RecordedResponse {
    if (resource === "graphql") {
      return withQuota(json(200, { errors: [{ type: "RATE_LIMITED", message: `API rate limit already exceeded for user ID ${USER_ID}.` }] }), resource, false);
    }
    return withQuota(json(403, { message: `API rate limit exceeded for user ID ${USER_ID}.`, documentation_url: `${DOCS}/overview/resources-in-the-rest-api#rate-limiting`, status: "403" }), resource, false);
  }

  const server: FakeGitHub = await startFakeGitHub(respond);
  return {
    baseUrl: server.baseUrl,
    repo,
    account,
    requests: server.requests,
    pr(number) {
      const pr = findPr(number);
      if (!pr) throw new Error(`El GitHub simulado no tiene el PR #${number}.`);
      return handle(pr);
    },
    pulls: () => prs.map(pullJson),
    openPr({ head, base = defaultBranch, title = head, body = null, draft = false, author = viewer }) {
      return handle(createPr({ head, base, title, body, draft, author: actor(author) }));
    },
    setQuota(resource, { remaining, resetAt }) {
      quotas[resource] = { remaining, reset: resetAt === undefined ? quotas[resource].reset : Math.floor(resetAt / 1000) };
    },
    revokeToken() {
      revoked = true;
    },
    close: () => server.close(),
  };
}
