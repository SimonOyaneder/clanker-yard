import type { TranscriptEntry } from "@clanker/api";
import type { AgentEvent, RunStatus, Usage } from "../runtime";
import { clip, detailOf } from "../transcripts";
import type { CodexNotification, ThreadItem, TokenUsageBreakdown, Turn, TurnError } from "./api";

export interface CodexFailure {
  status: Exclude<RunStatus, "success">;
  message: string;
}

export interface CodexTranslated {
  events: AgentEvent[];
  transcript: TranscriptEntry[];
  text?: string;
  usage?: Usage;
  end?: Turn;
  error?: CodexFailure;
  retry?: CodexFailure;
}

export function statusOfCodexError(error: TurnError): CodexFailure {
  const info = error.codexErrorInfo;
  const http = typeof info === "object" && info !== null
    ? Object.values(info).flatMap((value) => (
      typeof value === "object" && value !== null && "httpStatusCode" in value ? [value.httpStatusCode] : []
    ))
    : [];
  if (info === "unauthorized" || http.includes(401)) {
    return { status: "login_expired", message: `Codex: ${error.message}. Vuelve a iniciar sesión con \`codex login\`.` };
  }
  if (info === "usageLimitExceeded") {
    return { status: "quota_exhausted", message: `Codex: ${error.message}` };
  }
  if (info === "modelNotFound") {
    return { status: "error", message: `Codex: ${error.message}. Elige un modelo disponible en el perfil.` };
  }
  if (info === "contextWindowExceeded") {
    return { status: "error", message: `Codex: ${error.message}. Abre una sesión nueva o reduce el contexto del rol.` };
  }
  return { status: "error", message: `Codex: ${error.message}` };
}

function usageOf(tokens: TokenUsageBreakdown): Usage {
  return {
    turns: 1,
    tokensIn: tokens.inputTokens - tokens.cachedInputTokens - tokens.cacheWriteInputTokens,
    tokensOut: tokens.outputTokens,
    tokensCacheRead: tokens.cachedInputTokens,
    tokensCacheWrite: tokens.cacheWriteInputTokens,
    costMicros: 0,
    costSource: "estimate",
  };
}

type ToolItem = Extract<ThreadItem, { type: "commandExecution" | "fileChange" | "mcpToolCall" }>;

function toolOf(item: ToolItem): { tool: string; input: unknown; detail?: string } {
  switch (item.type) {
    case "commandExecution":
      return { tool: "shell", input: { command: item.command }, detail: item.command };
    case "fileChange":
      return { tool: "apply_patch", input: { changes: item.changes }, detail: item.changes.map((change) => change.path).join(", ") };
    case "mcpToolCall": {
      const detail = detailOf(item.arguments);
      return { tool: `${item.server}/${item.tool}`, input: item.arguments, ...(detail === undefined ? {} : { detail }) };
    }
  }
}

function resultOf(item: ToolItem, streamed: string): { text: string; isError: boolean } {
  const isError = item.status === "failed" || item.status === "declined";
  switch (item.type) {
    case "commandExecution":
      return { text: item.aggregatedOutput ?? streamed, isError: isError || (item.exitCode !== null && item.exitCode !== 0) };
    case "fileChange":
      return { text: streamed || item.changes.map((change) => change.diff).join("\n"), isError };
    case "mcpToolCall": {
      const content = item.result?.content.map((part) => (
        typeof part === "object" && part !== null && !Array.isArray(part) && part.type === "text" && typeof part.text === "string"
          ? part.text
          : JSON.stringify(part)
      )).join("\n") ?? "";
      const text = content || (item.result?.structuredContent == null ? "" : JSON.stringify(item.result.structuredContent));
      return { text: item.error?.message ?? text, isError: isError || item.error !== null };
    }
  }
}

