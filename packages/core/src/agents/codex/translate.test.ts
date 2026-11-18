import { describe, expect, test } from "vitest";
import { TRANSCRIPT_TEXT_MAX_CHARS, TranscriptEntry } from "@clanker/api";
import type { CodexNotification, ThreadItem, TokenUsageBreakdown, Turn, TurnError } from "./api";
import { createCodexTranslator, statusOfCodexError } from "./translate";

const THREAD = "thread_main";
const TURN = "turn_1";
const empty = { events: [], transcript: [] };
const itemEvent = (item: ThreadItem, completed = true, threadId = THREAD): CodexNotification => ({
  method: completed ? "item/completed" : "item/started",
  params: { threadId, turnId: TURN, item },
});
const delta = (text: string, itemId = "message_1"): CodexNotification => ({
  method: "item/agentMessage/delta",
  params: { threadId: THREAD, turnId: TURN, itemId, delta: text },
});
const tokens = (overrides: Partial<TokenUsageBreakdown> = {}): TokenUsageBreakdown => ({
  inputTokens: 100, cachedInputTokens: 30, cacheWriteInputTokens: 10,
  outputTokens: 20, reasoningOutputTokens: 12, totalTokens: 120, ...overrides,
});
const usage = (last: TokenUsageBreakdown, total = last, turnId = TURN): CodexNotification => ({
  method: "thread/tokenUsage/updated",
  params: { threadId: THREAD, turnId, tokenUsage: { last, total, modelContextWindow: 200_000 } },
});
const turnStarted: CodexNotification = {
  method: "turn/started",
  params: { threadId: THREAD, turn: { id: TURN, status: "inProgress", error: null, items: [] } },
};
const finished = (overrides: Partial<Turn> = {}): CodexNotification => ({
  method: "turn/completed",
  params: { threadId: THREAD, turn: { id: TURN, status: "completed", error: null, items: [], ...overrides } },
});
const error = (codexErrorInfo: TurnError["codexErrorInfo"], message = "falló"): TurnError => ({
  message, codexErrorInfo, additionalDetails: null,
});
const failed = (failure: TurnError, willRetry = false): CodexNotification => ({
  method: "error", params: { threadId: THREAD, turnId: TURN, error: failure, willRetry },
});
const command = (overrides: Partial<Extract<ThreadItem, { type: "commandExecution" }>> = {}): ThreadItem => ({
  type: "commandExecution", id: "command_1", command: "npm test", status: "inProgress", exitCode: null, aggregatedOutput: null, ...overrides,
});
const mcp = (overrides: Partial<Extract<ThreadItem, { type: "mcpToolCall" }>> = {}): ThreadItem => ({
  type: "mcpToolCall", id: "mcp_1", server: "docs", tool: "read", arguments: { path: "readme.md" },
  status: "inProgress", result: null, error: null, ...overrides,
});

describe("uso de Codex", () => {
  test("last es un mensaje del modelo: separa caché y no suma el razonamiento a outputTokens", () => {
    const t = createCodexTranslator(THREAD);
    t.translate(turnStarted);
    const out = t.translate(usage(tokens(), tokens({ inputTokens: 5_000, totalTokens: 7_000 })));
    const expected = {
      turns: 1, tokensIn: 60, tokensOut: 20, tokensCacheRead: 30, tokensCacheWrite: 10,
      costMicros: 0, costSource: "estimate",
    };
    expect(out.usage).toEqual(expected);
    expect(out.events).toEqual([{ type: "usage", turn: 1, usage: expected }]);
  });

  test("deduplica el total repetido, pero cobra mensajes iguales con total distinto", () => {
    const t = createCodexTranslator(THREAD);
    t.translate(turnStarted);
    const first = usage(tokens());
    expect(t.translate(first).usage?.turns).toBe(1);
    expect(t.translate(first)).toEqual(empty);
    expect(t.translate(usage(tokens(), tokens({ totalTokens: 240, inputTokens: 200, outputTokens: 40 })))).toMatchObject({
      usage: { turns: 1, tokensIn: 60, tokensOut: 20 }, events: [{ type: "usage", turn: 2 }],
    });
    expect(t.translate(first)).toEqual(empty);
  });

  test("ignora snapshots sin uso real y separa una entrada completamente cacheada", () => {
    const t = createCodexTranslator(THREAD);
    t.translate(turnStarted);
    expect(t.translate(usage(tokens({ inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 })))).toEqual(empty);
    expect(t.translate(usage(tokens({ cachedInputTokens: 90, cacheWriteInputTokens: 10 })))).toMatchObject({
      usage: { tokensIn: 0 }, events: [{ turn: 1 }],
    });
  });

  test("ignora uso histórico de resume antes y después del inicio del turno actual", () => {
    const t = createCodexTranslator(THREAD);
    const previous = usage(tokens(), tokens({ totalTokens: 240 }), "turn_previous");
    expect(t.translate(previous)).toEqual(empty);
    t.translate(turnStarted);
    expect(t.translate(previous)).toEqual(empty);
    expect(t.translate(usage(tokens(), tokens({ totalTokens: 240 })))).toMatchObject({
      usage: { turns: 1, tokensIn: 60, tokensOut: 20 }, events: [{ type: "usage", turn: 1 }],
    });
  });
});

