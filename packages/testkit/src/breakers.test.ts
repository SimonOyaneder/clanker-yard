import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Client, type Event } from "@clanker/api";
import {
  createConnections,
  createFileSecrets,
  createRepos,
  openStore,
  startCore,
  type AgentRuntime,
  type Connections,
  type Core,
  type Store,
} from "@clanker/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createFakeClaude, type FakeClaude, type FakeClaudeScenario } from "./fake-claude";
import { createFakeRuntime } from "./fake-runtime";
import { tempGitRepo, type TempGitRepo } from "./git";
import { seedDb, type TestHome } from "./home";

// Los breakers en el core armado como en producción: un run real que encuentra el login vencido deja la
// cuenta `claude` en rojo, pausa a los agentes y se reanuda solo al reconectar. Sin llamar a Claude real:
// el runtime es el fake con el id `claude-sdk` y la conexión usa el Claude falso.

const until = (check: () => unknown) => vi.waitFor(check, { timeout: 10_000 });
const juguete = fileURLToPath(new URL("../fixtures/runs/juguete", import.meta.url));

let home: TestHome;
let store: Store;
let repo: TempGitRepo;
let core: Core | undefined;
let claude: FakeClaude;
let connections: Connections;
let scenario: FakeClaudeScenario;

beforeEach(() => {
  home = seedDb("empty");
  store = openStore({ path: home.dbPath });
  repo = tempGitRepo({});
  scenario = "ready";
  claude = createFakeClaude({ scenario: () => scenario });
  connections = createConnections(store, createFileSecrets({ dir: join(home.path, "secrets") }), { claude: claude.options });
});

afterEach(async () => {
  await core?.close();
  core = undefined;
  store.close();
  repo.cleanup();
  claude.cleanup();
  home.cleanup();
});

/** El fake con el id de Claude, que contesta `login_expired` mientras `scenario` lo diga: lo que ve un run real con el login vencido. */
function claudeLike(): AgentRuntime {
  const base = createFakeRuntime({ fixtures: juguete, speed: Infinity });
  return {
    ...base,
    id: "claude-sdk",
    start: async (spec) => {
      const run = await base.start(spec);
      if (scenario !== "login_expired") return run;
      return { ...run, result: run.result.then((result) => ({ ...result, status: "login_expired" as const, message: "Claude no tiene sesión: corre `claude auth login`." })) };
    },
  };
}

async function boot(): Promise<Client> {
  core = await startCore({
    store,
    dataDir: home.path,
    connections,
    runtimes: [claudeLike()],
    env: { CORE_RUNTIME: "claude-sdk" },
    coreVersion: "0.0.0",
    onShutdown: () => {},
  });
  return createClient({ url: core.server.url, token: core.server.token, origin: "cli" });
}

const eventsOf = (types: Event["type"][]) => store.events.since(0, { types });

describe("login vencido en un run real", () => {
  test("deja la cuenta claude en rojo, pausa a los agentes con una alerta y se reanuda solo al reconectar", async () => {
    await connections.testClaude(undefined, "ui");
    const client = await boot();
    const repoId = createRepos(store).add({ name: "demo", path: repo.dir });
    const project = await client.projects.create({
      slug: "demo",
      name: "Demo",
      tracker: "local",
      defaultFlowId: "juguete",
      defaultProfileId: "juguete",
      parallel: 2,
      flowParams: { repo: repoId },
    });

    scenario = "login_expired";
    const first = await client.issues.createLocal({ projectId: project.id, title: "Una", priority: 1 });

    await until(() => expect(connections.list()).toMatchObject([{ provider: "claude", account: "subscription", status: "expired" }]));
    expect(eventsOf(["breaker.opened"]).map((e) => e.payload)).toMatchObject([{ scope: "runtime:claude-sdk", cause: "login_expired" }]);
    const alerts = await client.decisions.list({ kind: ["alert"], status: ["pending"] });
    expect(alerts).toMatchObject([{ title: "Pausado: runtime:claude-sdk" }]);

    // Pausado: la corrida espera y una issue nueva ni se lanza, queda en la cola con su motivo.
    const second = await client.issues.createLocal({ projectId: project.id, title: "Otra", priority: 2 });
    await until(async () => expect(await client.projects.queue({ id: project.id })).toMatchObject([{ issue: { id: second.id }, state: "waiting", reason: expect.stringContaining("runtime:claude-sdk en pausa") }]));
    expect((await client.runs.list({ projectId: project.id })).map((r) => [r.subject.id, r.status])).toEqual([[first.id, "running"]]);

    // El usuario vuelve a iniciar sesión y prueba Claude: la causa se fue, el breaker se cierra y todo sigue.
    scenario = "ready";
    await connections.testClaude(undefined, "ui");

    await until(async () => {
      expect((await client.runs.list({ projectId: project.id })).map((r) => [r.subject.id, r.status]).sort()).toEqual([[first.id, "done"], [second.id, "done"]].sort());
    });
    expect(eventsOf(["breaker.closed"])).toHaveLength(1);
    expect(await client.decisions.list({ kind: ["alert"], status: ["pending"] })).toEqual([]);
    expect(connections.list()).toMatchObject([{ status: "active" }]);
  });
});
