import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrRef, type EventType, type FlowDef } from "@clanker/api";
import {
  clankerLoopTemplate,
  createAgents,
  createArtifacts,
  createAskpass,
  createConnections,
  createDefs,
  createErrorReporter,
  createFileSecrets,
  createFlows,
  createGitRemote,
  createLegacyImporter,
  createPacks,
  createPrCache,
  createPrEvents,
  createPrs,
  createRepos,
  createWatch,
  createWorkspaces,
  openStore,
  prWaits,
  signalPr,
  startTriggers,
  type Connections,
  type Defs,
  type Flows,
  type PrCache,
  type Store,
  type Watch,
  createRuntimeRegistry,
} from "@clanker/core";
import * as z from "zod";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createFakeRuntime } from "./fake-runtime";
import { tempGitRepo, type TempGitRepo } from "./git";
import { startGitHubSim, type GitHubSim } from "./github-sim";

/** El plazo de un `vi.waitFor`: el default de 1 s no alcanza con la suite en paralelo y bajo carga. */
const WAIT = { timeout: 10_000 };

// Watch contra el GitHub simulado: qué mira, cuándo, y lo que gasta de cuota. El reloj es el de `clock`
// (Watch no usa timers en estos tests: cada `wake` es un `watch.tick()`), y el motor de flujos corre real.

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
let defs: Defs;
let repos: ReturnType<typeof createRepos>;
let flows: Flows;
let askpass: ReturnType<typeof createAskpass>;
let stopTriggers: () => void;
/** Los despertares en que Watch preguntó por los cambios de los trackers. */
let trackerPolls: number[];
let clock: number;

const ref = (number: number): PrRef => ({ account: ACCOUNT, repo: REPO, number });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "clanker-watch-"));
  clock = Date.UTC(2026, 10, 15);
  trackerPolls = [];
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
  connections = createConnections({ store, secrets: createFileSecrets({ dir }), github: { baseUrl: sim.baseUrl } });
  await connections.connect({ provider: "github", account: ACCOUNT, scopes: [], token: TOKEN }, "core");

  repos = createRepos({ store, remote: (repo) => ({ url: `file://${origin.remoteDir}`, repo, account: ACCOUNT }) });
  repos.add({ name: "secret-project", path: origin.dir, remote: REPO });

  defs = createDefs({ store });
  const packs = createPacks({ defs });
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
  const prs = createPrs({ connections, packs });
  flows = createFlows({
    store,
    defs,
    agents: createAgents({ store, defs, runtimes: createRuntimeRegistry([createFakeRuntime({ fixtures: [], speed: Infinity })], {}) }),
    artifacts: createArtifacts({ store, dir: join(dir, "artifacts") }),
    roles: () => undefined,
    // Solo Watch cierra los waits de estos tests: el sondeo propio del motor queda fuera de juego.
    probeEverySec: 3600,
  });
  for (const wait of Object.values(prWaits(prs))) flows.registerWait(wait);
  askpass = createAskpass();
  const gitRemote = createGitRemote({ askpass, connections });
  const errors = createErrorReporter({ store });
  const events = createPrEvents({
    store,
    repos,
    workspaces: createWorkspaces({ store, dataDir: dir, repoConfig: repos.config, identityOf: async () => ({ name: "Ana Pérez", email: "ana@example.com" }), remote: gitRemote }),
    errors,
    now: () => clock,
  });
  cache = createPrCache({
    store,
    repos,
    packs,
    prs,
    onChange: (pr, state, row) => {
      signalPr(flows.signal, pr, state);
      events.observe(pr, state, row);
    },
    now: () => clock,
  });
  stopTriggers = startTriggers({ store, defs, projects: { get: () => undefined }, repos, flows, errors });
  watch = createWatch({
    store,
    connections,
    repos,
    cache,
    remote: gitRemote,
    waitKeys: flows.waitKeys,
    events,
    errors,
    trackers: {
      poll(at) {
        trackerPolls.push(at);
        return Promise.resolve();
      },
    },
    now: () => clock,
  });
});