describe("texto y razonamiento de Codex", () => {
  test("deltas disparan first_token una vez, y el completado guarda el texto sin repetir eventos", () => {
    const t = createCodexTranslator(THREAD);
    const item: ThreadItem = { type: "agentMessage", id: "message_1", text: "Hola mundo" };
    expect(t.translate(itemEvent({ ...item, text: "" }, false))).toEqual(empty);
    expect(t.translate(delta(""))).toEqual(empty);
    expect(t.translate(delta("Hola"))).toEqual({ events: [{ type: "first_token" }, { type: "text", text: "Hola" }], transcript: [] });
    expect(t.translate(delta(" mundo")).events).toEqual([{ type: "text", text: " mundo" }]);
    expect(t.translate(itemEvent(item))).toEqual({
      events: [], transcript: [{ kind: "text", text: "Hola mundo", truncated: false }], text: "Hola mundo",
    });
    expect(t.translate(itemEvent(item))).toEqual(empty);
    expect(t.translate(delta("otra vez"))).toEqual(empty);
    expect(t.translate(finished({ items: [item] }))).toMatchObject({ ...empty, end: { status: "completed" } });
  });

  test("un completado sin deltas emite todo y con deltas parciales emite solo lo que falta", () => {
    const t = createCodexTranslator(THREAD);
    expect(t.translate(itemEvent({ type: "agentMessage", id: "a", text: "Uno" }))).toMatchObject({
      events: [{ type: "first_token" }, { type: "text", text: "Uno" }], text: "Uno",
    });
    t.translate(delta("Dos", "b"));
    expect(t.translate(itemEvent({ type: "agentMessage", id: "b", text: "Dos tres" }))).toMatchObject({
      events: [{ type: "text", text: " tres" }], text: "Dos tres",
    });
  });

  test("conserva deltas si el completado no trae texto y recorta solo el transcript", () => {
    const t = createCodexTranslator(THREAD);
    const text = "a".repeat(TRANSCRIPT_TEXT_MAX_CHARS + 1);
    t.translate(delta(text));
    const out = t.translate(itemEvent({ type: "agentMessage", id: "message_1", text: "" }));
    expect(out.text).toBe(text);
    expect(out.transcript).toEqual([{ kind: "text", text: text.slice(0, TRANSCRIPT_TEXT_MAX_CHARS), truncated: true }]);
  });

  test("el razonamiento activa first_token pero no aparece como texto ni se duplica con el resumen final", () => {
    const t = createCodexTranslator(THREAD);
    const summary: CodexNotification = {
      method: "item/reasoning/summaryTextDelta",
      params: { threadId: THREAD, turnId: TURN, itemId: "r", delta: "Pienso", summaryIndex: 0 },
    };
    expect(t.translate(summary)).toEqual({ events: [{ type: "first_token" }], transcript: [] });
    t.translate({ ...summary, params: { ...summary.params, delta: "Luego", summaryIndex: 1 } });
    const done = itemEvent({ type: "reasoning", id: "r", summary: ["Pienso", "Luego"], content: ["Contenido"] });
    expect(t.translate(done)).toEqual({ events: [], transcript: [{ kind: "thinking", text: "Pienso\nLuego", truncated: false }] });
    expect(t.translate(done)).toEqual(empty);
  });

  test("el contenido de razonamiento se usa cuando no hay resumen", () => {
    const t = createCodexTranslator(THREAD);
    t.translate({
      method: "item/reasoning/textDelta",
      params: { threadId: THREAD, turnId: TURN, itemId: "r", delta: "Contenido", contentIndex: 0 },
    });
    expect(t.translate(itemEvent({ type: "reasoning", id: "r", summary: [], content: [] })).transcript).toEqual([
      { kind: "thinking", text: "Contenido", truncated: false },
    ]);
  });
});