export function createCodexTranslator(threadId: string) {
  const started = new Set<string>();
  const completed = new Set<string>();
  const ended = new Set<string>();
  const errors = new Set<string>();
  const usages = new Set<string>();
  const texts = new Map<string, string>();
  const outputs = new Map<string, string>();
  const reasoning = new Map<string, { summary: string[]; content: string[] }>();
  let firstToken = false;
  let turn = 0;
  let activeTurnId: string | undefined;

  function first(out: CodexTranslated): void {
    if (firstToken) return;
    firstToken = true;
    out.events.push({ type: "first_token" });
  }

  function fail(out: CodexTranslated, error: TurnError, turnId: string, willRetry: boolean): void {
    const failure = statusOfCodexError(error);
    if (willRetry && failure.status === "error") {
      out.retry = failure;
      return;
    }
    const key = JSON.stringify([turnId, error]);
    if (errors.has(key)) return;
    errors.add(key);
    out.error = failure;
  }

  function itemEvent(out: CodexTranslated, item: ThreadItem, turnId: string, done: boolean): void {
    const key = `${turnId}:${item.id}`;
    if (completed.has(key)) return;
    switch (item.type) {
      case "agentMessage": {
        if (!done) break;
        const text = item.text || texts.get(key) || "";
        const streamed = texts.get(key) ?? "";
        if (text !== "") {
          first(out);
          const remaining = text.startsWith(streamed) ? text.slice(streamed.length) : "";
          if (remaining !== "") out.events.push({ type: "text", text: remaining });
          out.transcript.push({ kind: "text", ...clip(text) });
          out.text = text;
        }
        texts.delete(key);
        break;
      }
      case "reasoning": {
        first(out);
        if (!done) break;
        const partial = reasoning.get(key);
        const summary = item.summary.length > 0 ? item.summary : partial?.summary ?? [];
        const content = item.content.length > 0 ? item.content : partial?.content ?? [];
        const text = (summary.length > 0 ? summary : content).join("\n");
        if (text !== "") out.transcript.push({ kind: "thinking", ...clip(text) });
        reasoning.delete(key);
        break;
      }
      case "commandExecution":
      case "fileChange":
      case "mcpToolCall": {
        const { tool, input, detail } = toolOf(item);
        if (!started.has(key)) {
          first(out);
          started.add(key);
          out.events.push({ type: "tool_start", tool, ...(detail === undefined ? {} : { detail }) });
          const { text, truncated } = clip(JSON.stringify(input ?? {}, null, 2));
          out.transcript.push({ kind: "tool_call", id: item.id, tool, detail: detail ?? null, input: text, truncated });
        }
        if (done) {
          const result = resultOf(item, outputs.get(key) ?? "");
          out.events.push({ type: "tool_end", tool });
          out.transcript.push({ kind: "tool_result", id: item.id, isError: result.isError, ...clip(result.text) });
          outputs.delete(key);
        }
        break;
      }
      case "contextCompaction":
        if (done) {
          out.events.push({ type: "compaction" });
          out.transcript.push({ kind: "compaction", trigger: "auto" });
        }
        break;
    }
    if (done) completed.add(key);
  }

  function translate(notification: CodexNotification): CodexTranslated {
    const out: CodexTranslated = { events: [], transcript: [] };
    if (!("threadId" in notification.params) || notification.params.threadId !== threadId) return out;
    switch (notification.method) {
      case "turn/started":
        activeTurnId = notification.params.turn.id;
        break;
      case "item/started":
      case "item/completed":
        itemEvent(out, notification.params.item, notification.params.turnId, notification.method === "item/completed");
        break;
      case "item/agentMessage/delta": {
        const { turnId, itemId, delta } = notification.params;
        const key = `${turnId}:${itemId}`;
        if (delta === "" || completed.has(key)) break;
        first(out);
        texts.set(key, (texts.get(key) ?? "") + delta);
        out.events.push({ type: "text", text: delta });
        break;
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const { turnId, itemId, delta } = notification.params;
        const key = `${turnId}:${itemId}`;
        if (delta === "" || completed.has(key)) break;
        first(out);
        const parts = reasoning.get(key) ?? { summary: [], content: [] };
        const [list, index] = notification.method === "item/reasoning/summaryTextDelta"
          ? [parts.summary, notification.params.summaryIndex]
          : [parts.content, notification.params.contentIndex];
        list[index] = (list[index] ?? "") + delta;
        reasoning.set(key, parts);
        break;
      }
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta": {
        const { turnId, itemId, delta } = notification.params;
        const key = `${turnId}:${itemId}`;
        if (!completed.has(key)) outputs.set(key, (outputs.get(key) ?? "") + delta);
        break;
      }
      case "thread/tokenUsage/updated": {
        if (notification.params.turnId !== activeTurnId) break;
        const { total, last } = notification.params.tokenUsage;
        const key = JSON.stringify(total);
        if (usages.has(key) || last.inputTokens + last.outputTokens === 0) break;
        usages.add(key);
        out.usage = usageOf(last);
        turn += 1;
        out.events.push({ type: "usage", turn, usage: out.usage });
        break;
      }
      case "error":
        fail(out, notification.params.error, notification.params.turnId, notification.params.willRetry);
        break;
      case "turn/completed": {
        const final = notification.params.turn;
        if (ended.has(final.id)) break;
        ended.add(final.id);
        for (const item of final.items) itemEvent(out, item, final.id, true);
        if (final.error !== null) fail(out, final.error, final.id, false);
        out.end = final;
        break;
      }
    }
    return out;
  }

  return { translate };
}
