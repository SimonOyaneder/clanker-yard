import { DEFAULT_AGENT_RUNTIME, type AgentRuntimeId, type Effort, type JsonSchema, type RuntimeOptions, type ToolPolicy } from "@clanker/api";

/** Los que un perfil puede pedir (`AgentRuntimeId`), más `fake` (tests y demo) y `acp` (reservado). */
export type RuntimeId = AgentRuntimeId | "acp" | "fake";

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

/** Lo que Claude Code carga por su cuenta, siempre del disco al iniciar la sesión (`settingSources` y `skills`). */
export interface NativeContext {
  sources: ("user" | "project")[];
  skills: string[] | "all";
}

/** Un archivo de contexto leído en este lanzamiento: el core lo lee del original cada vez y no lo guarda. */
export interface ContextReference {
  /** Cómo se nombra al agente: la ruta tal como la pide la fuente, o `rule:<nombre>`. */
  label: string;
  content: string;
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
  /** Solo lo usa el runtime Claude; sin él, `settingSources` es `["user", "project"]` y no hay skills. */
  native?: NativeContext;
  /** Los archivos de contexto del rol (`repo`, `file`, paquetes y convenciones del pack): sirven a cualquier runtime. */
  references: ContextReference[];
  /** Los hooks del usuario: apagados salvo que el rol los active. */
  hooks: boolean;
  /** Default `"all"`: libertad total. */
  tools: ToolPolicy;
  /** El reporte. Un runtime sin salida estructurada nativa lo pide como JSON al final y lo parsea. */
  outputSchema: JsonSchema;
  /** Opcionales: sin tope por defecto. */
  maxBudgetUsd?: number;
  maxTurns?: number;
  /** El paso que lanza el run: un runtime que lanza procesos lo anota en `procs` para poder matarlos. */
  stepRunId?: string;
  /** `user.name` y `user.email` del git que ven los commits del agente: la identidad del usuario en el repo. Sin ella el runtime no configura autor. */
  gitIdentity?: { name: string; email: string };
}

/**
 * Lo que cambia al retomar: el esquema del reporte depende del modo del mensaje, y el contexto se
 * vuelve a leer (retomar también es un lanzamiento).
 */
export type ResumeSpec = Pick<
  RunSpec,
  "outputSchema" | "maxBudgetUsd" | "maxTurns" | "native" | "references" | "stepRunId" | "cacheTtl" | "gitIdentity"
>;

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
 * persona volviendo a iniciar sesión, el segundo es esperar a que se reinicie la cuota. Los dos
 * abren el breaker del runtime; solo el primero deja la cuenta de Claude en rojo.
 */
export type RunStatus =
  | "success"
  | "error_max_turns"
  | "error_max_budget_usd"
  | "login_expired"
  | "quota_exhausted"
  | "error";

export type AgentEvent =
  /**
   * El modelo empezó a responder: desde aquí el prefijo de la petición ya está en la caché y otra
   * sesión con el mismo prefijo lo lee en vez de escribirlo. Va antes que cualquier `text` o
   * `tool_start` (el primer mensaje puede ser solo razonamiento).
   */
  | { type: "first_token" }
  /** La sesión se compactó (hook `PreCompact`): ya no es el historial completo, así que el core no la retoma. */
  | { type: "compaction" }
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
  /**
   * Lo que el total del runtime cuenta de un modelo y los eventos `usage` no: el uso de un turno en
   * streaming no es final (la salida llega recién en el total) y el total también cubre subagentes y
   * llamadas internas. Va al final del run; el core lo suma al último turno de ese modelo.
   */
  | {
      type: "usage_remainder";
      model: string;
      tokens: Pick<Usage, "tokensIn" | "tokensOut" | "tokensCacheRead" | "tokensCacheWrite">;
      /** La parte de `tokens.tokensCacheWrite` que fue a la caché de 1 h. */
      cacheWrite1hTokens: number;
    }
  | { type: "error"; kind: "login_expired" | "quota_exhausted" | "other"; message: string };

export interface RunResult {
  status: RunStatus;
  /** El mensaje final del agente. */
  text: string;
  /**
   * El reporte, sin validar. Con `error_max_budget_usd`, solo si el agente ya lo había entregado
   * cuando cayó el tope: el core lo valida y, si cumple, lo usa.
   */
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
  /**
   * La prueba barata de su breaker (`runtime:<id>`): `undefined` si puede volver a lanzar agentes, o por qué no.
   * Sin ella, el breaker se cierra en la primera prueba (`claude-sdk` lo prueba el core con su conexión).
   */
  probe?(): Promise<string | undefined>;
  /** Lo que ofrece a un perfil (`defs.agentOptions`): modelos, esfuerzos y si está disponible. Sin él, el runtime no se ofrece. */
  describe?(): Promise<RuntimeOptions>;
}

/** Las entradas de perfil sin `runtime` corren con este. */
export const DEFAULT_RUNTIME: RuntimeId = DEFAULT_AGENT_RUNTIME;

/** El perfil pide un runtime que este core no tiene registrado. */
export class RuntimeUnavailableError extends Error {}

/**
 * Los runtimes que el core tiene registrados y cuál corre cada agente (`docs/design.html#d-agents`).
 *
 * Cada entrada del perfil elige el suyo (`ProfileRole.runtime`, `claude-sdk` si no lo dice). `CORE_RUNTIME` los
 * fuerza a todos a uno: es lo que hacen los tests y el core de demo con `fake`, que reproduce guiones de cualquier rol.
 */
export interface RuntimeRegistry {
  /** El que corre una entrada sin `runtime`; con `CORE_RUNTIME`, el forzado. */
  default: AgentRuntime;
  /** El de `CORE_RUNTIME`, si se fijó: corre todo. */
  forced: AgentRuntime | undefined;
  all: readonly AgentRuntime[];
  /** El id que corre una entrada de perfil que pide `requested` (sin él, el default). No lanza: el breaker usa el id aunque falte. */
  idFor(requested: string | undefined): RuntimeId;
  /** El runtime de una entrada de perfil. Lanza `RuntimeUnavailableError` si este core no lo tiene. */
  get(requested: string | undefined): AgentRuntime;
}

/** Arma el registro; `CORE_RUNTIME` debe ser uno de los registrados. */
export function createRuntimeRegistry(
  runtimes: readonly AgentRuntime[],
  env: Record<string, string | undefined> = process.env,
): RuntimeRegistry {
  const names = () => runtimes.map((r) => r.id).join(", ") || "ninguno";
  const wanted = env.CORE_RUNTIME;
  const forced = wanted === undefined || wanted === "" ? undefined : runtimes.find((r) => r.id === wanted);
  if (wanted !== undefined && wanted !== "" && !forced) {
    throw new Error(`CORE_RUNTIME="${wanted}" no corresponde a ningún runtime registrado (${names()}).`);
  }
  const fallback = forced ?? runtimes.find((r) => r.id === DEFAULT_RUNTIME) ?? runtimes[0];
  if (!fallback) throw new Error("El core necesita al menos un runtime de agentes.");
  const idFor = (requested: string | undefined): RuntimeId => (forced?.id ?? (requested as RuntimeId | undefined) ?? fallback.id);
  return {
    default: fallback,
    forced,
    all: runtimes,
    idFor,
    get(requested) {
      const id = idFor(requested);
      const found = runtimes.find((r) => r.id === id);
      if (!found) {
        throw new RuntimeUnavailableError(`El perfil pide el runtime "${id}" y este core no lo tiene (tiene: ${names()}).`);
      }
      return found;
    },
  };
}