describe("herramientas de Codex", () => {
  test("comandos tienen tool_call/tool_result y el output final reemplaza los deltas", () => {
    const t = createCodexTranslator(THREAD);
    const started = itemEvent(command(), false);
    const call = t.translate(started);
    expect(call).toMatchObject({
      events: [{ type: "first_token" }, { type: "tool_start", tool: "shell", detail: "npm test" }],
      transcript: [{ kind: "tool_call", id: "command_1", tool: "shell", input: '{\n  "command": "npm test"\n}' }],
    });
    expect(t.translate(started)).toEqual(empty);
    expect(t.translate({
      method: "item/commandExecution/outputDelta",
      params: { threadId: THREAD, turnId: TURN, itemId: "command_1", delta: "partial" },
    })).toEqual(empty);
    const out = t.translate(itemEvent(command({ status: "completed", aggregatedOutput: "tests ok", exitCode: 0 })));
    expect(out).toEqual({
      events: [{ type: "tool_end", tool: "shell" }],
      transcript: [{ kind: "tool_result", id: "command_1", isError: false, text: "tests ok", truncated: false }],
    });
    for (const entry of [...call.transcript, ...out.transcript]) expect(TranscriptEntry.safeParse(entry).success).toBe(true);
  });

  test.each([
    { status: "failed" as const, exitCode: null },
    { status: "declined" as const, exitCode: null },
    { status: "completed" as const, exitCode: 1 },
  ])("un comando fallido conserva el output parcial (%j)", (result) => {
    const t = createCodexTranslator(THREAD);
    t.translate(itemEvent(command(), false));
    t.translate({
      method: "item/commandExecution/outputDelta",
      params: { threadId: THREAD, turnId: TURN, itemId: "command_1", delta: "falló" },
    });
    expect(t.translate(itemEvent(command(result))).transcript).toMatchObject([{ kind: "tool_result", isError: true, text: "falló" }]);
  });

  test("cambios de archivo exponen las rutas y los diffs", () => {
    const t = createCodexTranslator(THREAD);
    const item: ThreadItem = {
      type: "fileChange", id: "patch", status: "completed",
      changes: [{ path: "src/a.ts", kind: { type: "update", move_path: null }, diff: "-antes\n+después" }],
    };
    expect(t.translate(itemEvent(item))).toMatchObject({
      events: [{ type: "first_token" }, { type: "tool_start", tool: "apply_patch", detail: "src/a.ts" }, { type: "tool_end", tool: "apply_patch" }],
      transcript: [{ kind: "tool_call", id: "patch" }, { kind: "tool_result", id: "patch", text: "-antes\n+después", isError: false }],
    });
    expect(t.translate(itemEvent(item))).toEqual(empty);
  });

  test("MCP conserva nombre, argumentos y resultados de texto y estructurados", () => {
    const t = createCodexTranslator(THREAD);
    expect(t.translate(itemEvent(mcp(), false))).toMatchObject({
      events: [{ type: "first_token" }, { type: "tool_start", tool: "docs/read", detail: "readme.md" }],
      transcript: [{ kind: "tool_call", id: "mcp_1", tool: "docs/read", detail: "readme.md" }],
    });
    expect(t.translate(itemEvent(mcp({
      status: "completed", result: { content: [{ type: "text", text: "documento" }], structuredContent: null, _meta: null },
    }))).transcript).toMatchObject([{ kind: "tool_result", isError: false, text: "documento" }]);
    expect(t.translate(itemEvent(mcp({
      id: "mcp_2", status: "completed", result: { content: [], structuredContent: { answer: 42 }, _meta: null },
    }))).transcript).toMatchObject([{ kind: "tool_call" }, { kind: "tool_result", text: '{"answer":42}' }]);
  });

  test("un MCP fallido guarda el error", () => {
    const t = createCodexTranslator(THREAD);
    t.translate(itemEvent(mcp(), false));
    expect(t.translate(itemEvent(mcp({ status: "failed", error: { message: "desconectado" } }))).transcript).toMatchObject([
      { kind: "tool_result", isError: true, text: "desconectado" },
    ]);
  });
});

