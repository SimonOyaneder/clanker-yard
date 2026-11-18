import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createProcs } from "../../procs/procs";
import { procs as procsTable } from "../../store/schema";
import { openStore } from "../../store/store";
import { createFakeCodex, type FakeCodexOptions } from "../../testing/codex/fake-codex";
import type { CodexNotification, RpcMessage } from "./api";
import { launchCodexAppServer, type CodexAppServer, type CodexAppServerOptions } from "./app-server";

let dir: string;
let servers: CodexAppServer[];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codex-server-"));
  servers = [];
});
afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  await rm(dir, { recursive: true, force: true });
});

async function start(options: FakeCodexOptions = {}, input: Partial<CodexAppServerOptions> = {}) {
  const fake = await createFakeCodex(dir, options);
  const server = await launchCodexAppServer({ ...fake, cwd: dir, ...input });
  servers.push(server);
  return { fake, server };
}

async function messages(file: string): Promise<RpcMessage[]> {
  return (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as RpcMessage);
}

async function turnEvents(server: CodexAppServer) {
  const events: CodexNotification[] = [];
  for await (const event of server.notifications) {
    events.push(event);
    if (event.method === "turn/completed") break;
  }
  return events;
}

test("no lee credenciales ni registra la cuenta en un proceso aislado", async () => {
  const codexHome = join(dir, "codex-home");
  await mkdir(codexHome);
  const authFile = join(codexHome, "auth.json");
  await writeFile(authFile, '{"access_token":"private-auth-sentinel"}');
  const accountEmail = "private-protocol-sentinel@example.test";
  const fake = await createFakeCodex(dir, { accountEmail });
  const outfile = join(dir, "isolation.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("./app-server-isolation.fixture.ts", import.meta.url))],
    outfile,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    logLevel: "silent",
  });
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
    outfile, dir, codexHome, fake.executable, fake.args[0]!, accountEmail,
  ]);
  expect(stdout).toBe("");
  expect(stderr).toBe("");
  expect(JSON.parse(await readFile(fake.environment, "utf8"))).toMatchObject({
    HOME: dir, CODEX_HOME: codexHome, PATH: process.env.PATH,
  });
  for (const file of [fake.requests, fake.environment]) {
    expect(await readFile(file, "utf8")).not.toContain("private-auth-sentinel");
  }
});

test("handshake y requests por id sobre JSONL fragmentado, sin credenciales en el protocolo", async () => {
  const { server, fake } = await start({ fragment: true, reverseReplies: true }, { version: "1.2.3", baseEnv: { HOME: dir, PATH: process.env.PATH, OPENAI_API_KEY: "secret", CODEX_ACCESS_TOKEN: "secret" } });
  const [account, models, limits] = await Promise.all([
    server.request("account/read", { refreshToken: false }),
    server.request("model/list", {}),
    server.request("account/rateLimits/read", { excludeResetCreditDetails: true }),
  ]);
  expect(account.account).toMatchObject({ type: "chatgpt" });
  expect(models.data[0]?.model).toBe("gpt-5.6-luna");
  expect(limits).toMatchObject({ ordinaryUsageAllowed: true, rateLimits: { primary: { windowDurationMins: 10080 } } });
  const requests = await messages(fake.requests);
  expect(requests.slice(0, 2)).toEqual([
    { id: 1, method: "initialize", params: { clientInfo: { name: "clanker_yard", title: "Clanker Yard", version: "1.2.3" } } },
    { method: "initialized", params: {} },
  ]);
  expect(new Set(requests.filter((m) => m.id !== undefined).map((m) => m.id)).size).toBe(4);
  expect(JSON.stringify(requests)).not.toContain("secret");
  const environment = await readFile(fake.environment, "utf8");
  expect(JSON.parse(environment)).toMatchObject({ HOME: dir, PATH: process.env.PATH });
  expect(environment).not.toContain("secret");
  await expect(server.request("initialize", { clientInfo: { name: "other", title: null, version: "0" } })).rejects.toMatchObject({ rpc: { code: -32600, message: "Already initialized" } });
  await server.close();
});

