import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { git } from "../../git/git";
import { openStore, type Store } from "../../store/store";
import { createFakeCodex, type FakeCodexOptions } from "../../testing/codex/fake-codex";
import type { AgentEvent, AgentRun, RunSpec } from "../runtime";
import { readTranscript } from "../transcripts";
import type { CodexMethods, RateLimitSnapshot, RpcMessage, TurnError } from "./api";
import { createCodexRuntime, MAX_PROVIDER_RETRIES, MIN_CODEX_VERSION } from "./codex-runtime";
import { threadOptions } from "./config";

let home: string;
let store: Store;
const report = { outcome: "ok", summary: "Listo", decisions: null, payload: { saludo: "Hola" } };
let spec: RunSpec;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "codex-runtime-"));
  store = openStore({ path: ":memory:" });
  spec = {
    role: "juguete", cwd: home, systemPrompt: "Eres juguete.", prompt: "Saluda.", model: "gpt-5.6-luna",
    effort: "low", references: [{ label: "reglas", content: "No publiques." }], hooks: false, tools: "all",
    outputSchema: {
      type: "object", properties: {
        outcome: { type: "string" }, summary: { type: "string" },
        decisions: { type: "array", items: { type: "string" } },
        payload: { type: "object", properties: { saludo: { type: "string" } }, required: ["saludo"], additionalProperties: false },
      }, required: ["outcome", "summary", "payload"], additionalProperties: false,
    },
    gitIdentity: { name: "Usuario", email: "usuario@example.com" },
  };
});
afterEach(async () => {
  store.close();
  await rm(home, { recursive: true, force: true });
});

async function runtimeWith(options: FakeCodexOptions = {}, interruptSettleMs = 100) {
  const fake = await createFakeCodex(home, { responses: [JSON.stringify(report)], ...options });
  const runtime = createCodexRuntime({
    home, store, executable: fake.executable, args: fake.args,
    interruptSettleMs,
    baseEnv: {
      PATH: process.env.PATH, HOME: home, USER: "user", LANG: "en_US.UTF-8",
      OPENAI_API_KEY: "secret", OPENAI_BASE_URL: "invalid", CODEX_API_KEY: "secret", CODEX_ACCESS_TOKEN: "secret",
      GH_TOKEN: "secret", LINEAR_API_KEY: "secret", SSH_AUTH_SOCK: "/sock",
      GH_CONFIG_DIR: "/user/gh", GIT_CONFIG_GLOBAL: "/user/git", GIT_CONFIG_NOSYSTEM: "0",
    },
  });
  return { fake, runtime };
}

async function finish(run: AgentRun) {
  const events: AgentEvent[] = [];
  const drain = (async () => { for await (const event of run.events) events.push(event); })();
  const result = await run.result;
  await drain;
  return { result, events };
}

async function requests(path: string) {
  return (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as RpcMessage);
}

