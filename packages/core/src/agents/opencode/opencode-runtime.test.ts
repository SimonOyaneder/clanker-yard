import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readTranscript } from "../transcripts";
import type { AgentEvent, AgentRun, RunSpec } from "../runtime";
import type { ModelInfo } from "./api";
import { answer, createFakeOpencode, ev, type FakeServer } from "./fake-opencode";
import { createOpencodeRuntime } from "./opencode-runtime";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "opencode-runtime-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const report = { outcome: "done", summary: "listo", payload: {} };
const luna: ModelInfo = { id: "gpt-6.1-terra", providerID: "openai", variants: [{ id: "low" }, { id: "high" }] };

function spec(over: Partial<RunSpec> = {}): RunSpec {
  return {
    role: "reviewer",
    cwd: "/work/tree",
    systemPrompt: "Eres un reviewer.",
    prompt: "Revisa el diff.",
    model: "openai/gpt-6.1-terra",
    effort: "high",
    native: { sources: [], skills: [] },
    references: [{ label: "repo:AGENTS.md", content: "reglas" }],
    hooks: false,
    tools: "all",
    outputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
    stepRunId: "srn_1",
    ...over,
  };
}

function runtimeWith(onPrompt: (text: string, server: FakeServer) => void | Promise<void>, models: ModelInfo[] = [luna]) {
  const fake = createFakeOpencode(onPrompt, models);
  const runtime = createOpencodeRuntime({
    home,
    baseEnv: { PATH: "/usr/bin", HOME: "/home/simon", GH_TOKEN: "ghp_secreto" },
    launch: fake.launch,
    api: fake.api,
    cli: () => Promise.reject(new Error("este test no usa el CLI")),
    pollMs: 50,
  });
  return { fake, runtime };
}

async function finish(run: AgentRun) {
  const events: AgentEvent[] = [];
  const drain = (async () => {
    for await (const event of run.events) events.push(event);
  })();
  const result = await run.result;
  await drain;
  return { result, events };
}