test("lee la config del cwd al iniciar y reanudar, y deshabilita cada MCP antes de crear el hilo", async () => {
  const { server, fake } = await start();
  const cwd = join(dir, "project");
  const { thread } = await server.request("thread/start", { cwd });
  await server.request("thread/resume", { threadId: thread.id });
  const requests = await messages(fake.requests);
  expect(requests.filter((m) => m.method === "config/read")).toEqual([
    { id: 2, method: "config/read", params: { cwd } },
    { id: 5, method: "config/read", params: { cwd } },
  ]);
  expect(requests.find((m) => m.method === "thread/start")).toMatchObject({
    params: { approvalPolicy: "never", config: { mcp_servers: { sentinel: { enabled: false }, project_sentinel: { enabled: false } } } },
  });
  expect(requests.find((m) => m.method === "thread/resume")).toMatchObject({
    params: { cwd, approvalPolicy: "never", config: { mcp_servers: { sentinel: { enabled: false }, project_sentinel: { enabled: false } } } },
  });
});

test("conserva notificaciones de items, uso y cierre, separadas de la respuesta de turn/start", async () => {
  const { server } = await start();
  const { thread } = await server.request("thread/start", {});
  const { turn } = await server.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Hola" }] });
  expect(turn.status).toBe("inProgress");
  const events = await turnEvents(server);
  expect(events.map((e) => e.method)).toEqual([
    "turn/started", "item/started", "item/agentMessage/delta", "item/completed",
    "thread/tokenUsage/updated", "account/rateLimits/updated", "turn/completed",
  ]);
  expect(events.at(-1)).toMatchObject({ params: { turn: { status: "completed" } } });
  expect(events.find((e) => e.method === "thread/tokenUsage/updated")).toMatchObject({ params: { tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 80 } } } });
  expect(events.find((e) => e.method === "account/rateLimits/updated")).toEqual(expect.objectContaining({ params: { rateLimits: expect.objectContaining({ spendControlReached: null }) } }));
});

test.each([
  ["item/commandExecution/requestApproval", { result: { decision: "decline" } }],
  ["item/fileChange/requestApproval", { result: { decision: "decline" } }],
  ["execCommandApproval", { result: { decision: { denied: { rejection: "Clanker Yard no aprueba comandos del agente" } } } }],
  ["applyPatchApproval", { result: { decision: { denied: { rejection: "Clanker Yard no aprueba comandos del agente" } } } }],
  ["item/tool/requestUserInput", { error: { code: -32601 } }],
  ["account/chatgptAuthTokens/refresh", { error: { code: -32601 } }],
])("rechaza una request del servidor: %s", async (approval, response) => {
  const { server, fake } = await start({ approval });
  const { thread } = await server.request("thread/start", {});
  await server.request("turn/start", { threadId: thread.id, input: [] });
  await vi.waitFor(async () => expect(await messages(fake.requests)).toContainEqual(expect.objectContaining({ id: "approval_1", ...response, ...("error" in response && { error: expect.objectContaining(response.error) }) })), { timeout: 5000 });
});

test.each([
  ["ready", "missing", "modelNotFound"],
  ["quota_exhausted", "gpt-5.6-luna", "usageLimitExceeded"],
  ["login_expired", "gpt-5.6-luna", "unauthorized"],
] as const)("el falso %s entrega ACK, error y turno failed (%s)", async (scenario, model, kind) => {
  const { server } = await start({ scenario });
  const { thread } = await server.request("thread/start", { model });
  const ack = await server.request("turn/start", { threadId: thread.id, input: [] });
  expect(ack.turn.status).toBe("inProgress");
  const events = await turnEvents(server);
  expect(events).toContainEqual(expect.objectContaining({ method: "error", params: expect.objectContaining({ willRetry: false, error: expect.objectContaining({ codexErrorInfo: kind }) }) }));
  expect(events.at(-1)).toMatchObject({ params: { turn: { status: "failed", error: { codexErrorInfo: kind } } } });
  if (scenario === "quota_exhausted") expect((await server.request("account/rateLimits/read", {})).ordinaryUsageAllowed).toBe(false);
  if (scenario === "login_expired") expect((await server.request("account/read", {})).account).toBeNull();
});

test("interrumpe un turno pendiente", async () => {
  const { server } = await start({ holdTurn: true });
  const { thread } = await server.request("thread/start", {});
  const { turn } = await server.request("turn/start", { threadId: thread.id, input: [] });
  await server.request("turn/interrupt", { threadId: thread.id, turnId: turn.id });
  expect((await turnEvents(server)).at(-1)).toMatchObject({ params: { turn: { status: "interrupted" } } });
});

test("el timeout rechaza solo la request y permite seguir usando el cliente", async () => {
  const { server } = await start({ silent: ["model/list"] }, { requestTimeoutMs: 500 });
  await expect(server.request("model/list", {})).rejects.toThrow(/no respondió model\/list/);
  expect((await server.request("account/read", {})).account?.type).toBe("chatgpt");
});

