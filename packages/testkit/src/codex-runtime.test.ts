import { fork } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createClient, isEventOf, type Client } from "@clanker/api";
import { isPidAlive } from "@clanker/api/node";
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
const invalid = JSON.stringify({ outcome: "ok", summary: "Mal", decisions: null, payload: { saludo: 7 } });
const WAIT = { timeout: 10_000 };
type FakeCodex = Awaited<ReturnType<typeof createFakeCodex>>;
type FakeCodexOptions = NonNullable<Parameters<typeof createFakeCodex>[1]>;
type Request = { method?: string; params?: { threadId?: string; input?: { type: string; text?: string }[] } };

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

async function launch(fake: FakeCodex) {
  const runtime = createCodexRuntime({ home: home.path, store, executable: fake.executable, args: fake.args, baseEnv: { PATH: process.env.PATH, HOME: home.path } });
  core = await startCore({
    store, dataDir: home.path, runtimes: [runtime], env: {}, scheduler: false,
    connections: createConnections({ store, secrets: createFileSecrets({ dir: join(home.path, "secrets") }) }),
    coreVersion: "0.0.0", onShutdown: () => {},
  });
  return createClient({ url: core.server.url, token: core.server.token, origin: "cli" });
}

async function boot(responses: string[], { model = "gpt-5.6-luna", fake: options = {}, maxUsd }: { model?: string; fake?: FakeCodexOptions; maxUsd?: number } = {}) {
  const fake = await createFakeCodex(home.path, { ...options, responses });
  const client = await launch(fake);
  const repoId = createRepos({ store }).add({ name: "demo", path: repo.dir });
  await client.defs.create({ kind: "profile", slug: "codex-juguete", scope: "user", body: { roles: { juguete: { runtime: "codex", model, effort: "low", ...(maxUsd === undefined ? {} : { budget: { maxUsd } }) } } } });
  const project = await client.projects.create({ slug: "codex", name: "Codex", tracker: "local", defaultFlowId: "juguete", defaultProfileId: "codex-juguete", repos: [{ repoId, labels: [] }] });
  const issue = await client.issues.createLocal({ projectId: project.id, title: "Saluda" });
  return { client, project, issue, fake };
}

async function finished(client: Client, id: Parameters<Client["runs"]["get"]>[0]["id"]) {
  await vi.waitFor(async () => expect((await client.runs.get({ id })).status).toBe("done"), WAIT);
  return client.runs.get({ id });
}

async function requests(fake: FakeCodex): Promise<Request[]> {
  return (await readFile(fake.requests, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Request);
}

function agentStep(id: string) {
  return store.db.$client.prepare("SELECT status, attempt, recoveries, deferrals, attempt - recoveries - deferrals AS spent FROM step_runs WHERE run_id = ? AND node_id = 'saludar'").get(id);
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
  const { client, project, issue, fake } = await boot([invalid, valid]);
  const { id } = await client.runs.start({ projectId: project.id, issueId: issue.id });
  const run = await finished(client, id);
  expect(run.costMicros).toBe(40);
  const detail = await client.runs.step({ id: run.steps.find((item) => item.nodeId === "saludar")!.id });
  expect(detail.sessions).toMatchObject([{ runtime: "codex", status: "success", turns: 2, report: { payload: { saludo: "Hola" } } }]);
  const sent = await requests(fake);
  expect(sent.filter((message) => message.method === "thread/start")).toHaveLength(1);
  expect(sent.filter((message) => message.method === "thread/resume")).toHaveLength(1);
  expect(sent.filter((message) => message.method === "turn/start")).toHaveLength(2);
});

test("un modelo sin precio queda en cero y avisa por agent.usage", async () => {
  const { client, project, issue } = await boot([valid], { model: "unknown-model" });
  const { id } = await client.runs.start({ projectId: project.id, issueId: issue.id });
  const run = await finished(client, id);
  expect(run.costMicros).toBe(0);
  expect(store.events.since(0, { runId: id, types: ["error"] })).toContainEqual(expect.objectContaining({
    payload: { scope: "agent.usage", message: expect.stringContaining('No hay precio en model_prices para el modelo "unknown-model"') },
  }));
});