describe("un run", () => {
  test("levanta su servidor con la config del run, crea la sesión con modelo y variante, y entrega el reporte con lo gastado", async () => {
    const { fake, runtime } = runtimeWith((_text, server) => answer(server, report));

    const run = await runtime.start(spec());
    const { result, events } = await finish(run);

    expect(result).toMatchObject({ status: "success", structured: report, text: "Listo." });
    expect(result.usage).toEqual({ turns: 2, tokensIn: 100, tokensOut: 50, tokensCacheRead: 1000, tokensCacheWrite: 0, costMicros: 10_000, costSource: "runtime" });
    expect(run.ref).toEqual({ runtime: "opencode", sessionId: "ses_1", cwd: "/work/tree" });
    expect(events.map((e) => e.type)).toEqual(["first_token", "tool_start", "tool_end", "tool_start", "tool_end", "usage", "text", "usage"]);
    expect(fake.created).toEqual([{ directory: "/work/tree", agent: "clanker", model: { providerID: "openai", id: "gpt-6.1-terra", variant: "high" }, title: "reviewer" }]);
    expect(fake.prompts).toEqual([{ sessionID: "ses_1", text: "Revisa el diff." }]);

    const [launched] = fake.launches;
    expect(launched).toMatchObject({ executable: "opencode", args: ["serve", "--hostname", "127.0.0.1", "--port", "0"], cwd: "/work/tree", stepRunId: "srn_1" });
    expect(launched?.env.GH_TOKEN).toBeUndefined();
    expect(launched?.env.OPENCODE_PASSWORD).toMatch(/^[\w-]{20,}$/);
    const config = JSON.parse(launched!.env.OPENCODE_CONFIG_CONTENT!) as { agents: { clanker: { system: string } }; plugins: unknown[] };
    expect(config.agents.clanker.system).toContain("Eres un reviewer.");
    expect(config.plugins.at(-1)).toEqual({ package: join(home, "agent-env", "opencode", "report-plugin"), options: { schema: { type: "object" } } });
    expect(await readFile(join(home, "agent-env", "opencode", "report-plugin", "index.js"), "utf8")).toContain('name: "clanker_report"');
    expect(fake.closed()).toBe(1);
  });

  test("el git del agente commitea con la identidad del usuario en el repo y sin credential helper", async () => {
    const { fake, runtime } = runtimeWith((_text, server) => answer(server, report));

    await finish(await runtime.start(spec({ gitIdentity: { name: "Simón", email: "simon@example.com" } })));

    const gitConfig = await readFile(fake.launches[0]!.env.GIT_CONFIG_GLOBAL!, "utf8");
    expect(gitConfig).toBe('[user]\n\tname = "Simón"\n\temail = "simon@example.com"\n[credential]\n\thelper =\n');
  });

  test("un modelo sin la variante pedida corre con la suya y lo avisa, en vez de fallar", async () => {
    const { fake, runtime } = runtimeWith((_text, server) => answer(server, report), [{ id: "big-pickle", providerID: "opencode" }]);

    const { result, events } = await finish(await runtime.start(spec({ model: "opencode/big-pickle" })));

    expect(result.status).toBe("success");
    expect(fake.created[0]?.model).toEqual({ providerID: "opencode", id: "big-pickle" });
    expect(events).toContainEqual({ type: "error", kind: "other", message: expect.stringContaining('no tiene la variante "high"') });
  });

  test("el transcript queda normalizado: prompt, herramientas, texto y resultado", async () => {
    const { runtime } = runtimeWith((_text, server) => answer(server, report));
    const run = await runtime.start(spec());
    await finish(run);

    const page = await readTranscript(join(home, "transcripts", `${run.ref.sessionId}.jsonl`), 0, 100);
    expect(page.entries.map((e) => e.kind)).toEqual(["prompt", "tool_call", "tool_result", "tool_call", "tool_result", "text", "result"]);
    expect(page.entries.at(-1)).toMatchObject({ kind: "result", subtype: "success", isError: false, turns: 2, costUsd: 0.01 });
  });

  test("retomar manda el mensaje a la misma sesión, en un servidor nuevo con el prompt del rol guardado y el esquema del modo nuevo", async () => {
    const { fake, runtime } = runtimeWith((_text, server) => answer(server, report));
    const first = await runtime.start(spec());
    await finish(first);

    const again = await runtime.resume(first.ref, "Sigue con lo pendiente.", { outputSchema: { type: "object", required: ["x"] }, references: [] });
    const { result } = await finish(again);

    expect(result.status).toBe("success");
    expect(fake.created).toHaveLength(1);
    expect(fake.prompts[1]).toEqual({ sessionID: "ses_1", text: "Sigue con lo pendiente." });
    const config = JSON.parse(fake.launches[1]!.env.OPENCODE_CONFIG_CONTENT!) as { agents: { clanker: { system: string } }; plugins: { options?: unknown }[] };
    expect(config.agents.clanker.system).toContain("Eres un reviewer.");
    expect(config.plugins.at(-1)?.options).toEqual({ schema: { type: "object", required: ["x"] } });
  });

  test("sin reporte termina bien pero sin structured: el core lo reintenta como reporte inválido", async () => {
    const { runtime } = runtimeWith((_text, server) => server.emit(ev.started(server.sessionID), ev.text(server.sessionID, "Ya terminé."), ev.succeeded(server.sessionID)));

    const { result } = await finish(await runtime.start(spec()));

    expect(result).toMatchObject({ status: "success", text: "Ya terminé." });
    expect(result.structured).toBeUndefined();
  });

  test("un modelo sin proveedor falla antes de levantar el servidor", async () => {
    const { fake, runtime } = runtimeWith(() => {});
    await expect(runtime.start(spec({ model: "sonnet" }))).rejects.toThrow(/proveedor\/modelo/);
    expect(fake.launches).toEqual([]);
  });
});

