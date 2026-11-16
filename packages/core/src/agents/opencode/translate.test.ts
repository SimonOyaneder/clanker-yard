import { describe, expect, test } from "vitest";
import type { OpencodeEvent } from "./api";
import { parseModels, versionProblem } from "./cli";
import { ev } from "./fake-opencode";
import { createTranslator, statusOfError } from "./translate";

const S = "ses_main";

describe("errores", () => {
  test.each([
    [{ type: "provider.api", message: "Unauthorized", status: 401 }, "login_expired"],
    [{ type: "provider.auth", message: "Token refresh failed" }, "login_expired"],
    [{ type: "provider.api", message: "slow down", status: 429, retryAfterMs: 30_000 }, "quota_exhausted"],
    [{ type: "provider.api", message: "Free usage limit reached. Subscribe to keep going." }, "quota_exhausted"],
    [{ type: "provider.no-route", message: "Model unavailable: openai/gpt-5.4-mini" }, "error"],
    [{ type: "provider.api", message: "Overloaded", status: 529 }, "error"],
  ])("%j es %s", (error, status) => {
    expect(statusOfError(error).status).toBe(status);
  });

  test("una cuota con retry-after dice cuándo se reinicia y un login vencido dice qué hacer", () => {
    expect(statusOfError({ type: "provider.api", message: "slow", status: 429, retryAfterMs: 30_000 }, 1_000)).toMatchObject({ resetsAt: 31_000 });
    expect(statusOfError({ type: "provider.api", message: "Unauthorized", status: 401 }).message).toContain("opencode auth login");
  });
});

