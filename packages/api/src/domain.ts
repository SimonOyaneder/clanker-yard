import * as z from "zod";

// Crockford base32, 26 caracteres: el ULID que va después del prefijo.
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Id de texto con prefijo y ULID, por ejemplo `run_01J...`. */
function prefixedId<const P extends string>(prefix: P) {
  return z.templateLiteral([`${prefix}_`, z.string().regex(ULID)]);
}

export const IssueId = prefixedId("iss");
export type IssueId = z.infer<typeof IssueId>;
export const ProjectId = prefixedId("prj");
export type ProjectId = z.infer<typeof ProjectId>;
export const RepoId = prefixedId("repo");
export type RepoId = z.infer<typeof RepoId>;
export const RunId = prefixedId("run");
export type RunId = z.infer<typeof RunId>;
export const StepRunId = prefixedId("stp");
export type StepRunId = z.infer<typeof StepRunId>;
export const AgentSessionId = prefixedId("ses");
export type AgentSessionId = z.infer<typeof AgentSessionId>;
export const DecisionId = prefixedId("dec");
export type DecisionId = z.infer<typeof DecisionId>;
export const LearningId = prefixedId("lrn");
export type LearningId = z.infer<typeof LearningId>;

/** SHA-256 del contenido en hex: la identidad de un artefacto. */
export const ArtifactHash = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "debe ser un SHA-256 en hex (64 caracteres)");
export type ArtifactHash = z.infer<typeof ArtifactHash>;

export const ArtifactKind = z.enum([
  "brief",
  "report",
  "log_excerpt",
  "pr_body",
  "snapshot",
  "legacy",
]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

/** Lo versionado en `defs`: lo editan la API y el MCP por kind. */
export const DefKind = z.enum(["flow", "role", "profile", "recipe", "context", "pack"]);
export type DefKind = z.infer<typeof DefKind>;

/** Sobre qué trabaja una corrida o a qué se refiere un evento. */
export const SubjectRef = z.object({
  type: z.enum(["issue", "pr"]),
  id: z.string().min(1),
});
export type SubjectRef = z.infer<typeof SubjectRef>;

/** Quién originó una llamada o un evento. `ui`, `cli` y `mcp` llegan en `x-clanker-origin`. */
export const Origin = z.enum(["core", "ui", "cli", "mcp", "watch", "import"]);
export type Origin = z.infer<typeof Origin>;

/**
 * Header con la llave de la app. `x-clanker-origin` es autodeclarado, así que el core solo acepta `ui` con
 * esta llave (que solo conoce el main de la app, no `core.json`); ver "Origin `ui`" en AGENTS.md.
 */
export const UI_KEY_HEADER = "x-clanker-ui-key";

/** Quién puede declararse en `x-clanker-origin`: los clientes de la API. */
export const ClientOrigin = Origin.extract(["ui", "cli", "mcp"]);
export type ClientOrigin = z.infer<typeof ClientOrigin>;

/** Taxonomía `entidad.verbo` de `docs/design.html#d-data`. */
export const EventType = z.enum([
  "core.started",
  "core.stopping",
  "core.recovered",
  "project.created",
  "project.updated",
  "project.paused",
  "project.resumed",
  "project.archived",
  "project.defaults_changed",
  "lanes.changed",
  "repo.added",
  "def.versioned",
  "def.archived",
  "def.restored",
  "def.exported",
  "pack.installed",
  "pack.removed",
  "recipe.test_started",
  "recipe.test_output",
  "recipe.test_finished",
  "issue.synced",
  "issue.queued",
  "issue.claimed",
  "issue.skipped",
  "run.started",
  "run.status",
  "run.parked",
  "run.requeued",
  "run.borrowed",
  "run.returned",
  "run.finished",
  "step.started",
  "step.waiting",
  "step.finished",
  "step.retrying",
  "step.commanded",
  "agent.started",
  "agent.activity",
  "agent.usage",
  "agent.ended",
  "lease.acquired",
  "lease.released",
  "lease.expired",
  "pr.opened",
  "pr.changed",
  "pr.botReview",
  "pr.ci",
  "pr.conflict",
  "pr.comment",
  "pr.merged",
  "pr.base_rewritten",
  "pr.human",
  "pr.approvedWithComments",
  "pr.mergeReady",
  "pr.mergeFailed",
  "pr.commented",
  "pr.thread_resolved",
  "pr.hold_changed",
  "pr.overlap",
  "decision.opened",
  "decision.resolved",
  "learning.proposed",
  "learning.approved",
  "learning.rejected",
  "learning.updated",
  "connection.changed",
  "connection.login_failed",
  "sync.rate_limited",
  "breaker.opened",
  "breaker.closed",
  "import.completed",
  "error",
]);
export type EventType = z.infer<typeof EventType>;

/**
 * Un evento de la tabla `events` (append-only). `payload` es mínimo: ids y lo que cambió;
 * el detalle se lee de las tablas.
 */
export const Event = z.object({
  seq: z.int().positive(),
  /** ms epoch */
  ts: z.int().nonnegative(),
  type: EventType,
  origin: Origin,
  projectId: ProjectId.optional(),
  runId: RunId.optional(),
  stepRunId: StepRunId.optional(),
  subject: SubjectRef.optional(),
  payload: z.record(z.string(), z.unknown()),
});
export type Event = z.infer<typeof Event>;

/** Filtro de `events.list` y `events.stream`; los campos presentes se combinan con AND. */
export const EventFilter = z.object({
  types: z.array(EventType).min(1).optional(),
  projectId: ProjectId.optional(),
  runId: RunId.optional(),
});
export type EventFilter = z.infer<typeof EventFilter>;