test.each(["quota_exhausted", "login_expired"] as const)("%s deja el paso pending sin gastar intento; el probe conserva la causa hasta que se recupera", async (scenario) => {
  const { client, project, issue, fake } = await boot([valid], { fake: { scenario } });
  const { id } = await client.runs.start({ projectId: project.id, issueId: issue.id });

  await vi.waitFor(() => expect(agentStep(id)).toEqual({ status: "pending", attempt: 1, recoveries: 0, deferrals: 1, spent: 0 }), WAIT);
  expect(await client.system.breakers()).toMatchObject([{ scope: "runtime:codex", cause: scenario, probes: 0 }]);
  expect(store.events.since(0, { types: ["breaker.opened"] })).toMatchObject([{ payload: { scope: "runtime:codex", cause: scenario } }]);
  const alerts = await client.decisions.list({ kind: ["alert"], status: ["pending"] });
  expect(alerts).toHaveLength(1);

  const before = await requests(fake);
  const stillOpen = await client.system.retryBreaker({ scope: "runtime:codex" });
  expect(stillOpen).toMatchObject({ scope: "runtime:codex", cause: scenario, probes: 1, decisionId: alerts[0]!.id });
  expect(stillOpen?.reason).toMatch(scenario === "quota_exhausted" ? /cuota/ : /codex login/);
  expect(agentStep(id)).toEqual({ status: "pending", attempt: 1, recoveries: 0, deferrals: 1, spent: 0 });
  const probe = (await requests(fake)).slice(before.length);
  expect(probe.map((message) => message.method)).toContain("account/read");
  if (scenario === "quota_exhausted") expect(probe.map((message) => message.method)).toContain("account/rateLimits/read");
  expect(probe.filter((message) => message.method === "turn/start")).toEqual([]);
  expect(store.events.since(0, { types: ["breaker.closed"] })).toEqual([]);

  await createFakeCodex(home.path, { responses: [valid] });
  expect(await client.system.retryBreaker({ scope: "runtime:codex" })).toBeNull();
  await finished(client, id);
  expect(agentStep(id)).toEqual({ status: "done", attempt: 2, recoveries: 0, deferrals: 1, spent: 1 });
  expect(await client.system.breakers()).toEqual([]);
  expect(await client.decisions.list({ kind: ["alert"], status: ["pending"] })).toEqual([]);
  expect(store.events.since(0, { types: ["breaker.closed"] })).toMatchObject([{ payload: { scope: "runtime:codex", cause: scenario, probes: 1 } }]);
});

test("el tope maxUsd del perfil acepta el reporte válido aunque Codex termine por presupuesto", async () => {
  const { client, project, issue } = await boot([valid], { maxUsd: 0.000001 });
  const { id } = await client.runs.start({ projectId: project.id, issueId: issue.id });
  const run = await finished(client, id);
  const detail = await client.runs.step({ id: run.steps.find((step) => step.nodeId === "saludar")!.id });
  expect(detail.sessions).toMatchObject([{ status: "success", costMicros: 20, report: { payload: { saludo: "Hola" } } }]);
  const transcript = await client.runs.transcript({ sessionId: detail.sessions[0]!.id });
  expect(transcript.entries.at(-1)).toMatchObject({ kind: "result", subtype: "error_max_budget_usd", costUsd: 0.00002 });
  expect(store.events.since(0, { runId: id, types: ["error"] })).toContainEqual(expect.objectContaining({
    payload: { scope: "agent.budget", message: expect.stringContaining("se usó el reporte") },
  }));
});

test("el tope maxUsd con reporte inválido conserva error_max_budget_usd sin pedir otro reporte", async () => {
  const { client, project, issue, fake } = await boot([invalid], { maxUsd: 0.000001 });
  const { id } = await client.runs.start({ projectId: project.id, issueId: issue.id });
  await vi.waitFor(async () => expect((await client.runs.get({ id })).status).toBe("parked"), WAIT);
  const run = await client.runs.get({ id });
  const step = run.steps.find((item) => item.nodeId === "saludar")!;
  expect(step).toMatchObject({ status: "failed", outcome: "error", attempt: 1 });
  const detail = await client.runs.step({ id: step.id });
  expect(detail.sessions).toMatchObject([{ status: "error_max_budget_usd", costMicros: 20, report: null }]);
  expect((await requests(fake)).filter((message) => message.method === "turn/start")).toHaveLength(1);
  expect(store.events.since(0, { runId: id, types: ["error"] })).not.toContainEqual(expect.objectContaining({
    payload: { scope: "agent.budget", message: expect.stringContaining("se usó el reporte") },
  }));
  expect(await client.system.breakers()).toEqual([]);
});

