import * as z from "zod";
import { Report } from "./agents";
import { AgentSessionId, ArtifactHash, ArtifactKind, DecisionId, IssueId, ProjectId, RunId, StepRunId, SubjectRef } from "./domain";
import { FlowDef } from "./flow";

export const RunStatus = z.enum([
  "queued",
  "running",
  "waiting",
  "parked",
  "paused",
  "done",
  "failed",
  "canceled",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const ParkReason = z.enum(["gate", "needs_human", "limit"]);
export type ParkReason = z.infer<typeof ParkReason>;

export const Lane = z.enum(["dev", "maintenance"]);
export type Lane = z.infer<typeof Lane>;

/** Los cupos de los carriles de la máquina (`docs/design.html#nunca-se-congela`) y cuántos hay en uso. */
export const LaneUsage = z.object({
  /** Corridas activas (corriendo o esperando dentro del carril); las `parked` y las `queued` no cuentan. */
  active: z.int().nonnegative(),
  capacity: z.int().positive(),
});
export const Lanes = z.object({
  /** `capacity` es el tope global de la máquina; cada proyecto además tiene su `parallel`. */
  dev: LaneUsage,
  maintenance: LaneUsage,
});
export type Lanes = z.infer<typeof Lanes>;

/** Lo que `system.setLanes` cambia: solo la capacidad de los carriles presentes. */
export const LanesPatch = z.object({
  dev: z.int().positive().optional(),
  maintenance: z.int().positive().optional(),
});
export type LanesPatch = z.infer<typeof LanesPatch>;

export const BreakerCause = z.enum(["quota_exhausted", "login_expired", "connection_lost", "rate_limited", "environment"]);
export type BreakerCause = z.infer<typeof BreakerCause>;

/**
 * Un circuit breaker abierto (`docs/design.html#nunca-se-congela`): pausa solo lo que depende de su ámbito,
 * que es `github`, `runtime:<id>` o `repo:<id>`, y se cierra solo cuando la causa se va.
 */
export const Breaker = z.object({
  scope: z.string(),
  /** El ámbito en palabras: `github`, `runtime:claude-sdk`, `repo api`. */
  label: z.string(),
  cause: BreakerCause,
  reason: z.string(),
  /** ms epoch */
  openedAt: z.int().nonnegative(),
  /** Las pruebas que fallaron desde que abrió. */
  probes: z.int().nonnegative(),
  /** ms epoch de la próxima prueba. */
  nextProbeAt: z.int().nonnegative(),
  /** La alerta de la bandeja; se cierra con el breaker. */
  decisionId: DecisionId,
});
export type Breaker = z.infer<typeof Breaker>;

export const StepStatus = z.enum(["pending", "leased", "running", "waiting", "done", "failed", "canceled"]);
export type StepStatus = z.infer<typeof StepStatus>;

/** Un paso de una corrida, con el outcome que dio y lo que costó. */
export const Step = z.object({
  id: StepRunId,
  nodeId: z.string(),
  visit: z.int().positive(),
  round: z.int().nonnegative(),
  attempt: z.int().nonnegative(),
  status: StepStatus,
  outcome: z.string().nullable(),
  outputHash: ArtifactHash.nullable(),
  error: z.string().nullable(),
  /** ms epoch: con backoff pendiente, no se despacha antes. */
  notBefore: z.int().nonnegative().nullable(),
  costMicros: z.int().nonnegative(),
  /** ms epoch en que el paso arrancó (o empezó a esperar a sus ramas o a un evento); `null` si todavía no. */
  startedAt: z.int().nonnegative().nullable(),
  /** ms epoch en que cerró; `null` mientras sigue vivo. */
  endedAt: z.int().nonnegative().nullable(),
});
export type Step = z.infer<typeof Step>;

/** Una corrida de un flujo sobre un sujeto, sin sus pasos. */
export const Run = z.object({
  id: RunId,
  projectId: ProjectId.nullable(),
  flow: z.object({ slug: z.string(), version: z.int().positive() }),
  /** La corrida que la lanzó como subflujo (nodo `flow`): usa el cupo de su raíz y no cuenta aparte; `null` en una corrida raíz. */
  parentRunId: RunId.nullable(),
  subject: SubjectRef,
  lane: Lane,
  /** La corrida de dev estacionada que le prestó su sujeto (el PR y su worktree) a esta corrida de mantenimiento; `null` si no es un préstamo. */
  borrowedFromRunId: RunId.nullable(),
  status: RunStatus,
  parkReason: ParkReason.nullable(),
  /** `done`, `blocked` o `failed` cuando la corrida terminó. */
  outcome: z.string().nullable(),
  params: z.record(z.string(), z.unknown()),
  /** Contador de rondas → veces que se tomó. */
  rounds: z.record(z.string(), z.int().nonnegative()),
  costMicros: z.int().nonnegative(),
  /** ms epoch */
  startedAt: z.int().nonnegative(),
  endedAt: z.int().nonnegative().nullable(),
});
export type Run = z.infer<typeof Run>;

/** El worktree en que corre (o corrió) la corrida. */
export const RunWorkspace = z.object({ repo: z.string(), branch: z.string(), base: z.string() });
export type RunWorkspace = z.infer<typeof RunWorkspace>;

/** Tokens de todas las sesiones de agente de la corrida. */
export const RunUsage = z.object({
  input: z.int().nonnegative(),
  output: z.int().nonnegative(),
  cacheRead: z.int().nonnegative(),
  cacheWrite: z.int().nonnegative(),
});
export type RunUsage = z.infer<typeof RunUsage>;

/**
 * La corrida con sus pasos, en el orden en que se crearon, y lo que hace falta para dibujarla: el
 * flujo tal como lo fijó la corrida (su versión, no la vigente) y el worktree que tomó (`null` si
 * todavía no tomó ninguno).
 */
export const RunDetail = Run.extend({
  steps: z.array(Step),
  flowDef: FlowDef,
  workspace: RunWorkspace.nullable(),
  usage: RunUsage,
});
export type RunDetail = z.infer<typeof RunDetail>;

export const AgentSessionStatus = z.enum([
  "running",
  "success",
  "error_max_turns",
  "error_max_budget_usd",
  "login_expired",
  "quota_exhausted",
  "report_invalid",
  "error",
]);
export type AgentSessionStatus = z.infer<typeof AgentSessionStatus>;

/** Una sesión de agente de un paso: un intento, o la sesión que un reintento retomó. */
export const StepSession = z.object({
  id: AgentSessionId,
  /** Con qué corrió: `claude-sdk`, `opencode` (o `fake` en tests y demo). */
  runtime: z.string(),
  /** El id de la sesión en su runtime: el que entiende `claude --resume` u `opencode --session`. */
  sessionRef: z.string(),
  /** Slug del rol que corrió. */
  role: z.string(),
  model: z.string(),
  effort: z.string().nullable(),
  status: AgentSessionStatus,
  /** Por qué terminó mal: el mensaje del runtime o lo que no validó del reporte. */
  error: z.string().nullable(),
  turns: z.int().nonnegative(),
  usage: RunUsage,
  costMicros: z.int().nonnegative(),
  startedAt: z.int().nonnegative(),
  endedAt: z.int().nonnegative().nullable(),
  /** El reporte validado; solo en la sesión que lo entregó. */
  report: Report.nullable(),
});
export type StepSession = z.infer<typeof StepSession>;

/** Un artefacto que el paso recibió o dejó. `name` es el rol de su ref: `input`, `output`, `check:tests`, `r2/diff.patch`. */
export const StepArtifact = z.object({
  hash: ArtifactHash,
  name: z.string(),
  kind: ArtifactKind,
  mime: z.string(),
  size: z.int().nonnegative(),
});
export type StepArtifact = z.infer<typeof StepArtifact>;

/** Un comando que corrió un paso `action`, tal como quedó en su log. */
export const StepCommand = z.object({
  command: z.string(),
  /** Stdout y stderr entrelazados; si pasaba de `COMMAND_OUTPUT_MAX_CHARS`, solo el final. */
  output: z.string(),
  truncated: z.boolean(),
  /** `null` mientras el comando sigue corriendo o si lo mató una señal (`killedBy`). */
  exitCode: z.int().nullable(),
  killedBy: z.string().nullable(),
});
export type StepCommand = z.infer<typeof StepCommand>;

export const COMMAND_OUTPUT_MAX_CHARS = 64 * 1024;

/** Lo que el panel de un paso muestra y `runs.get` no trae. */
export const StepDetail = z.object({
  id: StepRunId,
  /** De la más antigua a la más nueva. Vacío en un paso que no es de agente. */
  sessions: z.array(StepSession),
  artifacts: z.array(StepArtifact),
  commands: z.array(StepCommand),
});
export type StepDetail = z.infer<typeof StepDetail>;

const Clipped = { truncated: z.boolean() };

/** Un evento del transcript, ya normalizado: la UI no lee los mensajes crudos del runtime. */
export const TranscriptEntry = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prompt"), text: z.string(), ...Clipped }),
  z.object({ kind: z.literal("text"), text: z.string(), ...Clipped }),
  z.object({ kind: z.literal("thinking"), text: z.string(), ...Clipped }),
  z.object({
    kind: z.literal("tool_call"),
    id: z.string(),
    tool: z.string(),
    /** Lo más útil de lo que recibió la herramienta (ruta, comando, patrón). */
    detail: z.string().nullable(),
    /** Lo que recibió, como JSON con sangría. */
    input: z.string(),
    ...Clipped,
  }),
  z.object({ kind: z.literal("tool_result"), id: z.string(), text: z.string(), isError: z.boolean(), ...Clipped }),
  z.object({ kind: z.literal("compaction"), trigger: z.string() }),
  z.object({
    kind: z.literal("result"),
    subtype: z.string(),
    isError: z.boolean(),
    turns: z.int().nonnegative().nullable(),
    costUsd: z.number().nonnegative().nullable(),
    text: z.string().nullable(),
  }),
]);
export type TranscriptEntry = z.infer<typeof TranscriptEntry>;

