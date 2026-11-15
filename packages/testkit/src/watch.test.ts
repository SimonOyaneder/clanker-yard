import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FlowDef, type PrRef } from "@clanker/api";
import {
  createAgents,
  createArtifacts,
  createAskpass,
  createConnections,
  createDefs,
  createFileSecrets,
  createFlows,
  createGitRemote,
  createPacks,
  createPrCache,
  createPrs,
  createRepos,
  createWatch,
  openStore,
  prWaits,
  signalPr,
  type Connections,
  type Flows,
  type PrCache,
  type Store,
  type Watch,
} from "@clanker/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createFakeRuntime } from "./fake-runtime";
import { tempGitRepo, type TempGitRepo } from "./git";
import { startGitHubSim, type GitHubSim } from "./github-sim";

// Watch contra el GitHub simulado: qué mira, cuándo, y lo que gasta de cuota. El reloj es el de `clock`
// (Watch no usa timers en estos tests: cada `wake` es un `watch.tick()`), y el motor de flujos corre real.

vi.setConfig({ testTimeout: 20_000 });

const TOKEN = "github_pat_UNIQUE-0123456789";
const ACCOUNT = "octocat";
const REPO = "octocat/secret-project";
const SECOND = 1000;
const MINUTE = 60 * SECOND;

let dir: string;
let store: Store;
let origin: TempGitRepo;
let sim: GitHubSim;
let connections: Connections;
let cache: PrCache;
let watch: Watch;
let flows: Flows;
let askpass: ReturnType<typeof createAskpass>;
let clock: number;

const ref = (number: number): PrRef => ({ account: ACCOUNT, repo: REPO, number });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "clanker-watch-"));
  clock = Date.UTC(2026, 10, 15);
  store = openStore({ path: ":memory:" });
  origin = tempGitRepo({
    remote: true,
    commits: [{ message: "chore: base", files: { "a.txt": "a\n" } }],
    branches: {
      one: [{ message: "feat: one", files: { "one.txt": "1\n" } }],
      two: [{ message: "feat: two", files: { "two.txt": "2\n" } }],
    },
  });
  sim = await startGitHubSim({ origin, token: TOKEN });
  connections = createConnections(store, createFileSecrets({ dir }), { github: { baseUrl: sim.baseUrl } });
  await connections.connect({ provider: "github", account: ACCOUNT, scopes: [], token: TOKEN }, "core");

  const repos = createRepos(store, { remote: (repo) => ({ url: `file://${origin.remoteDir}`, repo, account: ACCOUNT }) });
  repos.add({ name: "secret-project", path: origin.dir, remote: REPO });

  const defs = createDefs(store);
  const packs = createPacks({ defs });
  const prs = createPrs({ connections, packs });
  flows = createFlows({
    store,
    defs,
    agents: createAgents({ store, defs, runtime: createFakeRuntime({ fixtures: [], speed: Infinity }) }),
    artifacts: createArtifacts({ store, dir: join(dir, "artifacts") }),
    roles: () => undefined,
    // Solo Watch cierra los waits de estos tests: el sondeo propio del motor queda fuera de juego.
    probeEverySec: 3600,
  });
  for (const wait of Object.values(prWaits(prs))) flows.registerWait(wait);
  cache = createPrCache({ store, repos, prs, onChange: (pr, state) => signalPr(flows.signal, pr, state), now: () => clock });
  askpass = createAskpass();
  watch = createWatch({
    store,
    connections,
    repos,
    cache,
    remote: createGitRemote({ askpass, connections }),
    waitKeys: flows.waitKeys,
    now: () => clock,
  });
});