test("el timeout del handshake cierra el proceso", async () => {
  const fake = await createFakeCodex(dir, { silent: ["initialize"] });
  await expect(launchCodexAppServer({ ...fake, cwd: dir, requestTimeoutMs: 500 })).rejects.toThrow(/no respondió initialize/);
  const pid = Number(await readFile(fake.pidFile, "utf8"));
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(/ESRCH/), { timeout: 5000 });
});

test("un JSONL inválido termina el cliente sin imprimir el contenido", async () => {
  const { server } = await start({ malformed: true });
  await expect(server.request("model/list", {})).rejects.toThrow("codex app-server envió JSONL inválido");
  await server.exited;
});

test("cerrar rechaza pendientes y termina el stream; close es idempotente", async () => {
  const { server } = await start({ silent: ["model/list"] });
  const pending = expect(server.request("model/list", {})).rejects.toThrow(/cerrado/);
  await Promise.all([server.close(), server.close(), pending]);
  await expect(server.notifications[Symbol.asyncIterator]().next()).resolves.toMatchObject({ done: true });
  await expect(server.request("account/read", {})).rejects.toThrow(/cerrado/);
});

test("si muere antes del handshake, el error contiene solo la cola de stderr", async () => {
  const fake = await createFakeCodex(dir, { startupCrash: true });
  let failure: Error | undefined;
  try {
    await launchCodexAppServer({ ...fake, cwd: dir });
  } catch (error) {
    failure = error as Error;
  }
  expect(failure?.message).toMatch(/código 1.*falló la configuración/s);
  expect(failure!.message.length).toBeLessThan(2100);
});

test("un crash después del handshake rechaza pendientes con stderr y termina el flujo", async () => {
  const { server } = await start({ scenario: "crash", silent: ["model/list"] });
  const { thread } = await server.request("thread/start", {});
  const pending = expect(server.request("model/list", {})).rejects.toThrow(/falló la configuración/);
  await server.request("turn/start", { threadId: thread.id, input: [] });
  await pending;
  expect(await server.exited).toMatch(/código 1.*falló la configuración/s);
  const events = [];
  for await (const event of server.notifications) events.push(event);
  expect(events.map((e) => e.method)).toEqual(["turn/started"]);
});

test("sin el ejecutable indica qué instalar", async () => {
  await expect(launchCodexAppServer({ executable: join(dir, "missing"), cwd: dir })).rejects.toThrow(/instala Codex/);
});

test("registra kind y stepRunId en procs y al cerrar baja también los hijos", async () => {
  const store = openStore({ path: ":memory:" });
  try {
    const { server, fake } = await start({ child: true }, { procs: createProcs({ store, bootId: "boot" }), stepRunId: "step_codex" });
    expect(store.db.select().from(procsTable).all()).toMatchObject([{ kind: "agent", stepRunId: "step_codex" }]);
    const pid = Number(await readFile(fake.childPid, "utf8"));
    expect(() => process.kill(pid, 0)).not.toThrow();
    await server.close();
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(/ESRCH/), { timeout: 5000 });
    expect(store.db.select().from(procsTable).all()).toEqual([]);
  } finally {
    await Promise.all(servers.map((server) => server.close()));
    store.close();
  }
});

test.each([true, "ignoreSigterm"] as const)("un crash limpia el grupo aunque el hijo siga vivo: %s", async (child) => {
  const store = openStore({ path: ":memory:" });
  let pid: number | undefined;
  try {
    const { server, fake } = await start({ child, scenario: "crash" }, { procs: createProcs({ store, bootId: "boot" }), killAfterMs: 100 });
    expect(store.db.select().from(procsTable).all()).toHaveLength(1);
    await vi.waitFor(async () => {
      pid = Number(await readFile(fake.childPid, "utf8"));
      expect(() => process.kill(pid!, 0)).not.toThrow();
    }, { timeout: 5000 });
    const { thread } = await server.request("thread/start", {});
    await server.request("turn/start", { threadId: thread.id, input: [] });
    await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow(/ESRCH/), { timeout: 5000 });
    expect(await server.exited).toMatch(/código 1.*falló la configuración/s);
    expect(store.db.select().from(procsTable).all()).toEqual([]);
  } finally {
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await Promise.all(servers.map((server) => server.close()));
    store.close();
  }
});
