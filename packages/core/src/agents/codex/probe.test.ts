import type { ChildProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexStatus } from "@clanker/api";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Procs } from "../../procs/procs";
import { createFakeCodex, type FakeCodexOptions } from "../../testing/codex/fake-codex";
import type { CodexMethods, RpcMessage } from "./api";
import { probeCodex, type CodexProbeOptions } from "./probe";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codex-probe-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function run(options: FakeCodexOptions = {}, input: Partial<CodexProbeOptions> = {}) {
  const fake = await createFakeCodex(dir, options);
  const result = await probeCodex({ ...fake, cwd: dir, ...input });
  expect(CodexStatus.safeParse(result.status).success).toBe(true);
  return { ...result, fake };
}

async function requests(path: string): Promise<RpcMessage[]> {
  return (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as RpcMessage);
}

async function expectClosed(pidFile: string) {
  const pid = Number(await readFile(pidFile, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
}

test("lee cuenta y límites sin iniciar threads ni turnos, y espera el cierre", async () => {
  const { status, limits, fake } = await run({ fragment: true });
  expect(status).toMatchObject({
    state: "ready", executable: process.execPath, version: "0.169.1", plan: "self_serve_business_prolite",
    usage: { windows: [{ id: "codex:primary", windowMins: 10080, usedPercent: 4, resetsAt: 1795542935000 }] },
  });
  expect(status).not.toHaveProperty("mode");
  expect(limits?.ordinaryUsageAllowed).toBe(true);
  expect((await requests(fake.requests)).map((request) => request.method)).toEqual([
    "initialize", "initialized", "account/read", "account/rateLimits/read",
  ]);
  expect((await requests(fake.requests)).slice(2)).toEqual([
    { id: 2, method: "account/read", params: { refreshToken: false } },
    { id: 3, method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } },
  ]);
  await expectClosed(fake.pidFile);
});

test("usa codexEnv tanto al leer la versión como al lanzar el servidor", async () => {
  const { fake } = await run({}, {
    baseEnv: {
      PATH: process.env.PATH, HOME: dir, USER: "tester", LANG: "es_CL.UTF-8", CODEX_HOME: join(dir, "codex"),
      OPENAI_API_KEY: "secret-openai", CODEX_ACCESS_TOKEN: "secret-token", GH_TOKEN: "secret-github",
      ANTHROPIC_API_KEY: "secret-anthropic", SSH_AUTH_SOCK: "secret-ssh",
    },
  });
  for (const file of [fake.environment, fake.versionEnvironment]) {
    const text = await readFile(file, "utf8");
    expect(JSON.parse(text)).toMatchObject({
      PATH: process.env.PATH, HOME: dir, USER: "tester", LANG: "es_CL.UTF-8", CODEX_HOME: join(dir, "codex"),
    });
    expect(text).not.toContain("secret-");
  }
});

test("encuentra el binario en el PATH indicado", async () => {
  const fake = await createFakeCodex(dir);
  const executable = join(dir, "codex");
  await writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" "${fake.args[0]}" "$@"\n`);
  await chmod(executable, 0o700);
  const { status } = await probeCodex({ cwd: dir, baseEnv: { PATH: dir, HOME: dir } });
  expect(status).toMatchObject({ state: "ready", executable: await realpath(executable), version: "0.169.1" });
  await expectClosed(fake.pidFile);
});

test("sin un codex en PATH informa not_installed sin usar el PATH del agente", async () => {
  expect(await probeCodex({ cwd: dir, baseEnv: { PATH: dir } })).toMatchObject({
    status: { state: "not_installed", message: expect.stringContaining("PATH") },
  });
});

test("un ejecutable explícito inexistente informa not_installed", async () => {
  expect(await probeCodex({ cwd: dir, executable: join(dir, "missing") })).toMatchObject({
    status: { state: "not_installed" },
  });
});

test.each([
  ["0.169.0", "outdated"], ["0.168.99", "outdated"], ["0.169.1", "ready"],
  ["0.170.0", "ready"], ["1.0.0", "ready"], ["unknown", "error"],
])("valida la versión %s antes de pedir cuenta (%s)", async (version, state) => {
  const { status, fake } = await run({ version });
  expect(status.state).toBe(state);
  if (state !== "ready") {
    expect(status.message).toBeTruthy();
    await expect(readFile(fake.requests, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }
});

test.each([
  null, { type: "apiKey" }, { type: "amazonBedrock", usesCodexManagedCredentials: true }, { type: "gcp" },
] satisfies CodexMethods["account/read"]["result"]["account"][])("exige login ChatGPT para account=%j", async (account) => {
  const { status, fake } = await run({ account });
  expect(status).toMatchObject({ state: "login_required", message: expect.stringContaining("codex login") });
  if (account?.type === "apiKey") expect(status.message).toContain("API key");
  expect((await requests(fake.requests)).map((request) => request.method)).not.toContain("account/rateLimits/read");
  await expectClosed(fake.pidFile);
});

test("conserva la simulación login_expired antigua como cuenta ausente", async () => {
  const { status, fake } = await run({ scenario: "login_expired" });
  expect(status.state).toBe("login_required");
  await expectClosed(fake.pidFile);
});

test.each(["account/read", "account/rateLimits/read"] as const)("un rechazo auth de %s informa login_expired", async (method) => {
  const { status, fake } = await run({ rpcErrors: { [method]: { code: -32603, message: "failed to fetch codex rate limits: 401 Unauthorized" } } });
  expect(status).toMatchObject({ state: "login_expired", message: expect.stringContaining("codex login") });
  await expectClosed(fake.pidFile);
});

test.each([
  { code: -32600, message: "codex account authentication required to read rate limits" },
  { code: -32603, message: "failed to fetch codex rate limits: HTTP status 401" },
])("reconoce evidencia auth en un error RPC %j", async (rpc) => {
  const { status, fake } = await run({ rpcErrors: { "account/rateLimits/read": rpc } });
  expect(status.state).toBe("login_expired");
  await expectClosed(fake.pidFile);
});

test.each(["initialize", "account/read", "account/rateLimits/read"] as const)("un error general de %s no se confunde con login", async (method) => {
  const { status, fake } = await run({ rpcErrors: { [method]: { code: -32603, message: "backend unavailable" } } });
  expect(status).toMatchObject({ state: "error", message: expect.stringContaining("backend unavailable") });
  await expectClosed(fake.pidFile);
});

test("un fallo de red al refrescar no se confunde con credenciales rechazadas", async () => {
  const { status, fake } = await run({
    rpcErrors: { "account/read": { code: -32603, message: "Network unavailable while attempting to refresh token" } },
  });
  expect(status.state).toBe("error");
  await expectClosed(fake.pidFile);
});

test("un fallo del proceso se devuelve como error y el proceso ya está cerrado", async () => {
  const { status, fake } = await run({ startupCrash: true });
  expect(status).toMatchObject({ state: "error", message: expect.stringContaining("falló la configuración") });
  await expectClosed(fake.pidFile);
});

test("cuota agotada no requiere inferencia y conserva el snapshot", async () => {
  const { status, limits, fake } = await run({ scenario: "quota_exhausted" });
  expect(status).toMatchObject({ state: "quota_exhausted", resetsAt: 1795542935000 });
  expect(limits?.ordinaryUsageAllowed).toBe(false);
  expect((await requests(fake.requests)).map((request) => request.method)).not.toContain("turn/start");
  await expectClosed(fake.pidFile);
});

test("un plan sin ventanas conserva créditos y motivo explícito de cuota", async () => {
  const { status } = await run({
    rateLimits: {
      limitId: "codex", primary: null, secondary: null, spendControlReached: null,
      credits: { hasCredits: true, unlimited: false, balance: null },
      rateLimitReachedType: "workspace_member_credits_depleted",
    },
    rateLimitsByLimitId: null,
  });
  expect(status).toMatchObject({
    state: "quota_exhausted", plan: "self_serve_business_prolite",
    usage: { windows: [], credits: { hasCredits: true, unlimited: false, balance: null } },
  });
  expect(status).not.toHaveProperty("resetsAt");
});

test("un plan Pro trae dos ventanas y créditos sin suponer sus duraciones", async () => {
  const bucket = {
    limitId: "codex",
    primary: { usedPercent: 20, windowDurationMins: 120, resetsAt: 2000000000 },
    secondary: { usedPercent: 45, windowDurationMins: 10080, resetsAt: 2100000000 },
    credits: { hasCredits: true, unlimited: false, balance: "12.50" }, spendControlReached: false,
  };
  const { status, fake } = await run({
    account: { type: "chatgpt", planType: "pro", email: null, workspaceName: null },
    rateLimits: bucket, rateLimitsByLimitId: { codex: bucket },
  });
  expect(status).toMatchObject({
    state: "ready", plan: "pro",
    usage: {
      windows: [
        { id: "codex:primary", usedPercent: 20, windowMins: 120, resetsAt: 2000000000000 },
        { id: "codex:secondary", usedPercent: 45, windowMins: 10080, resetsAt: 2100000000000 },
      ],
      credits: { hasCredits: true, unlimited: false, balance: "12.50" },
    },
  });
  await expectClosed(fake.pidFile);
});

test("registra el proceso del servidor cuando se pasa procs y lo cierra", async () => {
  const tracked: ChildProcess[] = [];
  const procs: Procs = {
    bootId: "probe",
    track: vi.fn((child: ChildProcess) => { tracked.push(child); }),
    killOrphans: vi.fn(() => 0),
    stop: vi.fn(async () => {}),
  };
  const { status } = await run({}, { procs });
  expect(status.state).toBe("ready");
  expect(procs.track).toHaveBeenCalledOnce();
  expect(procs.track).toHaveBeenCalledWith(tracked[0], { kind: "agent", stepRunId: undefined });
  expect(tracked[0]?.exitCode !== null || tracked[0]?.signalCode !== null).toBe(true);
});
