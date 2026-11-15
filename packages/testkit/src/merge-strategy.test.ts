import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DecisionId, type PrRef } from "@clanker/api";
import {
  approveOption,
  BUTTON_OPTION,
  createConnections,
  createDefs,
  createErrorReporter,
  createFileSecrets,
  createFlows,
  createAgents,
  createArtifacts,
  createMergeScope,
  createPacks,
  createPrCache,
  createPrEvents,
  createPrs,
  createRepos,
  createWatch,
  openStore,
  startMergeReactions,
  WAIT_OPTION,
  type Flows,
  type MergeReactions,
  type PrCache,
  type Store,
  type Watch,
} from "@clanker/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createFakeRuntime } from "./fake-runtime";
import { tempGitRepo, type TempGitRepo } from "./git";
import { startGitHubSim, type GitHubSim, type SimPr } from "./github-sim";

// La estrategia de merge del pack de ejemplo (`packs/acme/pack.json`, tal cual salvo su alcance) sobre el
// GitHub simulado: qué hace el core cuando un PR queda listo (`pr.mergeReady`), con Watch, los eventos y las
// reacciones reales (`docs/design.html#d-ops`, "Tres niveles de merge").

vi.setConfig({ testTimeout: 20_000 });

const TOKEN = "github_pat_UNIQUE-0123456789";
const ACCOUNT = "octocat";
const REPO = "octocat/secret-project";
const SECOND = 1000;
const ACME_PACK = new URL("../../../packs/acme/pack.json", import.meta.url);

let dir: string;
let store: Store;
let origin: TempGitRepo;
let sim: GitHubSim;
let cache: PrCache;
let watch: Watch;
let flows: Flows;
let reactions: MergeReactions;
let repoId: string;
let setMergeStrategy: (override: "on" | "off" | null) => void;
let clock: number;

const ref = (number: number): PrRef => ({ account: ACCOUNT, repo: REPO, number });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "clanker-merge-"));
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
  const connections = createConnections(store, createFileSecrets({ dir }), { github: { baseUrl: sim.baseUrl } });
  await connections.connect({ provider: "github", account: ACCOUNT, scopes: [], token: TOKEN }, "core");

  const repos = createRepos(store, { remote: (repo) => ({ url: `file://${origin.remoteDir}`, repo, account: ACCOUNT }) });
  repoId = repos.add({ name: "secret-project", path: origin.dir, remote: REPO });
  setMergeStrategy = (override) => repos.setMergeStrategy(repoId, override);

  // El pack de ejemplo real, activado para la org del simulador y sin sus flujos ni roles (esos no son de este test).
  const defs = createDefs(store);
  const packs = createPacks({ defs });
  const packDir = join(dir, "pack");
  mkdirSync(packDir);
  const acme = JSON.parse(readFileSync(ACME_PACK, "utf8")) as Record<string, unknown>;
  writeFileSync(join(packDir, "pack.json"), JSON.stringify({ ...acme, activate: { githubOrgs: ["octocat"] }, flows: [], roles: [] }));
  await packs.load(packDir);

  const prs = createPrs({ connections, packs, merge: createMergeScope({ store, repos, connections }) });
  flows = createFlows({
    store,
    defs,
    agents: createAgents({ store, defs, runtime: createFakeRuntime({ fixtures: [], speed: Infinity }) }),
    artifacts: createArtifacts({ store, dir: join(dir, "artifacts") }),
    roles: () => undefined,
    probeEverySec: 3600,
  });
  const errors = createErrorReporter(store);
  const events = createPrEvents({ store, repos, workspaces: { fetch: async () => "ok" }, errors, now: () => clock });
  cache = createPrCache({ store, repos, prs, onChange: (pr, state, row) => events.observe(pr, state, row), now: () => clock });
  reactions = startMergeReactions({ store, repos, packs, prs, connections, errors });
  watch = createWatch({
    store,
    connections,
    repos,
    cache,
    remote: { lsRemote: async () => ({}) },
    waitKeys: () => [],
    events,
    errors,
    now: () => clock,
  });
});