describe("traductor", () => {
  test("cada paso que termina es un turno con su costo, tokens y modelo; el razonamiento se cobra como salida", () => {
    const t = createTranslator(S);
    t.handle(ev.stepStarted(S, "msg_1", { providerID: "openai", id: "gpt-6.1-terra" }));
    const out = t.handle(ev.stepEnded(S, "msg_1", "tool-calls", 0.0123, { input: 10, output: 20, reasoning: 5, cache: { read: 30, write: 40 } }));

    expect(out.events).toEqual([
      { type: "usage", turn: 1, model: "openai/gpt-6.1-terra", usage: { turns: 1, tokensIn: 10, tokensOut: 25, tokensCacheRead: 30, tokensCacheWrite: 40, costMicros: 12_300, costSource: "runtime" } },
    ]);
    expect(out.step).toEqual({ finish: "tool-calls" });
  });

  test("un proveedor que reporta costo 0 (suscripción) queda con lo que costaría a precio de lista, marcado estimate", () => {
    const price = { input: 1, output: 5, cache_read: 0.05, cache_write: 1.25 };
    const t = createTranslator(S, (model) => (model === "openai/gpt-6.1-terra" ? price : undefined));
    t.handle(ev.stepStarted(S, "msg_1", { providerID: "openai", id: "gpt-6.1-terra" }));
    const out = t.handle(ev.stepEnded(S, "msg_1", "stop", 0, { input: 1_000_000, output: 100_000, reasoning: 100_000, cache: { read: 2_000_000, write: 0 } }));

    // 1M de entrada a 1 + 200k de salida a 5 + 2M de caché a 0,05 = USD 2,10
    expect(out.events).toMatchObject([{ type: "usage", usage: { costMicros: 2_100_000, costSource: "estimate" } }]);
  });

  test("con costo reportado, o sin precio para el modelo, queda lo que dice opencode", () => {
    const t = createTranslator(S, () => ({ input: 1, output: 5 }));
    t.handle(ev.stepStarted(S, "msg_1", { providerID: "openai", id: "gpt-6.1-terra" }));
    expect(t.handle(ev.stepEnded(S, "msg_1", "stop", 0.5)).events).toMatchObject([{ usage: { costMicros: 500_000, costSource: "runtime" } }]);

    const unknown = createTranslator(S);
    unknown.handle(ev.stepStarted(S, "msg_2", { providerID: "otro", id: "x" }));
    expect(unknown.handle(ev.stepEnded(S, "msg_2", "stop", 0)).events).toMatchObject([{ usage: { costMicros: 0, costSource: "runtime" } }]);
  });

  test("lo que gasta un subagente cuenta, pero sus pasos no son turnos de la sesión", () => {
    const out = createTranslator(S).handle(ev.stepEnded("ses_child", "msg_9", "stop", 0.3));
    expect(out.events).toMatchObject([{ type: "usage", usage: { costMicros: 300_000 } }]);
    expect(out.step).toBeUndefined();
  });

  test("una herramienta empieza con su nombre y lo más útil de su entrada, y termina con su salida en el transcript", () => {
    const t = createTranslator(S);
    const [inputStarted, called, success] = ev.tool(S, "c1", "shell", { command: "npm test" });
    expect(t.handle(inputStarted!).events).toEqual([]);
    expect(t.handle(called!)).toMatchObject({ events: [{ type: "tool_start", tool: "shell", detail: "npm test" }], transcript: [{ kind: "tool_call", id: "c1", tool: "shell", detail: "npm test" }] });
    expect(t.handle(success!)).toMatchObject({ events: [{ type: "tool_end", tool: "shell" }], transcript: [{ kind: "tool_result", id: "c1", isError: false, text: "salida" }] });
  });

  test("el reporte es la entrada de clanker_report; otra herramienta no lo es", () => {
    const t = createTranslator(S);
    const report = { outcome: "done", summary: "listo", payload: {} };
    const toolReport = ev.tool(S, "c2", "clanker_report", report);
    const otherTool = ev.tool(S, "c3", "read", { path: "a.ts" });
    t.handle(toolReport[0]!);
    t.handle(otherTool[0]!);
    expect(t.handle(toolReport[1]!).report).toEqual(report);
    expect(t.handle(otherTool[1]!).report).toBeUndefined();
  });

  test("primer token, texto, razonamiento y compactación", () => {
    const t = createTranslator(S);
    expect(t.handle(ev.firstToken(S)).events).toEqual([{ type: "first_token" }]);
    expect(t.handle(ev.firstToken(S)).events).toEqual([]);
    expect(t.handle(ev.text(S, "Listo."))).toMatchObject({ events: [{ type: "text", text: "Listo." }], transcript: [{ kind: "text", text: "Listo." }] });
    expect(t.handle({ type: "session.reasoning.ended", data: { sessionID: S, text: "pienso" } })).toMatchObject({ events: [], transcript: [{ kind: "thinking", text: "pienso" }] });
    const compacted: OpencodeEvent = { type: "session.compaction.ended", data: { sessionID: S, reason: "auto", model: { providerID: "openai", id: "gpt-6.1-terra" }, cost: 0.02, tokens: { input: 5, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } } };
    expect(t.handle(compacted).events.map((e) => e.type)).toEqual(["usage", "compaction"]);
  });

  test("cómo termina la ejecución, sus reintentos y lo que espera a una persona", () => {
    const t = createTranslator(S);
    expect(t.handle(ev.succeeded(S)).end).toEqual({ outcome: "succeeded" });
    expect(t.handle(ev.succeeded("ses_child")).end).toBeUndefined();
    expect(t.handle(ev.failed(S, { type: "provider.api", message: "boom" })).end).toEqual({ outcome: "failed", error: { type: "provider.api", message: "boom" } });
    expect(t.handle(ev.interrupted(S, "shutdown")).end).toEqual({ outcome: "interrupted", reason: "shutdown" });
    expect(t.handle(ev.retry(S, 2, { type: "provider.api", message: "slow", status: 429 })).retry).toEqual({ attempt: 2, error: { type: "provider.api", message: "slow", status: 429 } });
    expect(t.handle({ type: "permission.asked", data: { sessionID: S, action: "shell", resources: ["rm -rf /"] } }).blocked).toContain('"shell"');
    expect(t.handle({ type: "form.created", data: { form: { sessionID: S, title: "¿Sigo?" } } }).blocked).toContain("¿Sigo?");
  });
});

describe("CLI", () => {
  test("la versión mínima es opencode 2.3: opencode 1 no sirve", () => {
    expect(versionProblem("opencode v2.3.0\n")).toBeUndefined();
    expect(versionProblem("2.4.1")).toBeUndefined();
    expect(versionProblem("1.19.5")).toContain("muy viejo");
    expect(versionProblem("0.0.0-dev-1299")).toContain("muy viejo");
    expect(versionProblem("dev")).toContain("no sé qué versión");
  });

  test("los modelos son las líneas proveedor/modelo, sin el logo", () => {
    expect(parseModels("█▀▀█ █▀▀█\nopencode/big-pickle\n\nopenai/gpt-6.1-terra\n  openrouter/anthropic/claude-sonnet-5  \n")).toEqual([
      "opencode/big-pickle",
      "openai/gpt-6.1-terra",
      "openrouter/anthropic/claude-sonnet-5",
    ]);
  });
});
