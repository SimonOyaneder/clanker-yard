import { TRANSCRIPT_TEXT_MAX_CHARS, type TranscriptEntry } from "@clanker/api";
import { usdToMicros } from "../../store/conventions";
import type { AgentEvent, RunStatus, Usage } from "../runtime";
import type { ModelRef, OpencodeError, OpencodeEvent, TokenUsage, ToolContent } from "./api";
import { REPORT_TOOL } from "./config";

const QUOTA = /usage limit|quota|insufficient_quota|rate.?limit|too many requests|billing|credit balance|\b429\b/i;
const LOGIN = /token refresh failed|unauthori[sz]ed|\b401\b|\b403\b|invalid.{0,12}api.?key|authentication|not authenticated|credential|expired.{0,20}(token|login|session)/i;

const RECONNECT = "Vuelve a conectar el proveedor con `opencode auth login`.";

/**
 * Un error de opencode como estado del run: lo que arregla una persona (`login_expired`), lo que se arregla esperando
 * (`quota_exhausted`) o un error del paso. Decide primero el HTTP del proveedor, después el tipo y el texto.
 */
export function statusOfError(error: OpencodeError, now = Date.now()): { status: Exclude<RunStatus, "success">; message: string; resetsAt?: number } {
  const text = `${error.type} ${error.message}`;
  if (error.status === 401 || error.status === 403 || (error.status !== 429 && LOGIN.test(text))) {
    return { status: "login_expired", message: `opencode: ${error.message}. ${RECONNECT}` };
  }
  if (error.status === 429 || QUOTA.test(text)) {
    return { status: "quota_exhausted", message: `opencode: ${error.message}`, ...(error.retryAfterMs === undefined ? {} : { resetsAt: now + error.retryAfterMs }) };
  }
  return { status: "error", message: `opencode terminó con ${error.type}: ${error.message}` };
}

/** Lo gastado por un paso del agente. El razonamiento se cobra como salida. */
export function usageOf(cost: number, tokens: TokenUsage): Usage {
  return {
    turns: 1,
    tokensIn: tokens.input,
    tokensOut: tokens.output + tokens.reasoning,
    tokensCacheRead: tokens.cache.read,
    tokensCacheWrite: tokens.cache.write,
    costMicros: usdToMicros(cost),
    costSource: "runtime",
  };
}

const modelName = (model: ModelRef) => `${model.providerID}/${model.id}`;