describe("cierre y errores de Codex", () => {
  test.each([
    ["unauthorized", "login_expired"],
    ["usageLimitExceeded", "quota_exhausted"],
    ["rateLimitExceeded", "error"],
    [{ httpConnectionFailed: { httpStatusCode: 401 } }, "login_expired"],
    [{ responseStreamConnectionFailed: { httpStatusCode: 429 } }, "error"],
    [{ httpConnectionFailed: { httpStatusCode: 403 } }, "error"],
    ["modelNotFound", "error"],
    ["other", "error"],
  ])("%j se clasifica como %s", (info, status) => {
    expect(statusOfCodexError(error(info)).status).toBe(status);
  });

  test("un login vencido indica cómo reconectarse; no confunde badRequest con cuota por su texto", () => {
    expect(statusOfCodexError(error("unauthorized")).message).toContain("codex login");
    expect(statusOfCodexError(error("badRequest", "Invalid schema usage limit property")).status).toBe("error");
  });

  test("deduplica el error entre notificación y cierre, sin perder end", () => {
    const t = createCodexTranslator(THREAD);
    const failure = error("usageLimitExceeded");
    expect(t.translate(failed(failure, true)).error?.status).toBe("quota_exhausted");
    expect(t.translate(failed(failure))).toEqual(empty);
    const end = finished({ status: "failed", error: failure });
    expect(t.translate(end)).toMatchObject({ ...empty, end: { status: "failed", error: failure } });
    expect(t.translate(end)).toEqual(empty);
  });

  test("errores transitorios reintentados no terminan el run, los finales sí", () => {
    const t = createCodexTranslator(THREAD);
    const failure = error("serverOverloaded");
    expect(t.translate(failed(failure, true))).toEqual(empty);
    expect(t.translate(finished({ status: "failed", error: failure }))).toMatchObject({
      error: { status: "error" }, end: { status: "failed" },
    });
  });

  test("el cierre recupera items que no llegaron como notificación e incluye la interrupción", () => {
    const t = createCodexTranslator(THREAD);
    expect(t.translate(finished({
      status: "interrupted", items: [{ type: "agentMessage", id: "a", text: "último" }],
    }))).toMatchObject({ text: "último", end: { status: "interrupted" }, transcript: [{ kind: "text", text: "último" }] });
  });

  test("ignora otros threads y notificaciones de cuenta; compactación se emite una vez", () => {
    const t = createCodexTranslator(THREAD);
    expect(t.translate(itemEvent(command(), false, "otro"))).toEqual(empty);
    const tokenNotification = usage(tokens());
    expect(t.translate({ ...tokenNotification, params: { ...tokenNotification.params, threadId: "otro" } } as CodexNotification)).toEqual(empty);
    expect(t.translate({
      method: "account/rateLimits/updated",
      params: { rateLimits: { limitId: null, primary: null, secondary: null, credits: null, spendControlReached: null } },
    })).toEqual(empty);
    const compact = itemEvent({ type: "contextCompaction", id: "compact" });
    expect(t.translate(compact)).toEqual({
      events: [{ type: "compaction" }], transcript: [{ kind: "compaction", trigger: "auto" }],
    });
    expect(t.translate(compact)).toEqual(empty);
  });
});
