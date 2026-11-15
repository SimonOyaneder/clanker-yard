import type { ContextSource, Effort, JsonSchema, ToolPolicy } from "@clanker/api";

export type RuntimeId = "claude-sdk" | "acp" | "fake";

/**
 * Lo que el core guarda para retomar una sesión. Con `cwd` porque la caché y el historial de
 * algunos runtimes dependen del directorio.
 */
export interface SessionRef {
  runtime: RuntimeId;
  sessionId: string;
  cwd: string;
}

export interface RuntimeCapabilities {
  structuredOutput: boolean;
  costPerTurn: boolean;
  resume: boolean;
  fork: boolean;
  steer: boolean;
}

export interface RunSpec {
  /** Slug del rol; el runtime solo lo usa para nombrar y registrar. */
  role: string;
  cwd: string;
  systemPrompt: string;
  prompt: string;
  model: string;
  effort?: Effort;
  /** Del perfil: 1 h solo conviene si la mayoría de las sesiones retomadas llegan frías. */
  cacheTtl?: "5m" | "1h";
  /** Fuentes de contexto del rol; cada runtime resuelve las que entiende. */
  context: ContextSource[];
  /** Los hooks del usuario: apagados salvo que el rol los active. */
  hooks: boolean;
  /** Default `"all"`: libertad total. */
  tools: ToolPolicy;
  /** El reporte. Un runtime sin salida estructurada nativa lo pide como JSON al final y lo parsea. */
  outputSchema: JsonSchema;
  /** Opcionales: sin tope por defecto. */
  maxBudgetUsd?: number;
  maxTurns?: number;
}

/** Lo que cambia al retomar: el esquema del reporte depende del modo del mensaje. */
export type ResumeSpec = Pick<RunSpec, "outputSchema" | "maxBudgetUsd" | "maxTurns">;

/**
 * Lo gastado por este run, no el acumulado de la sesión: un runtime cuyo resume arrastra el
 * acumulado anterior (Claude) resta lo previo antes de reportarlo, así sumar sesiones no cuenta
 * dos veces.
 */
export interface Usage {
  turns: number;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  /**
   * Lo que el runtime reporta. En un turno solo con `costPerTurn`; en el resultado, 0 si no lo
   * sabe (un run cortado antes de su `result`) y entonces el core suma sus estimaciones por turno.
   */
  costMicros: number;
  /** `estimate` con suscripción: el equivalente a precio de lista. */
  costSource: "runtime" | "estimate";
}

/**
 * `login_expired` y `quota_exhausted` son distintos a propósito: el primero lo arregla una
 * persona volviendo a iniciar sesión, el segundo es esperar a que se reinicie la cuota.
 * Solo el segundo abre el breaker.
 */
export type RunStatus =
  | "success"
  | "error_max_turns"
  | "error_max_budget_usd"
  | "login_expired"
  | "quota_exhausted"
  | "error";

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_start"; tool: string; detail?: string }
  | { type: "tool_end"; tool: string }
  | {
      type: "usage";
      turn: number;
      /** Un turno es un mensaje `assistant` del modelo, ya deduplicado por su id. */
      usage: Usage;
      /** El id de modelo que respondió, para ponerle precio; sin él rige el de la sesión. */
      model?: string;
      /** La parte de `usage.tokensCacheWrite` que fue a la caché de 1 h; el resto es de 5 min. */
      cacheWrite1hTokens?: number;
    }
  | { type: "error"; kind: "login_expired" | "quota_exhausted" | "other"; message: string };

export interface RunResult {
  status: RunStatus;
  /** El mensaje final del agente. */
  text: string;
  /** El reporte, sin validar. */
  structured?: unknown;
  usage: Usage;
  /** Con `error`, `login_expired` o `quota_exhausted`: qué pasó, accionable. */
  message?: string;
  /** Con `quota_exhausted`: ms epoch en que se reinicia la cuota, si el runtime lo sabe. */
  resetsAt?: number;
}

export interface AgentRun {
  ref: SessionRef;
  events: AsyncIterable<AgentEvent>;
  interrupt(): Promise<void>;
  /** Un fallo del agente resuelve con su `status`; solo un fallo del runtime mismo rechaza. */
  result: Promise<RunResult>;
}

/**
 * Los adapters que lanzan procesos arman su propio entorno (el de Claude lleva PATH, HOME,
 * USER y LANG: sin `USER` no encuentra el login en macOS).
 */
export interface AgentRuntime {
  id: RuntimeId;
  capabilities: RuntimeCapabilities;
  start(spec: RunSpec): Promise<AgentRun>;
  resume(ref: SessionRef, message: string, spec: ResumeSpec): Promise<AgentRun>;
}

export const DEFAULT_RUNTIME: RuntimeId = "claude-sdk";

/** Elige el runtime por `CORE_RUNTIME` (default `claude-sdk`) entre los que el core tiene registrados. */
export function selectRuntime(
  runtimes: readonly AgentRuntime[],
  env: Record<string, string | undefined> = process.env,
): AgentRuntime {
  const wanted = env.CORE_RUNTIME ?? DEFAULT_RUNTIME;
  const found = runtimes.find((r) => r.id === wanted);
  if (!found) {
    throw new Error(
      `CORE_RUNTIME="${wanted}" no corresponde a ningún runtime registrado (${runtimes.map((r) => r.id).join(", ") || "ninguno"}).`,
    );
  }
  return found;
}
