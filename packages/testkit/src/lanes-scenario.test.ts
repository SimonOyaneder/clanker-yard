import { join } from "node:path";
import { createClient, type Client } from "@clanker/api";
import { createConnections, createFileSecrets, createRepos, openStore, startCore, type Core, type Store } from "@clanker/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createFakeRuntime } from "./fake-runtime";
import { tempGitRepo, type TempGitRepo } from "./git";
import { seedDb, type TestHome } from "./home";
import { seedLanes } from "./lanes-scenario";

// El escenario de las capturas de Operación (`DEMO_SCENARIO=lanes`) visto por la API, como lo ve la UI.

let home: TestHome;
let store: Store;
let repo: TempGitRepo;
let core: Core;
let client: Client;

beforeEach(async () => {
  home = seedDb("empty");
  store = openStore({ path: home.dbPath });
  repo = tempGitRepo({});
  const connections = createConnections(store, createFileSecrets({ dir: join(home.path, "secrets") }));
  await connections.connect({ provider: "github", account: "octocat", scopes: [], token: "github_pat_demo" }, "core");
  core = await startCore({
    store,
    dataDir: home.path,
    connections,
    runtimes: [createFakeRuntime({ fixtures: join(import.meta.dirname, "../fixtures/runs/juguete"), speed: Infinity })],
    env: { CORE_RUNTIME: "fake" },
    scheduler: false,
    coreVersion: "0.0.0",
    onShutdown: () => {},
  });
  client = createClient({ url: core.server.url, token: core.server.token, origin: "cli" });
  const repoId = createRepos(store).add({ name: "demo", path: repo.dir, remote: "octocat/demo" });
  await seedLanes({ client, store, repoId });
});

afterEach(async () => {
  await core.close();
  store.close();
  repo.cleanup();
  home.cleanup();
});

test("dev está lleno y el rebase corre en mantenimiento con el PR de la corrida estacionada", async () => {
  const [project] = await client.projects.list();
  const runs = await client.runs.list({ projectId: project!.id });
  const lane = (name: "dev" | "maintenance", status: string) => runs.filter((r) => r.lane === name && r.status === status);

  expect(project).toMatchObject({ parallel: 1 });
  expect(lane("dev", "running")).toHaveLength(1);
  const [parked] = lane("dev", "parked");
  expect(parked).toMatchObject({ parkReason: "needs_human", borrowedFromRunId: null });
  expect(lane("maintenance", "running")).toMatchObject([{ flow: { slug: "rebase" }, subject: { type: "pr" }, borrowedFromRunId: parked!.id }]);
  expect(await client.system.lanes()).toMatchObject({ dev: { active: 1 }, maintenance: { active: 1 } });
});

test("la estacionada tiene su decisión, el breaker de GitHub está abierto y la cola trae lo suyo", async () => {
  const [project] = await client.projects.list();
  const runs = await client.runs.list({ projectId: project!.id });
  const parked = runs.find((r) => r.status === "parked")!;

  expect(await client.decisions.list({ runId: parked.id, status: ["pending"] })).toMatchObject([{ kind: "needs_human", options: ["retry", "cancel"] }]);
  expect(await client.system.breakers()).toMatchObject([{ scope: "github", cause: "rate_limited" }]);
  expect((await client.projects.queue({ id: project!.id })).map((e) => [e.issue.title, e.state])).toEqual([
    ["Documentar los boundaries en el README", "ready"],
    ["Reglas de boundaries para engines nuevas", "ready"],
    ["Migrar los helpers de fechas a un engine propio", "blocked"],
  ]);
  expect((await client.prs.list({ state: "open" })).filter((p) => p.owned && p.runId !== null)).toHaveLength(2);
});

test("el flujo de las corridas se puede leer completo (stepper de la UI)", async () => {
  const [project] = await client.projects.list();
  const running = (await client.runs.list({ projectId: project!.id, status: ["running"] })).find((r) => r.lane === "dev")!;

  const detail = await client.runs.get({ id: running.id });

  expect(detail.flowDef.id).toBe("techlead-clasico");
  expect(detail.steps.map((s) => [s.nodeId, s.status])).toContainEqual(["rv-bugs", "running"]);
});