/** Lo más útil de lo que recibió una herramienta. */
function detailOf(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  for (const key of ["path", "filePath", "file_path", "command", "pattern", "url", "query"]) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function clip(text: string): { text: string; truncated: boolean } {
  return text.length <= TRANSCRIPT_TEXT_MAX_CHARS ? { text, truncated: false } : { text: text.slice(0, TRANSCRIPT_TEXT_MAX_CHARS), truncated: true };
}

const textOf = (content: ToolContent[] | undefined) =>
  (content ?? []).flatMap((c) => (c.type === "text" && typeof c.text === "string" ? [c.text] : [])).join("\n");

/** Lo que un evento de opencode significa para el core. */
export interface Translated {
  events: AgentEvent[];
  transcript: TranscriptEntry[];
  /** Un paso de la sesión principal que terminó y cómo (`tool-calls` si el agente sigue). */
  step?: { finish: string };
  /** opencode reintenta un error del proveedor. */
  retry?: { attempt: number; error: OpencodeError };
  /** Cómo terminó la ejecución de la sesión principal. */
  end?: { outcome: "succeeded" } | { outcome: "failed"; error: OpencodeError } | { outcome: "interrupted"; reason: string };
  /** El reporte que el agente entregó con `REPORT_TOOL`. */
  report?: unknown;
  /** opencode espera a una persona (un permiso o un formulario): nadie va a contestar, así que el run no seguiría nunca. */
  blocked?: string;
}

/**
 * Traduce los eventos del servidor a eventos del core y entradas del transcript. Lo gastado cuenta en todas las
 * sesiones del servidor (un subagente también gasta, y el servidor es solo de este run); el fin, los pasos, los
 * reintentos, las herramientas y lo que espera a una persona, solo los de la sesión principal.
 */
export function createTranslator(sessionID: string) {
  const toolNames = new Map<string, string>();
  const stepModels = new Map<string, string>();
  let firstToken = false;
  let turn = 0;

  function usage(out: Translated, cost: number, tokens: TokenUsage, model: string | undefined): void {
    turn += 1;
    out.events.push({ type: "usage", turn, usage: usageOf(cost, tokens), ...(model === undefined ? {} : { model }) });
  }

  function handle(event: OpencodeEvent): Translated {
    const out: Translated = { events: [], transcript: [] };
    const main = (id: string | undefined) => id === sessionID;
    switch (event.type) {
      case "session.step.started":
        stepModels.set(event.data.assistantMessageID, modelName(event.data.model));
        break;
      case "session.step.first-token":
        if (!firstToken) {
          firstToken = true;
          out.events.push({ type: "first_token" });
        }
        break;
      case "session.step.ended":
        usage(out, event.data.cost, event.data.tokens, stepModels.get(event.data.assistantMessageID));
        if (main(event.data.sessionID)) out.step = { finish: event.data.finish };
        break;
      case "session.step.failed":
        if (event.data.tokens) usage(out, event.data.cost ?? 0, event.data.tokens, stepModels.get(event.data.assistantMessageID));
        break;
      case "session.compaction.ended":
        usage(out, event.data.cost, event.data.tokens, modelName(event.data.model));
        if (main(event.data.sessionID)) {
          out.events.push({ type: "compaction" });
          out.transcript.push({ kind: "compaction", trigger: event.data.reason });
        }
        break;
      case "session.tool.input.started":
        toolNames.set(event.data.id, event.data.name);
        break;
      case "session.tool.called": {
        if (!main(event.data.sessionID)) break;
        const tool = toolNames.get(event.data.id) ?? "tool";
        const detail = detailOf(event.data.input);
        out.events.push({ type: "tool_start", tool, ...(detail === undefined ? {} : { detail }) });
        const { text, truncated } = clip(JSON.stringify(event.data.input ?? {}, null, 2));
        out.transcript.push({ kind: "tool_call", id: event.data.id, tool, detail: detail ?? null, input: text, truncated });
        if (tool === REPORT_TOOL) out.report = event.data.input;
        break;
      }
      case "session.tool.success":
      case "session.tool.failed": {
        if (!main(event.data.sessionID)) break;
        out.events.push({ type: "tool_end", tool: toolNames.get(event.data.id) ?? "tool" });
        const text = textOf(event.data.content) || (event.data.error?.message ?? "");
        out.transcript.push({ kind: "tool_result", id: event.data.id, isError: event.type === "session.tool.failed", ...clip(text) });
        break;
      }
      case "session.text.ended":
        if (main(event.data.sessionID) && event.data.text !== "") {
          out.events.push({ type: "text", text: event.data.text });
          out.transcript.push({ kind: "text", ...clip(event.data.text) });
        }
        break;
      case "session.reasoning.ended":
        if (main(event.data.sessionID) && event.data.text !== "") out.transcript.push({ kind: "thinking", ...clip(event.data.text) });
        break;
      case "session.retry.scheduled":
        if (main(event.data.sessionID)) out.retry = { attempt: event.data.attempt, error: event.data.error };
        break;
      case "session.execution.succeeded":
        if (main(event.data.sessionID)) out.end = { outcome: "succeeded" };
        break;
      case "session.execution.failed":
        if (main(event.data.sessionID)) out.end = { outcome: "failed", error: event.data.error };
        break;
      case "session.execution.interrupted":
        if (main(event.data.sessionID)) out.end = { outcome: "interrupted", reason: event.data.reason };
        break;
      case "permission.asked":
        if (main(event.data.sessionID)) {
          out.blocked = `opencode pidió permiso para "${event.data.action}" (${event.data.resources.join(", ")}) y no hay nadie que lo conceda: revisa las reglas \`permissions\` de tu config de opencode.`;
        }
        break;
      case "form.created":
        if (main(event.data.form.sessionID)) out.blocked = `opencode le abrió un formulario a una persona ("${event.data.form.title}") y no hay nadie que conteste.`;
        break;
      default:
        break;
    }
    return out;
  }

  return { handle };
}
