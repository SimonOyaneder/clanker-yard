import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RunStatus } from "../runtime";

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

/**
 * Estado de un run a partir de su mensaje `result` (ausente si el proceso murió antes) y de lo que el
 * stream avisó. `login_expired` y `quota_exhausted` se distinguen a propósito: solo la cuota abre el breaker.
 */
export function outcomeOf(result: SDKResultMessage | undefined, signals: Signals): Outcome {
  if (result?.subtype === "success" && !result.is_error) return { status: "success" };
  if (result?.subtype === "error_max_turns") {
    return { status: "error_max_turns", message: "El agente llegó al tope de turnos." };
  }
  if (result?.subtype === "error_max_budget_usd") {
    return { status: "error_max_budget_usd", message: "El agente llegó al tope de gasto." };
  }

  const text = result === undefined ? "" : failureText(result);
  if (signals.loginFailed || LOGIN_TEXT.test(text)) {
    return { status: "login_expired", message: LOGIN_EXPIRED_MESSAGE };
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