test("flows.recover tras SIGKILL retoma el mismo thread con aviso antes de instrucciones y sin cobrar uso histórico", async () => {
  const children: ReturnType<typeof fork>[] = [];
  let orphanPid: number | undefined;
  const fake = await createFakeCodex(home.path, { responses: [valid], holdAfterUsage: true });
  async function launchProcess() {
    const child = fork(fileURLToPath(new URL("../scripts/codex-recovery-core.ts", import.meta.url)), ["core", home.path, fake.executable, ...fake.args], {
      execArgv: ["--import", import.meta.resolve("tsx")],
      env: { ...process.env, CLANKER_HOME: home.path },
      silent: true,
    });
    children.push(child);
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const connection = await new Promise<{ url: string; token: string }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => reject(new Error(`Core terminó (${code ?? signal}): ${stderr}`)));
      child.once("message", resolve);
    });
    return { child, client: createClient({ ...connection, origin: "cli" }) };
  }
  try {
    const { child, client } = await launchProcess();
    const repoId = createRepos({ store }).add({ name: "demo", path: repo.dir });
    await client.defs.create({ kind: "profile", slug: "codex-juguete", scope: "user", body: { roles: { juguete: { runtime: "codex", model: "gpt-5.6-luna", effort: "low" } } } });
    const project = await client.projects.create({ slug: "codex", name: "Codex", tracker: "local", defaultFlowId: "juguete", defaultProfileId: "codex-juguete", repos: [{ repoId, labels: [] }] });
    const issue = await client.issues.createLocal({ projectId: project.id, title: "Saluda" });
    const { id } = await client.runs.start({ projectId: project.id, issueId: issue.id });
    await vi.waitFor(() => expect(store.events.since(0, { runId: id, types: ["agent.usage"] })).toHaveLength(1), WAIT);
    const first = await client.runs.get({ id });
    expect(first.status).toBe("running");
    const step = first.steps.find((item) => item.nodeId === "saludar")!;
    const detail = await client.runs.step({ id: step.id });
    const session = detail.sessions[0]!;
    expect(session).toMatchObject({ status: "running", turns: 1, costMicros: 20 });
    const sent = await requests(fake);
    const threadId = sent.find((message) => message.method === "turn/start")!.params!.threadId!;
    const tracked = store.db.$client.prepare("SELECT pid FROM procs WHERE step_run_id = ?").get(step.id) as { pid: number };
    orphanPid = tracked.pid;
    const serverPid = Number((await readFile(fake.pidFile, "utf8")).trim());
    expect(isPidAlive(orphanPid)).toBe(true);
    expect(isPidAlive(serverPid)).toBe(true);
    child.kill("SIGKILL");
    await vi.waitFor(() => expect(isPidAlive(child.pid!)).toBe(false), WAIT);
    expect(isPidAlive(orphanPid)).toBe(true);
    expect(isPidAlive(serverPid)).toBe(true);
    expect(agentStep(id)).toEqual({ status: "running", attempt: 1, recoveries: 0, deferrals: 0, spent: 1 });
    expect(store.db.$client.prepare("SELECT pid FROM procs WHERE step_run_id = ?").get(step.id)).toEqual(tracked);

    await createFakeCodex(home.path, { responses: [valid] });
    const { child: restarted, client: again } = await launchProcess();
    expect(restarted.pid).not.toBe(child.pid);
    await vi.waitFor(() => {
      expect(isPidAlive(orphanPid!)).toBe(false);
      expect(isPidAlive(serverPid)).toBe(false);
    }, WAIT);
    const recovered = await finished(again, id);
    expect(agentStep(id)).toEqual({ status: "done", attempt: 2, recoveries: 1, deferrals: 0, spent: 1 });
    expect(store.events.since(0, { types: ["core.recovered"] })).toMatchObject([{ payload: { steps: 1, leases: 1, orphans: 1 } }]);
    const resumed = (await requests(fake)).slice(sent.length);
    expect(resumed.filter((message) => message.method === "thread/start")).toEqual([]);
    expect(resumed.filter((message) => message.method === "thread/resume")).toMatchObject([{ params: { threadId } }]);
    const turn = resumed.find((message) => message.method === "turn/start")!;
    expect(turn.params!.threadId).toBe(threadId);
    const prompt = turn.params!.input!.map((input) => input.text ?? "").join("\n");
    expect(prompt).toContain("La app se reinició mientras trabajabas en esta tarea.");
    expect(prompt).toContain("Saluda y devuelve el saludo en el reporte.");
    expect(prompt.indexOf("La app se reinició")).toBeLessThan(prompt.indexOf("Saluda y devuelve"));
    const recoveredDetail = await again.runs.step({ id: step.id });
    expect(recoveredDetail.sessions).toMatchObject([{ id: session.id, runtime: "codex", status: "success", turns: 2, costMicros: 40 }]);
    expect(recoveredDetail.sessions).toHaveLength(1);
    expect(recovered.costMicros).toBe(40);
    const usage = store.events.since(0, { runId: id, types: ["agent.usage"] }).filter((event) => isEventOf(event, "agent.usage"));
    expect(usage).toHaveLength(2);
    expect(usage.map((event) => event.payload)).toMatchObject([
      { tokens: { in: 20, out: 12, cacheRead: 80, cacheWrite: 0 }, costMicros: 20 },
      { tokens: { in: 20, out: 12, cacheRead: 80, cacheWrite: 0 }, costMicros: 20 },
    ]);
  } finally {
    try {
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        child.send("close");
        try {
          await vi.waitFor(() => expect(isPidAlive(child.pid!)).toBe(false), WAIT);
        } finally {
          if (isPidAlive(child.pid!)) child.kill("SIGKILL");
        }
      }
    } finally {
      if (orphanPid !== undefined && isPidAlive(orphanPid)) process.kill(-orphanPid, "SIGKILL");
    }
  }
}, 40_000);