afterEach(async () => {
  stopTriggers();
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

  test("un PR cerrado que GitHub reabre vuelve a open y Watch lo vigila otra vez", async () => {
    const pr = sim.openPr({ head: "one" });
    await wake();
    pr.close();
    await wake(31 * SECOND);
    expect(cache.list()[0]?.state).toMatchObject({ state: "closed" });
    expect(cache.open()).toEqual([]);

    await wake(6 * MINUTE);
    pr.reopen();
    await wake(6 * MINUTE);

    expect(cache.list()[0]?.state).toMatchObject({ state: "open" });
    expect(cache.open().map((row) => row.number)).toEqual([1]);
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

  test("stop no espera las visitas que faltan del despertar en curso", async () => {
    sim.openPr({ head: "one" });
    sim.openPr({ head: "two" });
    await wake();
    clock += 10 * MINUTE;
    const from = sim.requests.length;
    const polls = trackerPolls.length;

    const ticking = watch.tick();
    await watch.stop();
    await ticking;

    const requests = requestsSince(from);
    expect(pullReads(requests, 1) + pullReads(requests, 2)).toBe(0);
    expect(trackerPolls).toHaveLength(polls);
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

describe("trackers", () => {
  test("cada despertar le da el tiempo a los cambios de los trackers, haya o no PRs", async () => {
    await wake();
    await wake(5 * SECOND);

    expect(trackerPolls).toEqual([clock - 5 * SECOND, clock]);
  });
});

describe("notas importadas del clanker-loop", () => {
  /** Una carpeta del loop viejo con tres PRs del repo: el 1 y el 2 abiertos en el historial y el 3 ya mergeado. */
  function legacyHome(): string {
    const home = join(dir, "legacy");
    const project = join(home, "projects", "demo");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(home, "metrics.jsonl"), "");
    writeFileSync(
      join(project, "state.md"),
      [
        "# Demo · clanker-loop",
        `proyecto: sin proyecto en Linear · repos: secret-project (${origin.dir})`,
        "## Historial",
        "| ID | estado | perfil | PR | branch | min | $ |",
        "|---|---|---|---|---|---|---|",
        "| DEMO-1 | listo | medio | #1 | one | - | - |",
        "| DEMO-2 | listo | medio | #2 | two | - | - |",
        "| DEMO-3 | mergeado | medio | #3 | three | - | - |",
        "## Decisiones a revisar",
        "- DEMO-1 (#1): el body quedó desactualizado.",
        "- DEMO-2 (#2): el bot marcó un falso positivo.",
        "- DEMO-3 (#3): quedó un TODO en el helper.",
      ].join("\n"),
    );
    return home;
  }
  const noteStatuses = () =>
    (store.db.$client.prepare("select substr(body, 1, 7) as note, status, resolved_by as by from decisions order by id").all() as { note: string; status: string; by: string | null }[]).map(
      (d) => [d.note, d.status, d.by],
    );

  test("una review_note de un PR mergeado queda expired tras el primer sync, y la de uno que sigue abierto no", async () => {
    sim.openPr({ head: "one" }).merge();
    sim.openPr({ head: "two" });
    createLegacyImporter({ store, defs, artifacts: createArtifacts({ store, dir: join(dir, "artifacts") }) }).run({ from: legacyHome(), dryRun: false });
    expect(noteStatuses()).toEqual([
      ["DEMO-1 ", "pending", null],
      ["DEMO-2 ", "pending", null],
      ["DEMO-3 ", "pending", null],
    ]);

    await wake();

    // #1 se mergeó en GitHub desde el import y #3 ya llegó mergeado: Watch no lo visita, pero igual lo expira.
    expect(noteStatuses()).toEqual([
      ["DEMO-1 ", "expired", "watch"],
      ["DEMO-2 ", "pending", null],
      ["DEMO-3 ", "expired", "watch"],
    ]);
    expect(store.events.since(0, { types: ["decision.resolved"] }).map((e) => e.payload.status)).toEqual(["expired", "expired"]);
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

const WATCH_EVENTS: EventType[] = ["pr.botReview", "pr.ci", "pr.conflict", "pr.comment", "pr.merged", "pr.base_rewritten", "pr.human", "pr.approvedWithComments"];
const emitted = (...types: EventType[]) => store.events.since(0, { types: types.length > 0 ? types : WATCH_EVENTS });
const emittedTypes = (...types: EventType[]) => emitted(...types).map((e) => e.type);

/** Lo que el sistema abrió (`pr.publish` lo deja `owned`); la búsqueda de tus PRs los descubre sin serlo. */
function own(number: number) {
  store.db.$client.prepare("update pull_requests set owned = 1 where number = ?").run(number);
}

/** Un commit de `branch` en el remoto, hecho por otro. */
function push(branch: string, message: string, files: Record<string, string> = {}) {
  origin.git("checkout", branch);
  for (const [path, content] of Object.entries(files)) writeFileSync(join(origin.dir, path), content);
  origin.git("add", "--all");
  origin.git("commit", "--allow-empty", "--message", message);
  origin.git("push", "origin", branch);
}

describe("eventos", () => {
  test("la primera vez que se ve un PR emite lo que el vigilante anuncia y siembra el resto", async () => {
    push("one", "feat: one edits a", { "a.txt": "one\n" });
    push("main", "feat: main edits a", { "a.txt": "main\n" });
    const pr = sim.openPr({ head: "one" });
    pr.botFindings(["falta un test"]);
    pr.ci("red");
    pr.councilThread("revisa esto");
    pr.comment("ana", "ojo con esto");

    await wake();
    const state = cache.list()[0]?.state;
    expect(state).toMatchObject({ bot: { state: "findings" }, ci: { state: "red" }, mergeable: "conflict", threads: { councilOpen: [expect.any(Number)] } });
    expect(state?.talk).toHaveLength(1);
    // El `$first` del vigilante solo calla los comentarios; el conflicto y el council que ya había se anuncian. El bot y el CI no son eventos del vigilante.
    expect(emittedTypes()).toEqual(["pr.conflict", "pr.comment"]);

    // Lo que ya estaba tampoco sale en las lecturas siguientes.
    pr.setDraft(true);
    await wake(31 * SECOND);
    expect(cache.list()[0]?.state?.state).toBe("draft");
    expect(emittedTypes()).toEqual(["pr.conflict", "pr.comment"]);
  });

  test("cada evento sale una sola vez por su clave, aunque el PR se relea", async () => {
    const pr = sim.openPr({ head: "one" });
    await wake();

    pr.botLgtm();
    pr.ci("green");
    const first = pr.councilThread("uno");
    pr.comment("ana", "hola");
    await wake(31 * SECOND);
    expect(emittedTypes()).toEqual(["pr.botReview", "pr.ci", "pr.comment", "pr.human"]);
    expect(emitted("pr.comment")[0]?.payload).toMatchObject({ repo: REPO, number: pr.number, threadIds: [first.commentId] });

    // Algo que no es un evento hace releer el PR: nada se repite.
    pr.setDraft(true);
    await wake(31 * SECOND);
    expect(emitted()).toHaveLength(4);

    // Un thread de council nuevo anuncia solo su id; un CI que cambia de estado en el mismo sha es otro hecho, pero repetir un estado ya visto no.
    const second = pr.councilThread("dos");
    pr.ci("red");
    await wake(31 * SECOND);
    pr.ci("green");
    await wake(31 * SECOND);
    expect(emitted("pr.comment").map((e) => e.payload.threadIds)).toEqual([[first.commentId], [second.commentId]]);
    expect(emitted("pr.ci").map((e) => e.payload.state)).toEqual(["green", "red"]);

    // Un humano que habla en un draft no avisa hasta que sale de draft (la regla vive en `packages/core/src/watch/events.ts`).
    pr.setDraft(false);
    pr.comment("ana", "otra cosa");
    await wake(31 * SECOND);
    expect(emitted("pr.human").map((e) => (e.payload.talk as unknown[]).length)).toEqual([1, 1]);

    pr.merge();
    await wake(31 * SECOND);
    await wake(31 * SECOND);
    expect(emitted("pr.merged")).toHaveLength(1);
    expect(emitted("pr.merged")[0]).toMatchObject({ origin: "watch", subject: { type: "pr" }, payload: { repo: REPO, number: pr.number } });
  });

  test("aprobado con comentarios sale una vez por aprobación: perderla y volver a aprobar es otro hecho", async () => {
    const pr = sim.openPr({ head: "one" });
    await wake();

    pr.comment("ana", "una duda");
    pr.review("bruno", "APPROVED");
    await wake(31 * SECOND);
    expect(emitted("pr.approvedWithComments")).toMatchObject([{ payload: { repo: REPO, number: pr.number, approvers: ["bruno"], authors: ["ana"], comments: 1 } }]);

    // Releer el PR con la misma aprobación no la anuncia de nuevo.
    pr.label("risk:low");
    await wake(31 * SECOND);
    expect(emitted("pr.approvedWithComments")).toHaveLength(1);

    // Pedir cambios le quita la aprobación; aprobar otra vez es otra aprobación.
    pr.review("bruno", "CHANGES_REQUESTED", { body: "mejor no" });
    await wake(31 * SECOND);
    expect(emitted("pr.approvedWithComments")).toHaveLength(1);
    pr.review("bruno", "APPROVED");
    await wake(31 * SECOND);
    expect(emitted("pr.approvedWithComments")).toHaveLength(2);
  });

  test("aprobado sin comentarios, o en draft, no se anuncia", async () => {
    const quiet = sim.openPr({ head: "one" });
    const draft = sim.openPr({ head: "two", draft: true });
    await wake();

    quiet.review("bruno", "APPROVED");
    draft.comment("ana", "una duda");
    draft.review("bruno", "APPROVED");
    await wake(31 * SECOND);
    await wake(31 * SECOND);

    expect(emitted("pr.approvedWithComments")).toEqual([]);
  });

  test("un conflicto sale por sha de la punta", async () => {
    push("one", "feat: one edits a", { "a.txt": "one\n" });
    const pr = sim.openPr({ head: "one" });
    await wake();
    expect(cache.list()[0]?.state?.mergeable).toBe("clean");

    push("main", "feat: main edits a", { "a.txt": "main\n" });
    pr.setDraft(true);
    await wake(31 * SECOND);
    const conflicted = cache.list()[0]?.state;
    expect(conflicted?.mergeable).toBe("conflict");
    expect(emitted("pr.conflict").map((e) => e.payload)).toEqual([{ repo: REPO, number: pr.number, sha: conflicted?.headSha, base: "main" }]);

    pr.setDraft(false);
    await wake(31 * SECOND);
    expect(emitted("pr.conflict")).toHaveLength(1);

    // Un sha nuevo sigue en conflicto: es otro hecho, pero espera su debounce.
    push("one", "feat: one edits a again", { "a.txt": "one again\n" });
    await wake(31 * SECOND);
    expect(emitted("pr.conflict")).toHaveLength(1);
    await wake(21 * SECOND);
    await wake(31 * SECOND);
    expect(emitted("pr.conflict").map((e) => e.payload.sha)).toEqual([conflicted?.headSha, origin.git("--git-dir", origin.remoteDir!, "rev-parse", "one")]);
  });

  test("varios pushes seguidos dan un solo evento, el del sha final", async () => {
    const pr = sim.openPr({ head: "one" });
    await wake();

    push("one", "feat: a");
    await wake(121 * SECOND);
    pr.ci("red");
    await cache.refresh(ref(pr.number));
    push("one", "feat: b");
    await wake(31 * SECOND);
    pr.ci("green");
    const final = origin.git("--git-dir", origin.remoteDir!, "rev-parse", "one");
    expect(cache.list()[0]?.state?.headSha).toBe(final);
    expect(emitted()).toEqual([]);

    await wake(21 * SECOND);
    await wake(31 * SECOND);

    expect(emitted().map((e) => [e.type, e.payload.sha])).toEqual([["pr.ci", final]]);
    expect(emitted("pr.ci")[0]?.payload.state).toBe("green");
  });

  test("una punta que no desciende de la anterior (force push) sale como base reescrita", async () => {
    sim.openPr({ head: "one" });
    await wake();
    const before = origin.git("--git-dir", origin.remoteDir!, "rev-parse", "one");

    origin.git("checkout", "one");
    origin.git("commit", "--amend", "--allow-empty", "--message", "feat: one, reescrito");
    origin.git("push", "--force", "origin", "one");
    const after = origin.git("--git-dir", origin.remoteDir!, "rev-parse", "one");
    await wake(31 * SECOND);
    await wake(21 * SECOND);
    await wake(31 * SECOND);

    expect(emitted("pr.base_rewritten").map((e) => e.payload)).toEqual([{ repo: REPO, number: 1, from: before, to: after }]);
    expect(emittedTypes()).toEqual(["pr.base_rewritten"]);
  });
});

describe("dispara flujos", () => {
  const started: string[] = [];
  let release: () => void;

  beforeEach(() => {
    started.length = 0;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    flows.registerAction({
      name: "work",
      args: z.object({}),
      outcomes: ["ok"],
      effects: "remote",
      async run() {
        started.push("work");
        await blocked;
        return { outcome: "ok" };
      },
    });
    for (const [id, type] of [["council", "pr.comment"], ["rebase", "pr.conflict"], ["restack", "pr.merged"]] as const) {
      flows.save({
        schema: 1,
        id,
        name: id,
        trigger: { type },
        params: { pr: "PrRef", ...(id === "council" && { branch: "string", base: "string" }) },
        start: "work",
        nodes: { work: { type: "action", action: "work", args: {}, on: { ok: "@done" } } },
      });
    }
  });

  afterEach(() => release());

  const runsOf = (flow: string) => flows.listRuns().filter((r) => r.flow.slug === flow);

  test("un comentario de council arranca el flujo council en el carril de mantenimiento", async () => {
    const pr = sim.openPr({ head: "one" });
    await wake();
    own(pr.number);

    pr.councilThread("revisa esto");
    await wake(31 * SECOND);

    expect(runsOf("council")).toEqual([
      expect.objectContaining({ lane: "maintenance", subject: { type: "pr", id: expect.any(String) }, params: { pr: ref(pr.number), branch: "one", base: "main" } }),
    ]);
    // Otro thread con la corrida viva no abre otra: `start` es idempotente por (flujo, sujeto).
    pr.councilThread("y esto otro");
    await wake(31 * SECOND);
    expect(emitted("pr.comment")).toHaveLength(2);
    expect(runsOf("council")).toHaveLength(1);
  });

  test("los PRs que el sistema no abrió generan el evento pero no arrancan flujos", async () => {
    const pr = sim.openPr({ head: "one" });
    await wake();

    pr.councilThread("revisa esto");
    await wake(31 * SECOND);

    expect(emittedTypes()).toEqual(["pr.comment"]);
    expect(flows.listRuns()).toEqual([]);
  });

  test("lo que ya había en la primera lectura de un PR que el sistema no abrió emite el evento pero no arranca flujos", async () => {
    push("one", "feat: one edits a", { "a.txt": "one\n" });
    push("main", "feat: main edits a", { "a.txt": "main\n" });
    const pr = sim.openPr({ head: "one" });
    pr.councilThread("revisa esto");

    await wake();
    expect(emittedTypes()).toEqual(["pr.conflict", "pr.comment"]);
    expect(flows.listRuns()).toEqual([]);
    // Las lecturas siguientes no repiten nada.
    await wake(31 * SECOND);
    expect(emitted()).toHaveLength(2);
  });

  test("mergear un PR del sistema arranca restack con el PR mergeado", async () => {
    const pr = sim.openPr({ head: "one" });
    await wake();
    own(pr.number);

    pr.merge();
    await wake(31 * SECOND);

    expect(runsOf("restack")).toEqual([expect.objectContaining({ lane: "maintenance", params: { pr: ref(pr.number) } })]);
  });

  test("reescribir la branch de un PR del sistema arranca restack-rewritten con su punta vieja y la nueva", async () => {
    // El flujo de la plantilla tal cual; la acción real tiene su propio test (`pr-restack.test.ts`).
    const restacked: unknown[] = [];
    flows.registerAction({
      name: "stack.restackRewritten",
      args: z.object({ pr: PrRef, from: z.string(), to: z.string() }),
      outcomes: ["ok", "conflict"],
      effects: "remote",
      run: (args) => {
        restacked.push(args);
        return Promise.resolve({ outcome: "ok", output: { changedDrafts: [] } });
      },
    });
    // Sin drafts cambiados no corre ninguna rama, pero el flujo que llaman tiene que existir.
    flows.save({
      schema: 1,
      id: "restack-feedback",
      name: "restack-feedback",
      trigger: { type: "subflow" },
      params: { pr: "PrRef", repo: "RepoRef", branch: "string", base: "string", externalRounds: "number" },
      start: "work",
      nodes: { work: { type: "action", action: "work", args: {}, on: { ok: "@done" } } },
    });
    flows.save(clankerLoopTemplate.flows["restack-rewritten"]!);
    const pr = sim.openPr({ head: "one" });
    await wake();
    own(pr.number);
    const from = origin.git("--git-dir", origin.remoteDir!, "rev-parse", "one");

    origin.git("checkout", "one");
    origin.git("commit", "--amend", "--allow-empty", "--message", "feat: one, reescrito");
    origin.git("push", "--force", "origin", "one");
    const to = origin.git("--git-dir", origin.remoteDir!, "rev-parse", "one");
    await wake(31 * SECOND);
    await wake(21 * SECOND);
    await wake(31 * SECOND);

    expect(runsOf("restack-rewritten")).toEqual([
      expect.objectContaining({ lane: "maintenance", params: { pr: ref(pr.number), repo: expect.any(String), externalRounds: 3, from, to } }),
    ]);
    await vi.waitFor(() => expect(restacked).toEqual([{ pr: ref(pr.number), from, to }]), WAIT);
  });

  test("un conflicto arranca el flujo de rebase, salvo que el PR tenga threads de council", async () => {
    push("one", "feat: one edits a", { "a.txt": "one\n" });
    push("two", "feat: two edits a", { "a.txt": "two\n" });
    const plain = sim.openPr({ head: "one" });
    const reviewed = sim.openPr({ head: "two" });
    reviewed.councilThread("revisa esto");
    await wake();
    own(plain.number);
    own(reviewed.number);

    push("main", "feat: main edits a", { "a.txt": "main\n" });
    plain.setDraft(true);
    reviewed.setDraft(true);
    await wake(31 * SECOND);

    expect(emitted("pr.conflict").map((e) => e.payload.number)).toEqual([plain.number, reviewed.number]);
    expect(runsOf("rebase").map((r) => r.params.pr)).toEqual([ref(plain.number)]);
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