describe("ejecución", () => {
  test("entrega el reporte normalizado, tokens y transcript; el core calcula el costo", async () => {
    const { runtime, fake } = await runtimeWith({ duplicateUsage: true });
    const run = await runtime.start(spec);
    const { result, events } = await finish(run);
    await run.interrupt();
    expect(result).toMatchObject({
      status: "success", structured: { outcome: "ok", summary: "Listo", payload: { saludo: "Hola" } },
      usage: { turns: 1, tokensIn: 20, tokensOut: 12, tokensCacheRead: 80, costMicros: 0, costSource: "estimate" },
    });
    expect(result.structured).not.toHaveProperty("decisions");
    expect(runtime.capabilities.costPerTurn).toBe(false);
    expect(events.filter((event) => event.type === "usage")).toHaveLength(1);
    const sent = await requests(fake.requests);
    expect(sent.find((message) => message.method === "thread/start")).toMatchObject({
      params: {
        cwd: home, model: spec.model, sandbox: "danger-full-access", approvalPolicy: "never", developerInstructions: "Eres juguete.\n\n# reglas\nNo publiques.",
        config: {
          project_doc_max_bytes: 32768,
          "shell_environment_policy.set": {
            GIT_AUTHOR_NAME: "Usuario", GIT_AUTHOR_EMAIL: "usuario@example.com",
            GIT_COMMITTER_NAME: "Usuario", GIT_COMMITTER_EMAIL: "usuario@example.com",
          },
        },
      },
    });
    expect(sent.find((message) => message.method === "thread/start")).not.toHaveProperty("params.baseInstructions");
    expect(sent.find((message) => message.method === "turn/start")).toMatchObject({ params: { input: [{ type: "text", text: "Saluda." }], effort: "low", outputSchema: { additionalProperties: false, required: ["outcome", "summary", "decisions", "payload"] } } });
    const page = await readTranscript(join(home, "transcripts", `${run.ref.sessionId}.jsonl`), 0, 100);
    expect(page.entries.map((entry) => entry.kind)).toEqual(["prompt", "text", "result"]);
    expect(page.entries.at(-1)).toMatchObject({ kind: "result", subtype: "success", turns: 1, costUsd: expect.any(Number) });
  });

  test("el entorno real solo lleva la lista blanca y git/gh generados; git commitea con la identidad del repo", async () => {
    const { runtime, fake } = await runtimeWith();
    await finish(await runtime.start(spec));
    const env = JSON.parse(await readFile(fake.environment, "utf8")) as Record<string, string>;
    const keys = ["PATH", "HOME", "USER", "LANG", "GH_CONFIG_DIR", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"];
    if (process.platform === "darwin") keys.push("__CF_USER_TEXT_ENCODING");
    expect(Object.keys(env).sort()).toEqual(keys.sort());
    expect(env.GH_CONFIG_DIR).toBe(join(home, "agent-env", "codex", "gh"));
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(await readFile(env.GIT_CONFIG_GLOBAL!, "utf8")).toBe('[user]\n\tname = "Usuario"\n\temail = "usuario@example.com"\n[credential]\n\thelper =\n');
    await git(home, ["init"], env);
    await git(home, ["config", "user.name", "Identidad del checkout"], env);
    await git(home, ["config", "user.email", "checkout@example.com"], env);
    const shellEnv = { ...env, ...threadOptions(spec).config!["shell_environment_policy.set"] };
    await git(home, ["-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "test: identidad"], shellEnv);
    expect(await git(home, ["log", "-1", "--format=%an <%ae>|%cn <%ce>"], shellEnv)).toBe("Usuario <usuario@example.com>|Usuario <usuario@example.com>");
  });

  test("retoma el mismo hilo desde otro runtime con esquema y referencias nuevos", async () => {
    const { runtime, fake } = await runtimeWith({ responses: [JSON.stringify(report), JSON.stringify({ next: "Listo" })] });
    const first = await runtime.start(spec);
    await finish(first);
    const again = createCodexRuntime({ home, store, executable: fake.executable, args: fake.args });
    const run = await again.resume(first.ref, "Otra vez.", { maxTurns: 1, outputSchema: { type: "object", properties: { next: { type: "string" } }, required: ["next"] }, references: [{ label: "nuevo", content: "Actualizado" }] });
    const { result, events } = await finish(run);
    expect(result).toMatchObject({
      status: "success", usage: { turns: 1, tokensIn: 20, tokensOut: 12, tokensCacheRead: 80 },
    });
    expect(events.filter((event) => event.type === "usage")).toHaveLength(1);
    const sent = await requests(fake.requests);
    expect(sent.filter((message) => message.method === "thread/start")).toHaveLength(1);
    expect(sent.find((message) => message.method === "thread/resume")).toMatchObject({ params: { threadId: first.ref.sessionId, developerInstructions: "Eres juguete.\n\n# nuevo\nActualizado" } });
    expect(sent.filter((message) => message.method === "turn/start").at(-1)).toMatchObject({ params: { input: [{ type: "text", text: "Otra vez." }], outputSchema: { required: ["next"] } } });
    expect(run.ref).toEqual(first.ref);
  });

  test("sin JSON devuelve success sin structured para la validación y reintento del core", async () => {
    const { runtime } = await runtimeWith({ responses: ["Listo."] });
    const { result } = await finish(await runtime.start(spec));
    expect(result).toMatchObject({ status: "success", text: "Listo." });
    expect(result.structured).toBeUndefined();
  });

  test("un esfuerzo no soportado usa el default del modelo y avisa", async () => {
    const { runtime, fake } = await runtimeWith();
    const { events } = await finish(await runtime.start({ ...spec, effort: "max" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "error", message: expect.stringContaining("corre con low") }));
    expect((await requests(fake.requests)).find((message) => message.method === "turn/start")).toMatchObject({ params: { effort: "low" } });
  });

  test("sin esfuerzo no consulta el catálogo de modelos", async () => {
    const { runtime, fake } = await runtimeWith();
    delete spec.effort;
    expect((await finish(await runtime.start(spec))).result.status).toBe("success");
    const sent = await requests(fake.requests);
    expect(sent.some((message) => message.method === "model/list")).toBe(false);
    expect(sent.find((message) => message.method === "turn/start")).not.toHaveProperty("params.effort");
  });

  test("rechaza mapas dinámicos del reporte antes de lanzar el proceso", async () => {
    const { runtime, fake } = await runtimeWith();
    await expect(runtime.start({
      ...spec, outputSchema: { type: "object", additionalProperties: { type: "integer" } },
    })).rejects.toThrow(/Codex no admite mapas dinámicos/);
    await expect(readFile(fake.pidFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rechaza ToolPolicy no representable antes de lanzar el proceso", async () => {
    const { runtime, fake } = await runtimeWith();
    await expect(runtime.start({ ...spec, tools: { deny: ["Edit"] } })).rejects.toThrow(/ToolPolicy/);
    await expect(readFile(fake.pidFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("fallos y topes", () => {
  test("sin sesión devuelve login_expired antes de consultar cuota o iniciar inferencia", async () => {
    const { runtime, fake } = await runtimeWith({ scenario: "login_expired" });
    expect((await finish(await runtime.start(spec))).result).toMatchObject({ status: "login_expired", message: expect.stringContaining("codex login") });
    const sent = await requests(fake.requests);
    expect(sent.some((message) => message.method === "account/read")).toBe(true);
    expect(sent.some((message) => message.method === "account/rateLimits/read" || message.method === "turn/start")).toBe(false);
  });

  test("modelo inexistente es error, no cuota ni login", async () => {
    const { runtime } = await runtimeWith();
    expect((await finish(await runtime.start({ ...spec, model: "missing" }))).result).toMatchObject({ status: "error", message: expect.stringContaining("modelNotFound") });
  });

  test("el crash rechaza con stderr y cierra el stream", async () => {
    const { runtime } = await runtimeWith({ scenario: "crash" });
    await expect(finish(await runtime.start(spec))).rejects.toThrow(/falló la configuración/);
  });

  test("interrumpir espera turn/completed antes de cerrar el proceso", async () => {
    const { runtime, fake } = await runtimeWith({ holdTurn: true, holdInterruptCompletion: true }, 15_000);
    const run = await runtime.start(spec);
    const pid = Number(await readFile(fake.pidFile, "utf8"));
    const interrupted = run.interrupt();
    try {
      await vi.waitFor(async () => expect((await requests(fake.requests)).some((message) => message.method === "turn/interrupt")).toBe(true), { timeout: 5000 });
      expect(await Promise.race([interrupted.then(() => "closed"), delay(100, "pending")])).toBe("pending");
      expect(await Promise.race([run.result.then(() => "closed"), delay(100, "pending")])).toBe("pending");
    } finally {
      process.kill(pid, "SIGUSR1");
      const completion = await Promise.race([interrupted.then(() => "closed"), delay(5000, "pending", { ref: false })]);
      await interrupted;
      expect(completion).toBe("closed");
    }
    expect((await finish(run)).result).toMatchObject({ status: "error", message: "El run fue interrumpido." });
    await run.interrupt();
    expect((await requests(fake.requests)).filter((message) => message.method === "turn/interrupt")).toMatchObject([
      { params: { threadId: run.ref.sessionId, turnId: expect.any(String) } },
    ]);
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  });

  test.each(["Sigo trabajando.", JSON.stringify({ ...report, payload: { saludo: 7 } })])("el tope de turnos corta sin reporte válido: %s", async (response) => {
    const { runtime, fake } = await runtimeWith({ responses: [response], holdAfterUsage: true });
    expect((await finish(await runtime.start({ ...spec, maxTurns: 1 }))).result.status).toBe("error_max_turns");
    expect((await requests(fake.requests)).some((message) => message.method === "turn/interrupt")).toBe(true);
  });

  test("un reporte válido evita cortar por turnos", async () => {
    const { runtime, fake } = await runtimeWith();
    expect((await finish(await runtime.start({ ...spec, maxTurns: 1 }))).result).toMatchObject({ status: "success", structured: { outcome: "ok" } });
    expect((await requests(fake.requests)).some((message) => message.method === "turn/interrupt")).toBe(false);
  });

  test("el tope estimado conserva un reporte ya entregado sin reportar costo como si lo supiera Codex", async () => {
    const { runtime } = await runtimeWith();
    expect((await finish(await runtime.start({ ...spec, maxBudgetUsd: 0.00001 }))).result).toMatchObject({
      status: "error_max_budget_usd", structured: { outcome: "ok" }, usage: { costMicros: 0, costSource: "estimate" },
    });
  });

  test("el tope de gasto interrumpe aunque todavía no haya reporte", async () => {
    const { runtime, fake } = await runtimeWith({ responses: ["Sigo trabajando."], holdAfterUsage: true });
    const { result } = await finish(await runtime.start({ ...spec, maxBudgetUsd: 0.00001 }));
    expect(result.status).toBe("error_max_budget_usd");
    expect(result.structured).toBeUndefined();
    expect((await requests(fake.requests)).some((message) => message.method === "turn/interrupt")).toBe(true);
  });

  test.each([
    { silent: ["turn/interrupt"] },
    { interruptWithoutCompletion: true },
  ])("interrumpir cierra el proceso aunque no confirme el fin: %j", async (options) => {
    const { runtime, fake } = await runtimeWith({ holdTurn: true, ...options });
    const run = await runtime.start(spec);
    await run.interrupt();
    expect((await finish(run)).result.status).toBe("error");
    const pid = Number(await readFile(fake.pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    await run.interrupt();
  });

  test.each(["failed", "interrupted"] as const)("un turno %s no usa el JSON como éxito", async (turnStatus) => {
    const { runtime } = await runtimeWith({ turnStatus });
    const { result } = await finish(await runtime.start(spec));
    expect(result.status).toBe("error");
    expect(result.structured).toBeUndefined();
  });

  test.each(["thread/start", "turn/start", "account/read"])("un error RPC de %s no se inventa un estado de entorno", async (method) => {
    const { runtime, fake } = await runtimeWith({ requestError: { method, error: { code: -32603, message: "usageLimitExceeded unauthorized" } } });
    await expect(runtime.start(spec)).rejects.toThrow(/app-server rechazó/);
    const pid = Number(await readFile(fake.pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  });

  test.each([
    ["completed", undefined, "success"],
    ["failed", "unauthorized", "login_expired"],
    ["failed", "usageLimitExceeded", "quota_exhausted"],
  ] as const)("un error RPC al leer cuota deja que el turno %s (%s) determine %s", async (turnStatus, codexErrorInfo, status) => {
    const { runtime, fake } = await runtimeWith({
      requestError: { method: "account/rateLimits/read", error: { code: -32603, message: "usageLimitExceeded unauthorized" } },
      turnStatus,
      ...(codexErrorInfo === undefined ? {} : { turnError: { message: codexErrorInfo, codexErrorInfo, additionalDetails: null } }),
    });
    const { result } = await finish(await runtime.start(spec));
    expect(result.status).toBe(status);
    expect(result.resetsAt).toBeUndefined();
    expect((await requests(fake.requests)).filter((message) => message.method === "turn/start")).toHaveLength(1);
    const pid = Number(await readFile(fake.pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  });

  test.each(["modelNotFound", "contextWindowExceeded"])("%s indica qué cambiar", async (codexErrorInfo) => {
    const { runtime } = await runtimeWith({ turnStatus: "failed", turnError: { message: "falló", codexErrorInfo, additionalDetails: null } });
    expect((await finish(await runtime.start(spec))).result).toMatchObject({
      status: "error", message: expect.stringMatching(/perfil|sesión nueva/),
    });
  });
});

describe("reintentos del proveedor", () => {
  const failures: TurnError["codexErrorInfo"][] = [
    "serverOverloaded", "rateLimitExceeded", { httpConnectionFailed: { httpStatusCode: 503 } },
    { responseStreamDisconnected: { httpStatusCode: 500 } },
  ];
  test.each(failures)("%j puede recuperarse sin reenviar el turno", async (codexErrorInfo) => {
    const { runtime, fake } = await runtimeWith({ providerRetries: { error: { codexErrorInfo, message: "transitorio", additionalDetails: null }, count: MAX_PROVIDER_RETRIES } });
    expect((await finish(await runtime.start(spec))).result.status).toBe("success");
    const sent = await requests(fake.requests);
    expect(sent.filter((message) => message.method === "turn/start")).toHaveLength(1);
    expect(sent.some((message) => message.method === "turn/interrupt")).toBe(false);
  });

  test.each(failures)("%j se corta al superar el límite de reintentos", async (codexErrorInfo) => {
    const { runtime, fake } = await runtimeWith({
      providerRetries: { error: { codexErrorInfo, message: "transitorio", additionalDetails: null }, count: MAX_PROVIDER_RETRIES + 1 },
      holdAfterUsage: true,
    });
    expect((await finish(await runtime.start(spec))).result).toMatchObject({ status: "error", message: expect.stringContaining("reintentos") });
    const sent = await requests(fake.requests);
    expect(sent.filter((message) => message.method === "turn/start")).toHaveLength(1);
    expect(sent.some((message) => message.method === "turn/interrupt")).toBe(true);
  });
});

describe("cuota y probe sin inferencia", () => {
  const exhausted: RateLimitSnapshot = {
    limitId: "codex", primary: { usedPercent: 100, windowDurationMins: 60, resetsAt: 2_000_000_000 },
    secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 2_000_100_000 },
    credits: null, spendControlReached: false,
  };

  test("ordinaryUsageAllowed false corta antes de inferencia y espera todas las ventanas agotadas", async () => {
    const { runtime, fake } = await runtimeWith({ ordinaryUsageAllowed: false, rateLimits: exhausted });
    expect((await finish(await runtime.start(spec))).result).toMatchObject({ status: "quota_exhausted", resetsAt: 2_000_100_000_000 });
    expect((await requests(fake.requests)).some((message) => message.method === "turn/start")).toBe(false);
  });

  test("usageLimitExceeded relee los límites del run para obtener el reset", async () => {
    const { runtime, fake } = await runtimeWith({ scenario: "quota_exhausted", ordinaryUsageAllowed: true, rateLimits: exhausted });
    expect((await finish(await runtime.start(spec))).result).toMatchObject({ status: "quota_exhausted", resetsAt: 2_000_100_000_000 });
    expect((await requests(fake.requests)).filter((message) => message.method === "account/rateLimits/read")).toHaveLength(2);
  });

  test("si falla la relectura conserva cuota agotada, pero no inventa un reset", async () => {
    const { runtime } = await runtimeWith({
      scenario: "quota_exhausted", ordinaryUsageAllowed: true,
      requestError: { method: "account/rateLimits/read", after: 1, error: { code: -32603, message: "backend caído" } },
    });
    const { result } = await finish(await runtime.start(spec));
    expect(result.status).toBe("quota_exhausted");
    expect(result.resetsAt).toBeUndefined();
  });

  test.each([
    { rateLimits: { ...exhausted, limitId: null } },
    { rateLimits: { ...exhausted, primary: { ...exhausted.primary!, resetsAt: null } } },
    { rateLimits: { ...exhausted, primary: null, secondary: null } },
    { rateLimits: exhausted, rateLimitsByLimitId: { codex: exhausted, other: { ...exhausted, limitId: "other" } } },
  ])("no atribuye un reset desconocido o ambiguo: %j", async (options) => {
    const { runtime } = await runtimeWith({ ordinaryUsageAllowed: false, ...options });
    const { result } = await finish(await runtime.start(spec));
    expect(result.status).toBe("quota_exhausted");
    expect(result.resetsAt).toBeUndefined();
  });

  test("ordinaryUsageAllowed null no bloquea", async () => {
    const { runtime } = await runtimeWith({ ordinaryUsageAllowed: null });
    expect((await finish(await runtime.start(spec))).result.status).toBe("success");
  });

  test.each([
    ["ready", undefined], ["quota_exhausted", /cuota/], ["login_expired", /codex login/],
  ] as const)("probe %s consulta la causa y cierra sin inferencia", async (scenario, problem) => {
    const { runtime, fake } = await runtimeWith({ scenario });
    const result = await runtime.probe!();
    if (problem) expect(result).toMatch(problem);
    else expect(result).toBeUndefined();
    const sent = await requests(fake.requests);
    expect(sent.some((message) => message.method === "account/read")).toBe(true);
    expect(sent.some((message) => message.method === "turn/start" || message.method === "thread/start")).toBe(false);
    const pid = Number(await readFile(fake.pidFile, "utf8"));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(/ESRCH/), { timeout: 5000 });
  });

  test("un error RPC del probe conserva el diagnóstico sin fingir que la causa se fue", async () => {
    const { runtime, fake } = await runtimeWith({ requestError: { method: "account/rateLimits/read", error: { code: -32603, message: "backend caído" } } });
    expect(await runtime.probe!()).toContain("backend caído");
    const pid = Number(await readFile(fake.pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  });
});

describe("opciones", () => {
  test.each(["0.168.0", "sin-version"])("una versión %s no se ofrece", async (version) => {
    const { runtime } = await runtimeWith({ version });
    expect(await runtime.describe!()).toMatchObject({ id: "codex", available: false, message: expect.stringMatching(/versión|viejo/) });
  });

  test("sin el ejecutable dice qué instalar", async () => {
    const runtime = createCodexRuntime({ home, store, executable: join(home, "missing") });
    expect(await runtime.describe!()).toMatchObject({ id: "codex", available: false, models: [], message: expect.stringContaining("instala Codex") });
  });

  test("lista modelos paginados, recomendados y esfuerzos del catálogo", async () => {
    const model = (name: string): CodexMethods["model/list"]["result"]["data"][number] => ({
      id: name, model: name, displayName: name, supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }, { reasoningEffort: "xhigh", description: "Extra" }], defaultReasoningEffort: "high", isDefault: name === "gpt-6.1-terra",
    });
    const { runtime } = await runtimeWith({ version: MIN_CODEX_VERSION, models: ["other", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"].map(model), modelPageSize: 1 });
    const options = await runtime.describe!();
    expect(options.available).toBe(true);
    expect(options.models.map((item) => item.id)).toEqual(["gpt-6-luna", "gpt-6.1-terra", "gpt-6.1-sol", "other"]);
    expect(options.defaultModel).toBe("gpt-6.1-terra");
    expect(options.efforts.map((item) => item.id)).toEqual(["high", "xhigh", "max"]);
  });
});
