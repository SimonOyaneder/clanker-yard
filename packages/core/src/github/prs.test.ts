import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouterClient, ORPCError } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createConnections, type Connections } from "../connections/connections";
import { createDefs } from "../defs/defs";
import { createPacks, type Packs } from "../packs/packs";
import { createFileSecrets } from "../secrets/encrypted-file";
import { createRouter } from "../server/router";
import { apiDeps } from "../server/testing";
import { openStore, type Store } from "../store/store";
import { createIssues } from "../tracker/issues";
import { healthyGitHub, startFakeGitHub, type FakeGitHub, type FakeRequest, type RecordedResponse } from "./fake-github";
import { PrNotFoundError } from "./pr-query";
import { graphqlNotFound, prGraphql } from "./fake-pr-graphql";
import { bot, checkRun, HEAD_SHA, prNode, review, thread, user } from "./pr-fixtures";
import { createPrs } from "./prs";

const TOKEN = "github_pat_UNIQUE-0123456789";
const REPO = { account: "octocat", repo: "acme/api", number: 4251 };

let dir: string;
let store: Store;
let github: FakeGitHub | undefined;
let packs: Packs;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clanker-prs-"));
  store = openStore({ path: ":memory:" });
  packs = createPacks({ defs: createDefs(store) });
});

