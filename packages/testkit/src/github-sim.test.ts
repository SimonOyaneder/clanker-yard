import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConnections,
  createDefs,
  createFileSecrets,
  createPacks,
  createPrs,
  openStore,
  PrNotFoundError,
  type Connections,
  type Packs,
  type Store,
} from "@clanker/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tempGitRepo, type TempGitRepo } from "./git";
import { startGitHubSim, type GitHubSim } from "./github-sim";

vi.setConfig({ testTimeout: 20_000 });

const TOKEN = "github_pat_UNIQUE-0123456789";
const REPO = "octocat/secret-project";
const BRANCH = "cla-45";

let dir: string;
let store: Store;
let origin: TempGitRepo;
let sim: GitHubSim;
let connections: Connections;
let packs: Packs;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "clanker-sim-"));
  store = openStore({ path: ":memory:" });
  origin = tempGitRepo({
    remote: true,
    commits: [{ message: "chore: base", files: { "a.txt": "a\n" } }],
    branches: {
      [BRANCH]: [{ message: "feat: change", files: { "b.txt": "b\n" } }],
      "sin-cambios": [],
    },
  });
  sim = await startGitHubSim({ origin, token: TOKEN });
  connections = createConnections(store, createFileSecrets({ dir }), { github: { baseUrl: sim.baseUrl } });
  await connections.connect({ provider: "github", account: "octocat", scopes: [], token: TOKEN }, "core");
  packs = createPacks({ defs: createDefs(store) });
  const packDir = join(dir, "pack");
  mkdirSync(packDir);
  writeFileSync(
    join(packDir, "pack.json"),
    JSON.stringify({
      id: "acme",
      version: 1,
      activate: { githubOrgs: ["octocat"] },
      actors: { ignore: "\\[bot\\]$" },
      reviewBot: {
        logins: ["review-bot[bot]"],
        request: { type: "comment", body: "/review" },
        lgtm: { reviewState: "APPROVED", bodyMatch: "LGTM", sameSha: true },
      },
      conventions: { councilPrefix: "[clanker-council] " },
    }),
  );
  await packs.load(packDir);
});