describe("cómo termina mal", () => {
  test("una cuota agotada se corta en el primer reintento e interrumpe la sesión", async () => {
    const { fake, runtime } = runtimeWith((_text, server) =>
      server.emit(ev.started(server.sessionID), ev.retry(server.sessionID, 1, { type: "provider.api", message: "Free usage limit reached.", retryAfterMs: 60_000 })),
    );

    const { result } = await finish(await runtime.start(spec()));

    expect(result).toMatchObject({ status: "quota_exhausted", message: expect.stringContaining("Free usage limit reached") });
    expect(result.resetsAt).toBeGreaterThan(Date.now());
    expect(fake.interrupted).toEqual(["ses_1"]);
  });

  test("un login vencido en la ejecución es login_expired con qué hacer", async () => {
    const { runtime } = runtimeWith((_text, server) => server.emit(ev.started(server.sessionID), ev.failed(server.sessionID, { type: "provider.api", message: "Unauthorized", status: 401 })));

    const { result } = await finish(await runtime.start(spec()));

    expect(result).toMatchObject({ status: "login_expired", message: expect.stringContaining("opencode auth login") });
  });

  test("un modelo que opencode no tiene es un error del paso con el mensaje de opencode", async () => {
    const { runtime } = runtimeWith((_text, server) => server.emit(ev.failed(server.sessionID, { type: "provider.no-route", message: "Model unavailable: openai/gpt-5.4-mini" })));

    const { result } = await finish(await runtime.start(spec({ model: "openai/gpt-5.4-mini", effort: undefined })));

    expect(result).toMatchObject({ status: "error", message: "opencode terminó con provider.no-route: Model unavailable: openai/gpt-5.4-mini" });
  });

  test("el tope de turnos interrumpe a un agente que sigue sin entregar el reporte", async () => {
    const { fake, runtime } = runtimeWith((_text, server) => {
      const s = server.sessionID;
      server.emit(ev.started(s), ev.stepStarted(s, "msg_1"), ev.stepEnded(s, "msg_1", "tool-calls"), ev.stepStarted(s, "msg_2"), ev.stepEnded(s, "msg_2", "tool-calls"));
    });

    const { result } = await finish(await runtime.start(spec({ maxTurns: 2 })));

    expect(result).toMatchObject({ status: "error_max_turns", message: expect.stringContaining("2 turnos") });
    expect(fake.interrupted).toEqual(["ses_1"]);
  });

  test("el tope de gasto interrumpe y conserva el reporte si ya lo había entregado", async () => {
    const { runtime } = runtimeWith((_text, server) => {
      const s = server.sessionID;
      server.emit(ev.started(s), ev.stepStarted(s, "msg_1"), ...ev.tool(s, "c1", "clanker_report", report), ev.stepEnded(s, "msg_1", "tool-calls", 0.6));
    });

    const { result } = await finish(await runtime.start(spec({ maxBudgetUsd: 0.5 })));

    expect(result).toMatchObject({ status: "error_max_budget_usd", structured: report });
  });

  test("lo que gasta un subagente cuenta para el total", async () => {
    const { runtime } = runtimeWith((_text, server) => {
      server.emit(ev.stepEnded("ses_child", "msg_9", "stop", 0.3));
      answer(server, report);
    });

    const { result } = await finish(await runtime.start(spec()));

    expect(result.usage).toMatchObject({ turns: 3, costMicros: 310_000 });
  });

  test("interrumpir corta la ejecución y el run termina con error", async () => {
    const { fake, runtime } = runtimeWith((_text, server) => server.emit(ev.started(server.sessionID), ev.stepStarted(server.sessionID, "msg_1")));
    const run = await runtime.start(spec());
    await new Promise((resolve) => setTimeout(resolve, 20));

    await run.interrupt();
    const { result } = await finish(run);

    expect(result).toMatchObject({ status: "error", message: "El run fue interrumpido." });
    expect(fake.interrupted).toEqual(["ses_1"]);
    expect(fake.closed()).toBe(1);
  });

  test("opencode interrumpiendo por su cuenta (se apagó) es un error que lo dice", async () => {
    const { runtime } = runtimeWith((_text, server) => server.emit(ev.started(server.sessionID), ev.interrupted(server.sessionID, "shutdown")));

    const { result } = await finish(await runtime.start(spec()));

    expect(result).toMatchObject({ status: "error", message: expect.stringContaining("shutdown") });
  });

  test("un permiso que espera a una persona corta el run en vez de colgarlo", async () => {
    const { runtime } = runtimeWith((_text, server) =>
      server.emit(ev.started(server.sessionID), { type: "permission.asked", data: { sessionID: server.sessionID, action: "shell", resources: ["git push"] } }),
    );

    const { result } = await finish(await runtime.start(spec()));

    expect(result).toMatchObject({ status: "error", message: expect.stringContaining("permiso") });
  });

  test("si el servidor muere, el run rechaza con lo que dijo", async () => {
    const { runtime } = runtimeWith((_text, server) => {
      server.emit(ev.started(server.sessionID));
      server.crash("opencode serve terminó (código 1): panic: out of memory");
    });

    const run = await runtime.start(spec());
    await expect(run.result).rejects.toThrow("panic: out of memory");
  });
});