afterEach(async () => {
  await github?.close();
  github = undefined;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Un GitHub falso con el token válido de `octocat` y esta respuesta para `POST /graphql`. */
async function connect(graphql: (request: FakeRequest) => RecordedResponse | undefined): Promise<Connections> {
  const rest = healthyGitHub();
  github = await startFakeGitHub((request) => (request.path === "/graphql" ? graphql(request) : rest(request)));
  const connections = createConnections(store, createFileSecrets({ dir }), { github: { baseUrl: github.baseUrl } });
  await connections.setPat(TOKEN, "ui");
  return connections;
}

const graphqlRequests = () => github!.requests.filter((r) => r.path === "/graphql");

async function loadAcmePack() {
  const packDir = join(dir, "acme-pack");
  mkdirSync(packDir);
  writeFileSync(
    join(packDir, "pack.json"),
    JSON.stringify({
      id: "acme",
      version: 1,
      activate: { githubOrgs: ["acme"] },
      actors: { ignore: "\\[bot\\]$|^merge-queue$" },
      reviewBot: {
        logins: ["review-bot[bot]"],
        request: { type: "comment", body: "/review" },
        lgtm: { reviewState: "APPROVED", bodyMatch: "LGTM", sameSha: true },
      },
      ciRules: { ignoreChecks: ["merge-queue"] },
      conventions: { councilPrefix: "[clanker-council] " },
    }),
  );
  await packs.load(packDir);
}

describe("prs.get", () => {
  test("pide el PR con el token de la cuenta y lo normaliza con el pack de la org del repo", async () => {
    await loadAcmePack();
    const pr = prNode({
      reviews: [review(bot("review-bot[bot]"), "APPROVED", { body: "LGTM" })],
      head: { oid: HEAD_SHA, contexts: [checkRun("test", "SUCCESS"), checkRun("merge-queue", "FAILURE")] },
      reviewThreads: [thread(user("ana"), "falta algo")],
    });
    const connections = await connect(prGraphql(pr));

    const state = await createPrs({ connections, packs }).get(REPO);

    expect(state).toMatchObject({
      key: "api#4251",
      bot: { state: "lgtm", sha: HEAD_SHA },
      ci: { state: "green", failing: [] },
      threads: { humanOpen: 1 },
    });
    const [request, ...rest] = graphqlRequests();
    expect(rest).toEqual([]);
    expect(request).toMatchObject({ authorization: `bearer ${TOKEN}`, body: { variables: { owner: "acme", name: "api", number: 4251 } } });
  });

  test("un repo de otra org no recibe el pack: sin bot y con los checks requeridos", async () => {
    await loadAcmePack();
    const pr = prNode({
      reviews: [review(bot("review-bot[bot]"), "APPROVED", { body: "LGTM" })],
      head: { oid: HEAD_SHA, contexts: [checkRun("test", "FAILURE", true), checkRun("merge-queue", "SUCCESS")] },
    });
    const connections = await connect(prGraphql(pr));

    const state = await createPrs({ connections, packs }).get({ ...REPO, repo: "otra-org/api" });

    expect(state.bot).toEqual({ state: "none" });
    expect(state.ci).toEqual({ state: "red", sha: HEAD_SHA, failing: ["test"] });
  });

  test("completa las páginas de threads y de checks que no entraron en la primera", async () => {
    const pr = prNode({
      reviewThreads: Array.from({ length: 230 }, (_, i) => thread(user("ana"), `thread ${i}`, { resolved: i % 2 === 0 })),
      head: { oid: HEAD_SHA, contexts: Array.from({ length: 150 }, (_, i) => checkRun(`check-${i}`, i === 149 ? "FAILURE" : "SUCCESS", true)) },
    });
    const connections = await connect(prGraphql(pr));

    const state = await createPrs({ connections, packs }).get(REPO);

    expect(state.threads).toMatchObject({ humanOpen: 115, humanResolved: 115 });
    expect(state.ci).toMatchObject({ state: "red", failing: ["check-149"] });
    const queries = graphqlRequests().map((r) => {
      const { query, variables } = r.body as { query: string; variables: Record<string, unknown> };
      return [query.match(/query (\w+)/)![1], variables.after];
    });
    expect(queries).toEqual([
      ["PrDetail", undefined],
      ["PrThreads", "100"],
      ["PrThreads", "200"],
      ["PrContexts", "100"],
    ]);
    expect(graphqlRequests()[1]!.body).toMatchObject({ variables: { id: "PR_kwDOexample" } });
  });

  test("las reviews pedidas a un equipo no son un revisor", async () => {
    const pr = prNode({ requestedReviewers: [user("ana")] });
    const connections = await connect(prGraphql(pr, { teamRequests: 2 }));

    const state = await createPrs({ connections, packs }).get(REPO);

    expect(state.reviewers.map((r) => [r.login, r.state])).toEqual([["ana", "pending"]]);
  });

  test("un PR sin commits no tiene checks", async () => {
    const connections = await connect((request) => {
      const response = prGraphql(prNode())(request);
      const pullRequest = (response?.body as { data: { repository: { pullRequest: { commits: unknown } } } }).data.repository.pullRequest;
      pullRequest.commits = { nodes: [] };
      return response;
    });

    const state = await createPrs({ connections, packs }).get(REPO);

    expect(state.ci).toEqual({ state: "none", sha: HEAD_SHA, failing: [] });
  });

  test("un PR o repo que no existe es PrNotFoundError", async () => {
    const connections = await connect(() => graphqlNotFound);

    await expect(createPrs({ connections, packs }).get(REPO)).rejects.toThrow(PrNotFoundError);
    await expect(createPrs({ connections, packs }).get(REPO)).rejects.toThrow("No existe el PR acme/api#4251");
  });

  test("GitHub rechaza el token: la conexión queda revocada y el error sigue", async () => {
    const connections = await connect(() => ({
      status: 401,
      headers: { "x-ratelimit-remaining": "59", "x-ratelimit-reset": "1795000000", "x-ratelimit-resource": "graphql" },
      body: { message: "Bad credentials", documentation_url: "https://docs.github.com/graphql", status: "401" },
    }));

    await expect(createPrs({ connections, packs }).get(REPO)).rejects.toMatchObject({ status: 401 });

    expect(connections.list()).toMatchObject([{ account: "octocat", status: "revoked" }]);
  });

  test("cuota de GraphQL agotada (200 con errors y remaining 0): emite sync.rate_limited y el error sigue", async () => {
    const connections = await connect(() => ({
      status: 200,
      headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1795003600", "x-ratelimit-resource": "graphql" },
      body: { errors: [{ type: "RATE_LIMITED", message: "API rate limit already exceeded for user ID 583231." }] },
    }));

    await expect(createPrs({ connections, packs }).get(REPO)).rejects.toThrow("API rate limit already exceeded");

    expect(store.events.since(0, { types: ["sync.rate_limited"] }).map((e) => e.payload)).toEqual([
      { provider: "github", account: "octocat", resetAt: 1_795_003_600_000 },
    ]);
  });
});

describe("API", () => {
  async function clientFor(connections: Connections) {
    const router = createRouter({
      store,
      connections,
      issues: createIssues(store),
      ...apiDeps(store, dir),
      packs,
      coreVersion: "0",
      bootId: "boot",
      startedAt: 0,
      dataDir: dir,
      onShutdown: () => {},
    });
    return createRouterClient(router, { context: { origin: "ui" } });
  }

  test("prs.get devuelve el PrState", async () => {
    const connections = await connect(prGraphql(prNode({ isDraft: true })));
    const client = await clientFor(connections);

    expect(await client.prs.get(REPO)).toMatchObject({ key: "api#4251", state: "draft", mergeable: "clean" });
  });

  test("un PR que no existe es NOT_FOUND y una cuenta no conectada es BAD_REQUEST", async () => {
    const client = await clientFor(await connect(() => graphqlNotFound));

    await expect(client.prs.get(REPO)).rejects.toSatisfy((e) => e instanceof ORPCError && e.code === "NOT_FOUND");
    await expect(client.prs.get({ ...REPO, account: "otra" })).rejects.toSatisfy(
      (e) => e instanceof ORPCError && e.code === "BAD_REQUEST" && /conéctala primero/.test(e.message),
    );
  });

  test("repo mal formado se rechaza antes de llamar a GitHub", async () => {
    const client = await clientFor(await connect(prGraphql(prNode())));

    await expect(client.prs.get({ ...REPO, repo: "api" })).rejects.toSatisfy((e) => e instanceof ORPCError && e.code === "BAD_REQUEST");
    expect(graphqlRequests()).toEqual([]);
  });
});
