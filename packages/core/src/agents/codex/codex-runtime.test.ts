import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { git } from "../../git/git";
import { openStore, type Store } from "../../store/store";
import { createFakeCodex, type FakeCodexOptions } from "../../testing/codex/fake-codex";
import type { AgentEvent, AgentRun, RunSpec } from "../runtime";
import { readTranscript } from "../transcripts";
import type { CodexMethods, RpcMessage } from "./api";
import { createCodexRuntime, MIN_CODEX_VERSION } from "./codex-runtime";

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

async function runtimeWith(options: FakeCodexOptions = {}) {
  const fake = await createFakeCodex(home, { responses: [JSON.stringify(report)], ...options });
  const runtime = createCodexRuntime({
    home, store, executable: fake.executable, args: fake.args,
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
      params: { cwd: home, model: spec.model, sandbox: "danger-full-access", approvalPolicy: "never", developerInstructions: "Eres juguete.\n\n# reglas\nNo publiques.", config: { project_doc_max_bytes: 32768 } },
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
    await git(home, ["-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "test: identidad"], env);
    expect(await git(home, ["log", "-1", "--format=%an <%ae>"], env)).toBe("Usuario <usuario@example.com>");
  });

  test("retoma el mismo hilo desde otro runtime con esquema y referencias nuevos", async () => {
    const { runtime, fake } = await runtimeWith();
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
  test.each([
    ["login_expired", "login_expired"], ["quota_exhausted", "quota_exhausted"],
  ] as const)("%s conserva el estado de entorno", async (scenario, status) => {
    const { runtime } = await runtimeWith({ scenario });
    expect((await finish(await runtime.start(spec))).result.status).toBe(status);
  });

  test("modelo inexistente es error, no cuota ni login", async () => {
    const { runtime } = await runtimeWith();
    expect((await finish(await runtime.start({ ...spec, model: "missing" }))).result).toMatchObject({ status: "error", message: expect.stringContaining("modelNotFound") });
  });

  test("el crash rechaza con stderr y cierra el stream", async () => {
    const { runtime } = await runtimeWith({ scenario: "crash" });
    await expect(finish(await runtime.start(spec))).rejects.toThrow(/falló la configuración/);
  });

  test("interrumpir termina el run y espera que cierre el proceso", async () => {
    const { runtime } = await runtimeWith({ holdTurn: true });
    const run = await runtime.start(spec);
    await run.interrupt();
    expect((await finish(run)).result).toMatchObject({ status: "error", message: "El run fue interrumpido." });
    await run.interrupt();
  });

  test("el tope de turnos corta cuando todavía no hay reporte", async () => {
    const { runtime } = await runtimeWith({ responses: ["Sigo trabajando."] });
    expect((await finish(await runtime.start({ ...spec, maxTurns: 1 }))).result.status).toBe("error_max_turns");
  });

  test("el tope estimado conserva un reporte ya entregado sin reportar costo como si lo supiera Codex", async () => {
    const { runtime } = await runtimeWith();
    expect((await finish(await runtime.start({ ...spec, maxBudgetUsd: 0.00001 }))).result).toMatchObject({
      status: "error_max_budget_usd", structured: { outcome: "ok" }, usage: { costMicros: 0, costSource: "estimate" },
    });
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