describe("probe y opciones", () => {
  const withCli = (answers: Record<string, string | Error>) =>
    createOpencodeRuntime({
      home,
      cli: async (args) => {
        const out = answers[args.join(" ")];
        if (out === undefined || out instanceof Error) throw out ?? new Error(`no se esperaba opencode ${args.join(" ")}`);
        return out;
      },
    });

  test("ofrece los modelos conectados (sin el servicio en segundo plano) y el effort como variante", async () => {
    const options = await withCli({ "--version": "opencode v2.3.0\n", "models --standalone": "opencode/big-pickle\nopenai/gpt-6.1-terra\n" }).describe!();

    expect(options).toMatchObject({ id: "opencode", available: true, models: [{ id: "openai/gpt-6.1-terra" }, { id: "opencode/big-pickle" }], defaultModel: "openai/gpt-6.1-terra" });
    expect(options.efforts.map((e) => e.id)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("los nuevos de OpenAI van primero, de menos a más potente, y terra 6.1 es el modelo con que parte un rol", async () => {
    const options = await withCli({
      "--version": "2.3.0",
      "models --standalone": "openai/gpt-5.6-cyber\nopenai/gpt-6-luna\nopenai/gpt-6.1-sol\nopenai/gpt-6.1-terra\nopencode/big-pickle\n",
    }).describe!();

    expect(options.models.map((m) => m.id)).toEqual(["openai/gpt-6-luna", "openai/gpt-6.1-terra", "openai/gpt-6.1-sol", "openai/gpt-5.6-cyber", "opencode/big-pickle"]);
    expect(options.models[1]?.about).toMatch(/^Recomendado/);
    expect(options.defaultModel).toBe("openai/gpt-6.1-terra");
  });

  test("sin los recomendados conectados no hay default: la UI toma el primero", async () => {
    expect((await withCli({ "--version": "2.3.0", "models --standalone": "opencode/big-pickle\n" }).describe!()).defaultModel).toBeUndefined();
  });

  test("sin opencode, o con opencode 1, no está disponible y dice qué hacer", async () => {
    const missing = withCli({ "--version": new Error('No encuentro "opencode" en el PATH del core: instala opencode (https://opencode.ai).') });
    expect(await missing.probe!()).toContain("instala opencode");
    expect(await missing.describe!()).toMatchObject({ available: false, models: [], message: expect.stringContaining("instala opencode") });
    expect(await withCli({ "--version": "1.19.5" }).probe!()).toContain("muy viejo");
  });

  test("sin proveedores conectados lo dice", async () => {
    expect(await withCli({ "--version": "2.3.0", "models --standalone": "\n" }).describe!()).toMatchObject({ available: true, models: [], message: expect.stringContaining("opencode auth login") });
  });
});

test("el transcript de Claude sigue leyéndose igual", async () => {
  const file = join(home, "claude.jsonl");
  await writeFile(file, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hola" }] } })}\n`);
  expect((await readTranscript(file, 0, 10)).entries).toEqual([{ kind: "text", text: "hola", truncated: false }]);
});