afterEach(async () => {
  reactions.stop();
  await watch.stop();
  await flows.close();
  await sim.close();
  origin.cleanup();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Avanza el reloj, deja que Watch haga un despertar y que el core termine de reaccionar. */
async function wake(ms = 31 * SECOND) {
  clock += ms;
  await watch.tick();
  await reactions.idle();
}

/** Lo que el sistema abrió (`pr.publish` lo deja `owned`); la búsqueda de tus PRs los descubre sin serlo. */
const own = (number: number) => void store.db.$client.prepare("update pull_requests set owned = 1 where number = ?").run(number);

const mergeComments = (pr: SimPr) => pr.node().comments.filter((c) => c.body === "/merge" && c.author?.login === ACCOUNT);
const pending = () => store.db.$client.prepare("select id, kind, title, body, options, run_id, subject from decisions where status = 'pending' and kind = 'question'").all() as {
  id: DecisionId;
  kind: string;
  title: string;
  body: string;
  options: string;
  run_id: string | null;
  subject: string;
}[];
const readyEvents = () => store.events.since(0, { types: ["pr.mergeReady"] }).map((e) => e.payload.level);

/**
 * Un PR del sistema que Watch ya vio sin estar listo (la primera lectura solo siembra los eventos) y que
 * después queda aprobado por un humano con el CI en verde.
 */
async function openApprovable({ merge-queue = true, own: owned = true }: { merge-queue?: boolean; own?: boolean } = {}) {
  if (merge-queue) sim.defaultBranchCheck("merge-queue");
  const pr = sim.openPr({ head: "one" });
  pr.ci("pending");
  await wake(0);
  if (owned) own(pr.number);
  pr.ci("green");
  pr.review("ana", "APPROVED");
  return pr;
}

describe("offer: una decisión que no estaciona nada", () => {
  test("con un hilo de humano ya resuelto no es auto: abre una decisión sin corrida y no comenta nada", async () => {
    const pr = await openApprovable();
    pr.thread("ana", "una duda", { resolved: true });

    await wake();

    expect(cache.list()[0]?.state?.merge).toMatchObject({ via: "comment", ready: true, offer: true, auto: false, queue: null });
    expect(readyEvents()).toEqual(["offer"]);
    const [decision] = pending();
    expect(pending()).toHaveLength(1);
    expect(decision).toMatchObject({ kind: "question", run_id: null, title: "Comentar /merge en secret-project#1" });
    expect(JSON.parse(decision!.options)).toEqual([approveOption("/merge"), WAIT_OPTION]);
    expect(JSON.parse(decision!.subject)).toMatchObject({ type: "pr" });
    expect(decision!.body).toContain("Aprobado por @ana");
    expect(mergeComments(pr)).toEqual([]);
    expect(store.db.$client.prepare("select count(*) as n from runs").get()).toEqual({ n: 0 });

    // Releer el PR no repite la pregunta: la clave es el sha.
    pr.comment("ana", "va");
    await wake();
    expect(readyEvents()).toEqual(["offer"]);
    expect(pending()).toHaveLength(1);
  });

  test("aprobarla comenta /merge, una vez, desde la identidad del usuario", async () => {
    const pr = await openApprovable();
    pr.thread("ana", "una duda", { resolved: true });
    await wake();
    const [decision] = pending();

    flows.resolveGate(decision!.id, approveOption("/merge"), "ui");
    await reactions.idle();

    expect(mergeComments(pr)).toHaveLength(1);
    await wake();
    expect(cache.list()[0]?.state?.merge).toMatchObject({ queue: "queued", ready: false, offer: false });
  });

  test("'Todavía no' no comenta nada", async () => {
    const pr = await openApprovable();
    pr.thread("ana", "una duda", { resolved: true });
    await wake();
    const [decision] = pending();

    flows.resolveGate(decision!.id, WAIT_OPTION, "ui");
    await reactions.idle();

    expect(mergeComments(pr)).toEqual([]);
  });

  test.each(["cli", "mcp", "core"] as const)("solo una persona en la app aprueba: lo que resuelve el origen %s no comenta", async (origin) => {
    const pr = await openApprovable();
    pr.thread("ana", "una duda", { resolved: true });
    await wake();
    const [decision] = pending();

    flows.resolveGate(decision!.id, approveOption("/merge"), origin);
    await reactions.idle();

    expect(mergeComments(pr)).toEqual([]);
  });

  test("si el head cambió desde que se ofreció, aprobar no comenta y deja una nota", async () => {
    const pr = await openApprovable();
    pr.thread("ana", "una duda", { resolved: true });
    await wake();
    const [decision] = pending();

    origin.git("checkout", "one");
    origin.git("commit", "--allow-empty", "--message", "feat: más");
    origin.git("push", "origin", "one");
    flows.resolveGate(decision!.id, approveOption("/merge"), "ui");
    await reactions.idle();

    expect(mergeComments(pr)).toEqual([]);
    const notes = store.db.$client.prepare("select title from decisions where kind = 'note'").all();
    expect(notes).toEqual([{ title: "No se comentó /merge en secret-project#1" }]);
  });

  test("un head nuevo reemplaza la oferta pendiente en vez de acumular preguntas", async () => {
    const pr = await openApprovable();
    pr.thread("ana", "una duda", { resolved: true });
    await wake();
    expect(pending()).toHaveLength(1);

    origin.git("checkout", "one");
    origin.git("commit", "--allow-empty", "--message", "feat: más");
    origin.git("push", "origin", "one");
    pr.ci("green");
    pr.review("ana", "APPROVED");
    await wake(30 * SECOND);
    await wake(30 * SECOND);
    await wake();

    expect(readyEvents()).toEqual(["offer", "offer"]);
    expect(pending()).toHaveLength(1);
    const superseded = store.db.$client.prepare("select count(*) as n from decisions where status = 'superseded'").get();
    expect(superseded).toEqual({ n: 1 });
  });

  test("un PR que el sistema no abrió no recibe oferta ni comentario", async () => {
    const pr = await openApprovable({ own: false });

    await wake();

    expect(readyEvents()).toEqual(["auto"]);
    expect(pending()).toEqual([]);
    expect(mergeComments(pr)).toEqual([]);
  });
});

describe("auto: el core comenta /merge solo", () => {
  test("aprobado por un humano sin comentarios ni threads, sobre la branch por defecto y con el CI verde", async () => {
    const pr = await openApprovable();

    await wake();

    expect(readyEvents()).toEqual(["auto"]);
    expect(mergeComments(pr)).toHaveLength(1);
    expect(pending()).toEqual([]);

    await wake();
    expect(cache.list()[0]?.state?.merge).toMatchObject({ queue: "queued", auto: false });
    expect(mergeComments(pr)).toHaveLength(1);
  });

  test("merge-queue en rojo después del /merge es merge.queue failed y sale pr.mergeFailed una vez", async () => {
    const pr = await openApprovable();
    await wake();
    pr.status("merge-queue", "PENDING");
    await wake();
    expect(cache.list()[0]?.state?.merge.queue).toBe("queued");

    pr.status("merge-queue", "FAILURE");
    await wake();
    await wake();

    expect(cache.list()[0]?.state?.merge).toMatchObject({ queue: "failed", ready: false });
    expect(store.events.since(0, { types: ["pr.mergeFailed"] })).toHaveLength(1);
  });

  test("hold apaga auto y offer; quitarlo vuelve a ofrecerlo", async () => {
    const pr = await openApprovable();
    await cache.setHold(ref(pr.number), true);
    expect(cache.list()[0]?.state).toMatchObject({ hold: true, merge: { ready: true, offer: false, auto: false } });

    await wake();
    expect(readyEvents()).toEqual([]);
    expect(mergeComments(pr)).toEqual([]);
    expect(pending()).toEqual([]);

    await cache.setHold(ref(pr.number), false);
    await reactions.idle();
    // El evento sale al releer el estado, sin esperar un despertar.
    await watch.tick();
    await reactions.idle();
    expect(readyEvents()).toEqual(["auto"]);
    expect(mergeComments(pr)).toHaveLength(1);
  });

  test("un thread de council, aunque esté resuelto, baja auto a offer", async () => {
    const pr = await openApprovable();
    const thread = pr.councilThread("revisa esto");
    pr.resolve(thread.id);

    await wake();

    expect(readyEvents()).toEqual(["offer"]);
    expect(mergeComments(pr)).toEqual([]);
    expect(pending()).toHaveLength(1);
  });
});

describe("un repo sin merge-queue no aplica la estrategia", () => {
  test("no se ve merge-queue en la branch por defecto: el botón de GitHub, con una decisión y sin comentar", async () => {
    const pr = await openApprovable({ merge-queue: false });

    await wake();

    expect(cache.list()[0]?.state?.merge).toMatchObject({ via: "button", ready: true, offer: true, auto: false });
    expect(readyEvents()).toEqual(["offer"]);
    expect(mergeComments(pr)).toEqual([]);
    const [decision] = pending();
    expect(decision).toMatchObject({ title: "Mergear secret-project#1 en GitHub" });
    expect(JSON.parse(decision!.options)).toEqual([BUTTON_OPTION, WAIT_OPTION]);
  });

  test("lo que vio una vez se recuerda: no se vuelve a pedir la branch por defecto en cada lectura", async () => {
    await openApprovable({ merge-queue: false });
    await wake();
    const asked = () => sim.requests.filter((r) => r.path === "/graphql" && String((r.body as { query?: string }).query).includes("DefaultBranchChecks")).length;
    expect(asked()).toBe(1);

    await wake();
    await watch.tick();
    expect(asked()).toBe(1);
  });

  test("el override del repo manda sobre lo detectado, en los dos sentidos", async () => {
    setMergeStrategy("on");
    const pr = await openApprovable({ merge-queue: false });
    await wake();
    expect(mergeComments(pr)).toHaveLength(1);
  });

  test("override off aunque se vea merge-queue", async () => {
    setMergeStrategy("off");
    const pr = await openApprovable();

    await wake();

    expect(cache.list()[0]?.state?.merge.via).toBe("button");
    expect(mergeComments(pr)).toEqual([]);
  });
});