afterEach(async () => {
  await watch.stop();
  await flows.close();
  await askpass.close();
  await sim.close();
  origin.cleanup();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Avanza el reloj y deja que Watch haga un despertar. */
async function wake(ms = 0) {
  clock += ms;
  await watch.tick();
}

const requestsSince = (from: number) => sim.requests.slice(from);
const pullReads = (requests: typeof sim.requests, number: number) =>
  requests.filter((r) => r.path === `/repos/${REPO}/pulls/${number}`).length;
const detailReads = (requests: typeof sim.requests, number: number) =>
  requests.filter((r) => r.path === "/graphql" && (r.body as { variables?: { number?: number } }).variables?.number === number).length;

describe("descubrir y detectar", () => {
  test("la búsqueda de tus PRs los mete al caché con su detalle (solo los tuyos)", async () => {
    sim.openPr({ head: "one" });
    sim.openPr({ head: "two", author: "otra-persona" });

    await wake();

    expect(cache.list().map(({ ref, owned, state }) => [ref.number, owned, state?.state])).toEqual([[1, false, "open"]]);
  });

  test("un 304 no consume cuota", async () => {
    sim.openPr({ head: "one" });
    await wake();
    const quota = sim.quotaRemaining("core");
    const graphql = sim.quotaRemaining("graphql");
    const from = sim.requests.length;

    await wake(31 * SECOND);

    const requests = requestsSince(from);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.ifNoneMatch !== undefined)).toBe(true);
    expect(sim.quotaRemaining("core")).toBe(quota);
    expect(sim.quotaRemaining("graphql")).toBe(graphql);
  });

  test("el detalle de GraphQL se pide solo para los PRs que cambiaron", async () => {
    const one = sim.openPr({ head: "one" });
    sim.openPr({ head: "two" });
    await wake();
    const from = sim.requests.length;

    await wake(31 * SECOND);
    expect(detailReads(requestsSince(from), 1) + detailReads(requestsSince(from), 2)).toBe(0);

    one.setDraft(true);
    const afterQuiet = sim.requests.length;
    await wake(31 * SECOND);

    const requests = requestsSince(afterQuiet);
    expect(pullReads(requests, 2)).toBe(1);
    expect(detailReads(requests, 1)).toBe(1);
    expect(detailReads(requests, 2)).toBe(0);
    expect(cache.list().find((p) => p.ref.number === 1)?.state?.state).toBe("draft");
  });

  test("una review o un comentario mueven el ETag del PR: se ven sin pedir /reviews ni /comments", async () => {
    const pr = sim.openPr({ head: "one" });
    await wake();
    const from = sim.requests.length;

    pr.review("ana", "CHANGES_REQUESTED", { body: "cambia esto" });
    await wake(31 * SECOND);
    expect(cache.list()[0]?.state?.reviewDecision).toBe("changes_requested");

    pr.comment("ana", "dale una vuelta");
    await wake(31 * SECOND);
    expect(cache.list()[0]?.state?.talk.map((t) => t.kind)).toEqual(["changes", "comment"]);
    expect(requestsSince(from).filter((r) => /\/(reviews|comments)$/.test(r.path))).toEqual([]);
  });

  test("un PR frío espera sus 5 minutos, pero un push (git ls-remote) lo adelanta", async () => {
    sim.openPr({ head: "one", draft: true });
    await wake();
    await wake(20 * MINUTE);
    const from = sim.requests.length;

    await wake(MINUTE);
    expect(requestsSince(from)).toEqual([]);

    origin.git("checkout", "one");
    origin.git("commit", "--allow-empty", "--message", "feat: more");
    origin.git("push", "origin", "one");
    await wake(MINUTE);

    const pushed = origin.git("--git-dir", origin.remoteDir!, "rev-parse", "one");
    expect(cache.list()[0]?.state?.headSha).toBe(pushed);
    expect(detailReads(requestsSince(from), 1)).toBe(1);
    const { cursor } = store.db.$client.prepare("select cursor from sync_cursors where key = ?").get(`refs:${REPO}`) as { cursor: string };
    expect(JSON.parse(cursor)).toMatchObject({ one: pushed });
  });

  test("mergeable en UNKNOWN se relee a los 10 s, hasta 3 veces", async () => {
    sim.openPr({ head: "one" }).mergeableUnknown(10);
    await wake();
    expect(cache.list()[0]?.state?.mergeable).toBe("unknown");
    expect(detailReads(sim.requests, 1)).toBe(1);

    for (let i = 0; i < 5; i++) await wake(10 * SECOND);

    expect(detailReads(sim.requests, 1)).toBe(4);
    expect(cache.list()[0]?.state?.mergeable).toBe("unknown");
  });

  test("un PR que se mergea se lee una última vez y deja de vigilarse", async () => {
    const pr = sim.openPr({ head: "one" });
    await wake();

    pr.merge();
    await wake(31 * SECOND);
    expect(cache.list()[0]?.state).toMatchObject({ state: "merged" });
    const from = sim.requests.length;

    await wake(10 * MINUTE);

    expect(requestsSince(from).filter((r) => r.path.includes("/pulls/"))).toEqual([]);
  });
});

