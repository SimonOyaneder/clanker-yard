import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createClient, isEventOf, type Client } from "@clanker/api";
import { createCodexRuntime, createConnections, createFileSecrets, createRepos, openStore, type Core, type Store } from "@clanker/core";
import { createFakeCodex } from "@clanker/core/testing";
import { tempGitRepo, type TempGitRepo } from "./git";
import { seedDb, type TestHome } from "./home";
import { startCore } from "./start-core";

let home: TestHome;
let store: Store;
let repo: TempGitRepo;
let core: Core | undefined;
const valid = JSON.stringify({ outcome: "ok", summary: "Hola", decisions: null, payload: { saludo: "Hola" } });
beforeEach(() => {
  home = seedDb("empty");
  store = openStore({ path: home.dbPath });
  repo = tempGitRepo({});
});
afterEach(async () => {
  await core?.close();
  core = undefined;
  store.close();
  repo.cleanup();
  home.cleanup();
});

async function boot(responses: string[], model = "gpt-5.6-luna") {
  const fake = await createFakeCodex(home.path, { responses });
  const runtime = createCodexRuntime({ home: home.path, store, executable: fake.executable, args: fake.args, baseEnv: { PATH: process.env.PATH, HOME: home.path } });
  core = await startCore({
    store, dataDir: home.path, runtimes: [runtime], env: {}, scheduler: false,
    connections: createConnections({ store, secrets: createFileSecrets({ dir: join(home.path, "secrets") }) }),
    coreVersion: "0.0.0", onShutdown: () => {},
  });
  const client = createClient({ url: core.server.url, token: core.server.token, origin: "cli" });
  const repoId = createRepos({ store }).add({ name: "demo", path: repo.dir });
  await client.defs.create({ kind: "profile", slug: "codex-juguete", scope: "user", body: { roles: { juguete: { runtime: "codex", model, effort: "low" } } } });
  const project = await client.projects.create({ slug: "codex", name: "Codex", tracker: "local", defaultFlowId: "juguete", defaultProfileId: "codex-juguete", repos: [{ repoId, labels: [] }] });
  const issue = await client.issues.createLocal({ projectId: project.id, title: "Saluda" });
  return { client, project, issue, fake };
}

async function finished(client: Client, id: Parameters<Client["runs"]["get"]>[0]["id"]) {
  await vi.waitFor(async () => expect((await client.runs.get({ id })).status).toBe("done"), { timeout: 10_000 });
  return client.runs.get({ id });
}

test("juguete elige codex por perfil y registra reporte, transcript, uso y costo estimado", async () => {
  const { client, project, issue } = await boot([valid]);
  const { id } = await client.runs.start({ projectId: project.id, issueId: issue.id });
  const run = await finished(client, id);
  expect(run.steps.map((step) => step.outcome)).toEqual(["ok", "ok", "ok"]);
  expect(run.costMicros).toBe(20);
  const step = run.steps.find((item) => item.nodeId === "saludar")!;
  const detail = await client.runs.step({ id: step.id });
  expect(detail.sessions).toMatchObject([{ runtime: "codex", status: "success", turns: 1, costMicros: 20, report: { outcome: "ok", payload: { saludo: "Hola" } } }]);
  const session = detail.sessions[0]!;
  expect(session.report).not.toHaveProperty("decisions");
  const transcript = await client.runs.transcript({ sessionId: session.id });
  expect(transcript.entries.map((entry) => entry.kind)).toEqual(["prompt", "text", "result"]);
  expect(transcript.entries.at(-1)).toMatchObject({ costUsd: 0.00002 });
  expect(store.db.$client.prepare("SELECT cost_source FROM agent_sessions WHERE id = ?").get(session.id)).toMatchObject({ cost_source: "estimate" });
  const usage = store.events.since(0, { runId: id, types: ["agent.usage"] }).filter((event) => isEventOf(event, "agent.usage"));
  expect(usage).toMatchObject([{ payload: { tokens: { in: 20, out: 12, cacheRead: 80, cacheWrite: 0 }, costMicros: 20 } }]);
  const options = await client.defs.agentOptions();
  expect(options.runtimes.find((item) => item.id === "codex")).toMatchObject({ available: true, models: [{ id: "gpt-5.6-luna" }], efforts: [{ id: "low" }] });
});

test("un reporte inválido se vuelve a pedir en el mismo hilo y el paso termina con el reporte validado", async () => {
  const invalid = JSON.stringify({ outcome: "ok", summary: "Mal", decisions: null, payload: { saludo: 7 } });
  const { client, project, issue, fake } = await boot([invalid, valid]);
  const { id } = await client.runs.start({ projectId: project.id, issueId: issue.id });
  const run = await finished(client, id);
  expect(run.costMicros).toBe(40);
  const detail = await client.runs.step({ id: run.steps.find((item) => item.nodeId === "saludar")!.id });
  expect(detail.sessions).toMatchObject([{ runtime: "codex", status: "success", turns: 2, report: { payload: { saludo: "Hola" } } }]);
  const sent = (await readFile(fake.requests, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { method?: string });
  expect(sent.filter((message) => message.method === "thread/start")).toHaveLength(1);
  expect(sent.filter((message) => message.method === "thread/resume")).toHaveLength(1);
  expect(sent.filter((message) => message.method === "turn/start")).toHaveLength(2);
});

test("un modelo sin precio queda en cero y avisa por agent.usage", async () => {
  const { client, project, issue } = await boot([valid], "unknown-model");
  const { id } = await client.runs.start({ projectId: project.id, issueId: issue.id });
  const run = await finished(client, id);
  expect(run.costMicros).toBe(0);
  expect(store.events.since(0, { runId: id, types: ["error"] })).toContainEqual(expect.objectContaining({
    payload: { scope: "agent.usage", message: expect.stringContaining('No hay precio en model_prices para el modelo "unknown-model"') },
  }));
});
