import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RunStatus } from "../runtime";
import type { ClaudeCredentials } from "./credentials";

/** Lo que el stream avisó antes del resultado y que el resultado solo no distingue. */
export interface Signals {
  /** `assistant.error === "authentication_failed"`. */
  loginFailed: boolean;
  /** `rate_limit_event` rechazado, o `assistant.error` `rate_limit` / `billing_error`. */
  quota?: { resetsAt?: number; creditsRequired: boolean };
}

export interface Outcome {
  status: RunStatus;
  message?: string;
  /** ms epoch. */
  resetsAt?: number;
}

// Textos de https://code.claude.com/docs/en/errors.
const QUOTA_TEXT = /^you['’]ve hit your .*limit/i;
const LOGIN_TEXT = /login expired|not logged in|failed to authenticate|oauth session expired/i;

export const LOGIN_EXPIRED_MESSAGE =
  "El login de Claude venció o no existe: corre `claude auth login` y vuelve a lanzar el paso.";
export const KEY_REJECTED_MESSAGE =
  "Anthropic rechazó la API key de Claude: revisa que sea válida y esté activa, y guárdala de nuevo.";

/** Anota en `signals` lo que un mensaje del stream avisa sobre el login o la cuota. */
export function noteSignals(message: SDKMessage, signals: Signals): void {
  if (message.type === "assistant") {
    if (message.error === "authentication_failed") signals.loginFailed = true;
    if (message.error === "rate_limit" || message.error === "billing_error") {
      signals.quota ??= { creditsRequired: false };
    }
  } else if (message.type === "rate_limit_event" && message.rate_limit_info.status === "rejected") {
    const { errorCode, resetsAt } = message.rate_limit_info;
    signals.quota = {
      creditsRequired: errorCode === "credits_required",
      ...(resetsAt === undefined ? {} : { resetsAt: resetsAt * 1000 }),
    };
  }
}

/**
 * Por qué el run no debe seguir si `system:init` dice que Claude va a gastar otra credencial que la
 * elegida: con suscripción, que una API key heredada no la pise; con API key, que sí se use.
 */
export function credentialMismatch(
  mode: ClaudeCredentials["mode"],
  apiKeySource: string,
): string | undefined {
  const usesApiKey = apiKeySource !== "none";
  if (mode === "subscription" && usesApiKey) {
    return `Claude iba a gastar una API key (${apiKeySource}) en vez de la suscripción: revisa que el entorno del agente no la traiga.`;
  }
  if (mode === "api-key" && !usesApiKey) {
    return "Claude no está usando la API key configurada: revisa ANTHROPIC_API_KEY.";
  }
  return undefined;
}

/**
 * Estado de un run a partir de su mensaje `result` (ausente si el proceso murió antes) y de lo que el
 * stream avisó. `login_expired` y `quota_exhausted` se distinguen a propósito (ver `RunStatus`).
 * Con API key, `login_expired` es la key rechazada.
 */
export function outcomeOf(
  result: SDKResultMessage | undefined,
  signals: Signals,
  mode: ClaudeCredentials["mode"],
): Outcome {
  if (result?.subtype === "success" && !result.is_error) return { status: "success" };
  if (result?.subtype === "error_max_turns") {
    return { status: "error_max_turns", message: "El agente llegó al tope de turnos." };
  }
  if (result?.subtype === "error_max_budget_usd") {
    return { status: "error_max_budget_usd", message: "El agente llegó al tope de gasto." };
  }

  const text = result === undefined ? "" : failureText(result);
  if (signals.loginFailed || LOGIN_TEXT.test(text)) {
    return { status: "login_expired", message: mode === "api-key" ? KEY_REJECTED_MESSAGE : LOGIN_EXPIRED_MESSAGE };
  }
  if (signals.quota || QUOTA_TEXT.test(text)) {
    const resetsAt = signals.quota?.resetsAt;
    const when = resetsAt === undefined ? "" : ` Se reinicia el ${new Date(resetsAt).toISOString()}.`;
    return {
      status: "quota_exhausted",
      message: signals.quota?.creditsRequired
        ? `Se agotó lo que incluye la suscripción de Claude y seguir exige comprar crédito.${when}`
        : `Se agotó la cuota de Claude.${when}`,
      ...(resetsAt === undefined ? {} : { resetsAt }),
    };
  }

  return { status: "error", message: text === "" ? "El agente terminó con un error sin detalle." : text };
}

function failureText(result: SDKResultMessage): string {
  return result.subtype === "success" ? result.result : result.errors.join("; ");
}