describe("presupuesto de cuota", () => {
  /** GitHub informa la cuota en cada respuesta: cualquier request que haga el usuario deja a Watch al tanto. */
  async function quotaIs(resource: "core" | "graphql", remaining: number) {
    sim.setQuota(resource, { remaining });
    await connections.githubClient(ACCOUNT).request("GET /user");
  }

  test("bajo 25% de la cuota los intervalos se duplican", async () => {
    sim.openPr({ head: "one" });
    await wake();
    await quotaIs("core", 1000);
    const from = sim.requests.length;

    await wake(31 * SECOND);
    expect(pullReads(requestsSince(from), 1)).toBe(0);

    await wake(30 * SECOND);
    expect(pullReads(requestsSince(from), 1)).toBe(1);
  });

  test("con la cuota bajo 10% solo se atienden los PRs con waits", async () => {
    const waited = sim.openPr({ head: "one" });
    const other = sim.openPr({ head: "two" });
    waited.ci("pending");
    flows.save(ciFlow());
    flows.start("ci", { type: "issue", id: "CLA-74" }, { pr: ref(waited.number) });
    await waiting();
    await wake();
    await quotaIs("core", 400);
    waited.setDraft(true);
    other.setDraft(true);
    const from = sim.requests.length;

    await wake(61 * SECOND);

    const requests = requestsSince(from);
    expect(pullReads(requests, waited.number)).toBe(1);
    expect(pullReads(requests, other.number)).toBe(0);
    expect(requests.filter((r) => r.path.startsWith("/search/"))).toEqual([]);
    expect(cache.list().find((p) => p.ref.number === waited.number)?.state?.state).toBe("draft");
    expect(cache.list().find((p) => p.ref.number === other.number)?.state?.state).toBe("open");
  });

  test("sin cuota no sale ninguna request hasta el reset", async () => {
    sim.openPr({ head: "one" });
    await wake();
    sim.setQuota("core", { remaining: 0 });
    await connections.githubClient(ACCOUNT).request("GET /user").catch(() => undefined);
    const from = sim.requests.length;

    await wake(10 * MINUTE);

    expect(requestsSince(from)).toEqual([]);
  });
});

describe("avisa a los flujos", () => {
  test("un wait de CI se cierra con la señal de Watch, sin sondeo propio", async () => {
    const pr = sim.openPr({ head: "one" });
    pr.ci("pending");
    flows.save(ciFlow());
    const runId = flows.start("ci", { type: "issue", id: "CLA-74" }, { pr: ref(pr.number) });
    await waiting();
    await wake();
    expect(flows.getRun(runId).status).toBe("running");

    pr.ci("green");
    await wake(31 * SECOND);
    await finished(runId);

    expect(flows.getRun(runId)).toMatchObject({ status: "done" });
    expect(flows.getRun(runId).steps.map((s) => [s.nodeId, s.outcome])).toEqual([["ci", "ok"]]);
  });

  test("los checks pendientes se miran cada 30 s aunque el PR esté en review, y al terminar se dejan de pedir", async () => {
    const pr = sim.openPr({ head: "one" });
    pr.ci("pending");
    await wake();
    await wake(20 * MINUTE);
    const from = sim.requests.length;

    await wake(31 * SECOND);
    expect(requestsSince(from).filter((r) => r.path.includes("/check-runs")).length).toBe(1);

    pr.ci("green");
    await wake(31 * SECOND);
    expect(cache.list()[0]?.state?.ci.state).toBe("green");
    const settled = sim.requests.length;
    await wake(121 * SECOND);
    await wake(121 * SECOND);
    expect(requestsSince(settled).filter((r) => r.path.includes("/pulls/")).length).toBe(2);

    expect(requestsSince(settled).filter((r) => r.path.includes("/check-runs") || r.path.includes("/status"))).toEqual([]);
  });
});

function ciFlow(): FlowDef {
  return {
    schema: 1,
    id: "ci",
    name: "Espera el CI",
    trigger: { type: "manual" },
    params: { pr: "PrRef" },
    start: "ci",
    nodes: {
      ci: {
        type: "wait",
        event: "pr.ci",
        args: { pr: "$run.params.pr" },
        on: { ok: "@done", fail: "@failed" },
      },
    },
  };
}

/** Espera a que el primer wait quede esperando. */
function waiting(): Promise<void> {
  return new Promise((resolve) => {
    if (store.events.since(0, { types: ["step.waiting"] }).length > 0) return resolve();
    const off = store.events.subscribe(() => {
      off();
      resolve();
    }, { types: ["step.waiting"] });
  });
}

function finished(runId: string): Promise<void> {
  return new Promise((resolve) => {
    const filter = { types: ["run.finished" as const] };
    if (store.events.since(0, filter).some((e) => e.runId === runId)) return resolve();
    const off = store.events.subscribe(() => {
      off();
      resolve();
    }, filter);
  });
}