export const TRANSCRIPT_TEXT_MAX_CHARS = 16 * 1024;

export const TranscriptQuery = z.object({
  sessionId: AgentSessionId,
  /** El `next` de la página anterior; sin él, desde el principio. */
  cursor: z.int().nonnegative().default(0),
  limit: z.int().min(1).max(500).default(200),
});

export const TranscriptPage = z.object({
  entries: z.array(TranscriptEntry),
  /** Desde dónde pedir lo siguiente: sirve también para seguir una sesión en vivo cuando `hasMore` es falso. */
  next: z.int().nonnegative(),
  /** Hay más en el archivo ahora mismo. */
  hasMore: z.boolean(),
});
export type TranscriptPage = z.infer<typeof TranscriptPage>;

export const RunFilter = z.object({
  projectId: ProjectId.optional(),
  /** Cualquiera de estos estados. */
  status: z.array(RunStatus).min(1).optional(),
});
export type RunFilter = z.infer<typeof RunFilter>;

export const StartRun = z.object({
  projectId: ProjectId,
  issueId: IssueId,
  /** Slug del flujo; sin él, el `defaultFlowId` del proyecto. */
  flow: z.string().min(1).optional(),
  /** Pisan a `flowParams` del proyecto, que a su vez pisa los defaults del flujo. */
  params: z.record(z.string(), z.unknown()).default({}),
});
export type StartRun = z.input<typeof StartRun>;