afterEach(async () => {
  await sim.close();
  origin.cleanup();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Reply {
  status: number;
  headers: Headers;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- el body es JSON libre de la API simulada; cada test afirma lo que lee
  body: any;
}

/** Una request cruda a la API simulada, con el token válido salvo que se diga otro. */
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const response = await fetch(`${sim.baseUrl}${path}`, {
    method,
    headers: { authorization: `bearer ${TOKEN}`, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text === "" ? undefined : JSON.parse(text) };
}

const graphql = (query: string, variables: object = {}) => api("POST", "/graphql", { query, variables });
const prState = (number: number) => createPrs({ connections, packs }).get({ account: "octocat", repo: REPO, number });
const remoteSha = (branch: string) => origin.git("--git-dir", origin.remoteDir!, "rev-parse", `refs/heads/${branch}`);

/** Un commit nuevo en la branch, pusheado al bare como lo haría un fixup. */
function pushCommit(branch: string, message: string, file?: [string, string]): string {
  origin.git("checkout", branch);
  if (file) writeFileSync(join(origin.dir, file[0]), file[1]);
  origin.git("add", "--all");
  origin.git("commit", "--allow-empty", "--message", message);
  origin.git("push", "origin", branch);
  const sha = origin.git("rev-parse", "HEAD");
  origin.git("checkout", "main");
  return sha;
}

describe("ejemplo: un PR con una review simulada", () => {
  test("el core abre el PR por la API, el bot lo revisa y el estado lo refleja", async () => {
    const client = connections.githubClient("octocat");
    const { data } = await client.request("POST /repos/{owner}/{repo}/pulls", {
      owner: "octocat",
      repo: "secret-project",
      title: "[CLA-45] Simular GitHub",
      head: BRANCH,
      base: "main",
      draft: true,
    });
    expect(data).toMatchObject({ number: 1, draft: true, head: { ref: BRANCH, sha: remoteSha(BRANCH) } });
    expect(await prState(1)).toMatchObject({
      key: "secret-project#1",
      state: "draft",
      headSha: remoteSha(BRANCH),
      bot: { state: "none" },
      ci: { state: "none" },
      mergeable: "clean",
    });

    const pr = sim.pr(1);
    pr.botFindings([{ body: "falta validar la entrada", path: "src/a.ts", line: 3 }], { body: "1 hallazgo" });
    pr.ci("red");
    pr.thread("ana", "podrías cambiar este nombre");
    expect(await prState(1)).toMatchObject({
      bot: { state: "findings", sha: remoteSha(BRANCH) },
      ci: { state: "red", failing: ["ci"] },
      threads: { botOpen: 1, humanOpen: 1, councilOpen: [] },
    });

    // El bot vuelve a revisar con CI verde.
    pr.botLgtm();
    pr.ci("green");
    expect(await prState(1)).toMatchObject({ bot: { state: "lgtm" }, ci: { state: "green", failing: [] } });
  });
});

describe("REST: pulls", () => {
  const create = (overrides: object = {}) =>
    api("POST", `/repos/${REPO}/pulls`, { title: "t", head: BRANCH, base: "main", ...overrides });

  test("abre un PR numerado, en draft si se pide, con el autor de la cuenta", async () => {
    const reply = await create({ draft: true, body: "cuerpo" });

    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({
      number: 1,
      state: "open",
      draft: true,
      body: "cuerpo",
      user: { login: "octocat" },
      html_url: `https://github.com/${REPO}/pull/1`,
      head: { label: `octocat:${BRANCH}`, ref: BRANCH, sha: remoteSha(BRANCH) },
      base: { ref: "main", sha: remoteSha("main") },
    });
  });

  test.each([
    ["sin título", { title: "" }, { field: "title", code: "missing_field" }],
    ["con una branch que no existe en el bare", { head: "nope" }, { field: "head", code: "invalid" }],
    ["con una base que no existe", { base: "nope" }, { field: "base", code: "invalid" }],
  ])("rechaza con 422 un PR %s", async (_, overrides, error) => {
    const reply = await create(overrides);

    expect(reply.status).toBe(422);
    expect(reply.body).toMatchObject({ message: "Validation Failed", errors: [{ resource: "PullRequest", ...error }] });
    expect(sim.pulls()).toEqual([]);
  });

  test("rechaza con 422 una branch sin commits sobre la base y un segundo PR abierto de la misma branch", async () => {
    const empty = await create({ head: "sin-cambios" });
    expect(empty.body.errors).toEqual([{ resource: "PullRequest", code: "custom", message: "No commits between main and sin-cambios" }]);

    await create();
    const again = await create();
    expect(again.status).toBe(422);
    expect(again.body.errors[0]).toMatchObject({ code: "custom", message: `A pull request already exists for octocat:${BRANCH}.` });
    expect(sim.pulls()).toHaveLength(1);
  });

  test("lista filtrando por state, head y base, del más nuevo al más viejo", async () => {
    sim.openPr({ head: BRANCH });
    origin.git("push", "origin", "main:refs/heads/otra");
    pushCommit("otra", "feat: otra");
    sim.openPr({ head: "otra" });
    await api("PATCH", `/repos/${REPO}/pulls/1`, { state: "closed" });

    const numbers = async (query: string) => (await api("GET", `/repos/${REPO}/pulls${query}`)).body.map((p: { number: number }) => p.number);

    expect(await numbers("")).toEqual([2]);
    expect(await numbers("?state=all")).toEqual([2, 1]);
    expect(await numbers("?state=closed")).toEqual([1]);
    expect(await numbers(`?state=all&head=octocat:${BRANCH}`)).toEqual([1]);
    expect(await numbers("?state=all&base=otra")).toEqual([]);
    expect(await numbers("?state=all&per_page=1&page=2")).toEqual([1]);
  });

  test("el head del PR sigue a la branch del bare: un push nuevo lo mueve", async () => {
    sim.openPr({ head: BRANCH });
    const before = (await api("GET", `/repos/${REPO}/pulls/1`)).body;

    const sha = pushCommit(BRANCH, "fixup! feat: change");

    const after = (await api("GET", `/repos/${REPO}/pulls/1`)).body;
    expect(before.head.sha).not.toBe(sha);
    expect(after.head.sha).toBe(sha);
    expect(after.mergeable).toBe(true);
    expect(after.mergeable_state).toBe("clean");
  });

  test("PATCH cambia título, cuerpo y estado; un estado inválido es 422 y un PR que no existe es 404", async () => {
    sim.openPr({ head: BRANCH });

    const patched = await api("PATCH", `/repos/${REPO}/pulls/1`, { title: "nuevo", body: "b", state: "closed" });

    expect(patched.body).toMatchObject({ title: "nuevo", body: "b", state: "closed" });
    expect(patched.body.closed_at).not.toBeNull();
    expect((await api("PATCH", `/repos/${REPO}/pulls/1`, { state: "merged" })).status).toBe(422);
    expect((await api("GET", `/repos/${REPO}/pulls/9`)).status).toBe(404);
  });

  test("un PR en conflicto con la base es mergeable false y `dirty`", async () => {
    pushCommit(BRANCH, "feat: toca a", ["a.txt", "desde la branch\n"]);
    sim.openPr({ head: BRANCH });
    origin.git("checkout", "main");
    writeFileSync(join(origin.dir, "a.txt"), "desde main\n");
    origin.git("commit", "--all", "--message", "fix: toca a");
    origin.git("push", "origin", "main");

    const { body } = await api("GET", `/repos/${REPO}/pulls/1`);

    expect(body).toMatchObject({ mergeable: false, mergeable_state: "dirty" });
    expect(await prState(1)).toMatchObject({ mergeable: "conflict" });
  });
});

describe("REST: comentarios y threads", () => {
  test("un comentario de la conversación lo escribe la cuenta y lo ve el estado del PR como propio", async () => {
    sim.openPr({ head: BRANCH });
    sim.pr(1).comment("ana", "hola");

    const posted = await api("POST", `/repos/${REPO}/issues/1/comments`, { body: "/review" });

    expect(posted.status).toBe(201);
    expect(posted.body).toMatchObject({ body: "/review", user: { login: "octocat" } });
    expect((await api("GET", `/repos/${REPO}/issues/1/comments`)).body.map((c: { body: string }) => c.body)).toEqual(["hola", "/review"]);
    expect(sim.pr(1).node().comments.map((c) => [c.author?.login, c.body])).toEqual([
      ["ana", "hola"],
      ["octocat", "/review"],
    ]);
    expect((await api("POST", `/repos/${REPO}/issues/1/comments`, { body: "" })).status).toBe(422);
    expect((await api("POST", `/repos/${REPO}/issues/7/comments`, { body: "x" })).status).toBe(404);
  });

  test("onComment deja que el bot conteste el comentario que le pide review, y no oye los del guion", async () => {
    sim.openPr({ head: BRANCH });
    const heard: string[] = [];
    const off = sim.onComment((pr, body) => {
      heard.push(body);
      if (body === "/review") pr.botLgtm();
    });
    sim.pr(1).comment("ana", "hola");

    await api("POST", `/repos/${REPO}/issues/1/comments`, { body: "/review" });
    off();
    await api("POST", `/repos/${REPO}/issues/1/comments`, { body: "/review" });

    expect(heard).toEqual(["/review"]);
    expect(sim.pr(1).node().reviews.map((r) => [r.author?.login, r.state])).toEqual([["review-bot[bot]", "APPROVED"]]);
  });

  test("la respuesta REST a un comentario de review entra al thread, con la cuenta como autora", async () => {
    sim.openPr({ head: BRANCH });
    const thread = sim.pr(1).councilThread("renombrar esto");

    const reply = await api("POST", `/repos/${REPO}/pulls/1/comments/${thread.commentId}/replies`, { body: "[clanker] aplicado" });

    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({ in_reply_to_id: thread.commentId, user: { login: "octocat" } });
    expect(sim.pr(1).node().reviewThreads[0]?.comments.nodes.map((c) => c.body)).toEqual(["[clanker-council] renombrar esto", "[clanker] aplicado"]);
    expect((await api("POST", `/repos/${REPO}/pulls/1/comments/1/replies`, { body: "x" })).status).toBe(404);
  });

  test("las mutations de GraphQL resuelven un thread, lo reabren y responden en él", async () => {
    sim.openPr({ head: BRANCH });
    const thread = sim.pr(1).thread("ana", "falta un test");
    const resolve = "mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }";
    const unresolve = "mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }";
    const replyTo = "mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { fullDatabaseId body } } }";

    expect((await graphql(resolve, { id: thread.id })).body.data.resolveReviewThread.thread).toMatchObject({ id: thread.id, isResolved: true });
    expect((await prState(1)).threads.humanResolved).toBe(1);
    expect((await graphql(unresolve, { id: thread.id })).body.data.unresolveReviewThread.thread.isResolved).toBe(false);
    const reply = await graphql(replyTo, { id: thread.id, body: "hecho" });
    expect(reply.body.data.addPullRequestReviewThreadReply.comment).toMatchObject({ body: "hecho" });
    expect(sim.pr(1).node().reviewThreads[0]?.comments.nodes.map((c) => [c.author?.login, c.body])).toEqual([
      ["ana", "falta un test"],
      ["octocat", "hecho"],
    ]);
  });

  test("un input con el campo de otra mutation, o sin el id del thread, es un error del documento sin data", async () => {
    sim.openPr({ head: BRANCH });
    const thread = sim.pr(1).thread("ana", "falta un test");

    const wrongField = await graphql(
      "mutation($id: ID!) { resolveReviewThread(input: { pullRequestReviewThreadId: $id }) { thread { id } } }",
      { id: thread.id },
    );
    const noThread = await graphql('mutation { addPullRequestReviewThreadReply(input: { body: "hecho" }) { comment { body } } }');

    expect(wrongField.body).toEqual({
      errors: [{ message: "InputObject 'ResolveReviewThreadInput' doesn't accept argument 'pullRequestReviewThreadId'" }],
    });
    expect(noThread.body).toEqual({
      errors: [{ message: "Argument 'pullRequestReviewThreadId' on InputObject 'AddPullRequestReviewThreadReplyInput' is required. Expected type ID!" }],
    });
    expect(sim.pr(1).node().reviewThreads[0]).toMatchObject({ isResolved: false, comments: { nodes: [{ body: "falta un test" }] } });
  });

  test("una mutation sobre un thread que no existe falla como NOT_FOUND con data nulo", async () => {
    const reply = await graphql("mutation { resolveReviewThread(input: { threadId: \"PRRT_nope\" }) { thread { id } } }");

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      data: { resolveReviewThread: null },
      errors: [{ type: "NOT_FOUND", path: ["resolveReviewThread"], message: "Could not resolve to a node with the global id of 'PRRT_nope'." }],
    });
  });
});

describe("REST: checks", () => {
  test("check-runs y status son los del commit y reflejan lo que el helper dejó, por branch o por sha", async () => {
    const pr = sim.openPr({ head: BRANCH });
    pr.check("test", "success", { required: true });
    pr.check("lint", "pending");
    pr.status("merge-queue", "PENDING");

    const byBranch = (await api("GET", `/repos/${REPO}/commits/${BRANCH}/check-runs`)).body;
    const bySha = (await api("GET", `/repos/${REPO}/commits/${pr.headSha()}/check-runs`)).body;

    expect(byBranch).toEqual(bySha);
    expect(byBranch).toMatchObject({
      total_count: 2,
      check_runs: [
        { name: "test", head_sha: pr.headSha(), status: "completed", conclusion: "success" },
        { name: "lint", status: "in_progress", conclusion: null },
      ],
    });
    expect((await api("GET", `/repos/${REPO}/commits/${BRANCH}/status`)).body).toMatchObject({
      state: "pending",
      statuses: [{ context: "merge-queue", state: "pending" }],
    });
  });

  test("un commit nuevo empieza sin checks: los del anterior no valen", async () => {
    const pr = sim.openPr({ head: BRANCH });
    pr.ci("green");
    expect((await prState(1)).ci).toMatchObject({ state: "green" });

    pushCommit(BRANCH, "fixup! feat: change");

    expect((await prState(1)).ci).toMatchObject({ state: "none", sha: pr.headSha() });
    pr.ci("pending");
    expect((await prState(1)).ci).toMatchObject({ state: "pending" });
  });

  test("un check requerido que todavía no corre en el head deja el PR BLOCKED, como la branch protection", async () => {
    const pr = sim.openPr({ head: BRANCH });
    pr.ci("green");
    expect(pr.node().mergeStateStatus).toBe("CLEAN");

    pushCommit(BRANCH, "fixup! feat: change");

    expect(pr.node()).toMatchObject({ mergeStateStatus: "BLOCKED", head: { contexts: [] } });
    pr.check("ci", "success");
    expect(pr.node()).toMatchObject({ mergeStateStatus: "CLEAN", head: { contexts: [{ name: "ci", isRequired: true }] } });
  });

  test("un ref que no existe es 422", async () => {
    const reply = await api("GET", `/repos/${REPO}/commits/nope/check-runs`);

    expect(reply).toMatchObject({ status: 422, body: { message: "No commit found for SHA: nope" } });
  });
});

describe("merge", () => {
  test("un PR mergeado queda cerrado, con su commit de merge en GraphQL y merged_at en REST", async () => {
    const pr = sim.openPr({ head: BRANCH });
    expect(await prState(1)).toMatchObject({ state: "open" });

    pr.merge();

    expect(await prState(1)).toMatchObject({ state: "merged", mergeCommitSha: pr.headSha() });
    expect((await api("GET", `/repos/${REPO}/pulls/1`)).body).toMatchObject({ state: "closed", merged: true, merged_at: expect.any(String) });
  });
});

describe("la review del bot y el council", () => {
  test("un LGTM de un commit anterior ya no vale para el head de hoy", async () => {
    const pr = sim.openPr({ head: BRANCH });
    pr.botLgtm();
    expect((await prState(1)).bot.state).toBe("lgtm");

    pushCommit(BRANCH, "fixup! feat: change");

    expect(await prState(1)).toMatchObject({ bot: { state: "none" } });
    pr.botLgtm();
    expect((await prState(1)).bot).toMatchObject({ state: "lgtm", sha: pr.headSha() });
  });

  test("un thread de council está abierto hasta que se resuelve", async () => {
    const pr = sim.openPr({ head: BRANCH });
    const thread = pr.councilThread("simplificar esto", { by: "simon" });

    expect(await prState(1)).toMatchObject({ threads: { councilOpen: [thread.commentId], councilEver: true, humanOpen: 0 } });

    pr.resolve(thread.id);
    expect(await prState(1)).toMatchObject({ threads: { councilOpen: [], councilEver: true } });
  });

  test("lo que escribe un humano: review, comentario y request de review", async () => {
    const pr = sim.openPr({ head: BRANCH });
    pr.review("ana", "CHANGES_REQUESTED", { body: "no me convence" });
    pr.comment("beto", "ojo con esto");
    pr.requestReview("carla");

    expect(await prState(1)).toMatchObject({
      reviewDecision: "changes_requested",
      reviewers: [
        { login: "ana", state: "changes_requested" },
        { login: "carla", state: "pending" },
      ],
      talk: [
        { kind: "changes", author: "ana", excerpt: "no me convence" },
        { kind: "comment", author: "beto", excerpt: "ojo con esto" },
      ],
    });
  });

  test("más de 100 threads se sirven por páginas, como GraphQL", async () => {
    const pr = sim.openPr({ head: BRANCH });
    for (let i = 0; i < 230; i++) pr.thread("ana", `thread ${i}`, { resolved: i % 2 === 0 });

    expect((await prState(1)).threads).toMatchObject({ humanOpen: 115, humanResolved: 115 });
    const queries = sim.requests.filter((r) => r.path === "/graphql").map((r) => (r.body as { query: string }).query.match(/query (\w+)/)![1]);
    expect(queries).toEqual(["PrDetail", "PrThreads", "PrThreads"]);
  });

  test("setDraft saca el PR de draft", async () => {
    const pr = sim.openPr({ head: BRANCH, draft: true });
    expect((await prState(1)).state).toBe("draft");

    pr.setDraft(false);

    expect((await prState(1)).state).toBe("open");
  });
});

describe("GraphQL: lo que GitHub contesta", () => {
  test("un PR que no existe es NOT_FOUND y el core lo reconoce", async () => {
    await expect(prState(5)).rejects.toThrow(PrNotFoundError);
    const reply = await graphql("query PrDetail($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { name } }", {
      owner: "octocat",
      name: "secret-project",
      number: 5,
    });
    expect(reply.body).toMatchObject({
      data: { repository: { pullRequest: null } },
      errors: [{ type: "NOT_FOUND", path: ["repository", "pullRequest"], message: "Could not resolve to a PullRequest with the number of 5." }],
    });
  });

  test("un repo que no existe es NOT_FOUND con data.repository nulo", async () => {
    const reply = await graphql("query PrDetail($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { name } }", {
      owner: "octocat",
      name: "otro",
      number: 1,
    });

    expect(reply.body).toMatchObject({ data: { repository: null }, errors: [{ type: "NOT_FOUND", path: ["repository"] }] });
  });

  test("una query que no conoce dice que es del simulador, no inventa datos", async () => {
    const reply = await graphql("query Otra { viewer { login } }");

    expect(reply.status).toBe(200);
    expect(reply.body.errors[0].message).toContain("no sabe responder la query Otra");
    expect(reply.body.data).toBeUndefined();
  });
});

describe("auth y cuota", () => {
  test("sin token o con otro token, 401 Bad credentials; con el token del simulador, 200", async () => {
    expect((await api("GET", "/user", undefined, { authorization: "bearer otro" })).body).toMatchObject({ message: "Bad credentials", status: "401" });
    expect((await api("GET", "/user", undefined, { authorization: "" })).status).toBe(401);
    expect((await api("GET", "/user")).body.login).toBe("octocat");
  });

  test("revokeToken deja todo en 401 y el core marca la conexión como revocada", async () => {
    sim.openPr({ head: BRANCH });
    sim.revokeToken();

    await expect(prState(1)).rejects.toMatchObject({ status: 401 });

    expect(connections.list()).toMatchObject([{ account: "octocat", status: "revoked" }]);
  });

  test("cada respuesta informa la cuota de su recurso y baja de a una", async () => {
    sim.openPr({ head: BRANCH });
    const rest = await api("GET", `/repos/${REPO}/pulls/1`);
    const second = await api("GET", `/repos/${REPO}/pulls/1`, undefined, { "if-none-match": "x" });
    const gql = await graphql("query PrDetail($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { name } }", {
      owner: "octocat",
      name: "secret-project",
      number: 1,
    });

    expect(rest.headers.get("x-ratelimit-resource")).toBe("core");
    expect([rest, second].map((r) => r.headers.get("x-ratelimit-remaining"))).toEqual(["4999", "4998"]);
    expect(gql.headers.get("x-ratelimit-resource")).toBe("graphql");
    expect(gql.headers.get("x-ratelimit-remaining")).toBe("4999");
  });

  test("cuota agotada: REST responde 403 y GraphQL 200 con RATE_LIMITED, y el core emite sync.rate_limited", async () => {
    sim.openPr({ head: BRANCH });
    sim.setQuota("core", { remaining: 0, resetAt: 1_795_003_600_000 });
    sim.setQuota("graphql", { remaining: 0, resetAt: 1_795_003_600_000 });

    const rest = await api("GET", `/repos/${REPO}/pulls/1`);
    expect(rest).toMatchObject({ status: 403, body: { message: "API rate limit exceeded for user ID 583231." } });
    expect(rest.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(rest.headers.get("x-ratelimit-reset")).toBe("1795003600");
    const gql = await graphql("query { viewer { login } }");
    expect(gql).toMatchObject({ status: 200, body: { errors: [{ type: "RATE_LIMITED" }] } });

    await expect(prState(1)).rejects.toThrow("API rate limit already exceeded");
    expect(store.events.since(0, { types: ["sync.rate_limited"] }).map((e) => e.payload)).toEqual([
      { provider: "github", account: "octocat", resetAt: 1_795_003_600_000 },
    ]);
  });

  test("consumir toda la cuota la agota: la siguiente request ya no pasa", async () => {
    sim.setQuota("core", { remaining: 1 });

    expect((await api("GET", "/user")).status).toBe(200);
    expect((await api("GET", "/user")).status).toBe(403);
  });
});

describe("ETags", () => {
  test("un GET devuelve su etag; con If-None-Match es 304 sin gastar cuota, y cambia cuando el PR cambia", async () => {
    sim.openPr({ head: BRANCH });
    const path = `/repos/${REPO}/pulls/1`;
    const first = await api("GET", path);
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^W\/"[0-9a-f]{32}"$/);

    const same = await api("GET", path, undefined, { "if-none-match": etag });
    expect(same.status).toBe(304);
    expect(same.body).toBeUndefined();
    expect(same.headers.get("x-ratelimit-remaining")).toBe(first.headers.get("x-ratelimit-remaining"));

    await api("PATCH", path, { title: "otro título" });
    const changed = await api("GET", path, undefined, { "if-none-match": etag });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
  });

  test("el listado y los comentarios también tienen etag, y un push nuevo cambia el del PR", async () => {
    sim.openPr({ head: BRANCH });
    const list = await api("GET", `/repos/${REPO}/pulls`);
    expect((await api("GET", `/repos/${REPO}/pulls`, undefined, { "if-none-match": list.headers.get("etag")! })).status).toBe(304);
    const pull = await api("GET", `/repos/${REPO}/pulls/1`);

    pushCommit(BRANCH, "fixup! feat: change");

    expect((await api("GET", `/repos/${REPO}/pulls/1`, undefined, { "if-none-match": pull.headers.get("etag")! })).status).toBe(200);
  });
});

describe("rutas y repos", () => {
  test("un repo que no es el del simulador es 404, y una ruta que no modela cae en lo grabado o en 404", async () => {
    expect((await api("GET", "/repos/octocat/otro/pulls")).body).toMatchObject({ message: "Not Found", status: "404" });
    expect((await api("GET", `/repos/${REPO}/branches`)).status).toBe(404);
    expect((await api("GET", `/repos/${REPO}/issues`)).status).toBe(200);
  });

  test("conecta un PAT: el simulador pasa la validación de permisos del core", async () => {
    const fresh = createConnections(openStore({ path: ":memory:" }), createFileSecrets({ dir: join(dir, "otro") }), {
      github: { baseUrl: sim.baseUrl },
    });

    await expect(fresh.setPat(TOKEN, "ui")).resolves.toMatchObject({ account: "octocat", status: "active" });
  });

  test("openPr sobre una branch que no existe lanza con un mensaje accionable", () => {
    expect(() => sim.openPr({ head: "nope" })).toThrow("La branch nope no existe en el remoto bare.");
    expect(() => sim.pr(3)).toThrow("no tiene el PR #3");
  });
});
