import type {
  ArtifactHash,
  ArtifactKind,
  ConnectionProvider,
  ConnectionStatus,
  Conventions,
  DecisionId,
  DefKind,
  Event,
  EventType,
  GitHubAuth,
  IssueId,
  IssueFilter,
  IssueRef,
  LearningId,
  Milestone,
  Origin,
  Person,
  Priority,
  DecisionResolution,
  PrState,
  ProjectId,
  ProjectStatus,
  RepoId,
  RunId,
  StackOn,
  StatusCategory,
  StatusMapping,
  StepRunId,
  SubjectRef,
  TrackerId,
} from "@clanker/api";
import { sql } from "drizzle-orm";
import {
  blob,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const meta = sqliteTable("meta", {
  key: text().primaryKey(),
  value: text().notNull(),
});

export const events = sqliteTable(
  "events",
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    ts: integer().notNull(),
    type: text().$type<EventType>().notNull(),
    origin: text().$type<Origin>().notNull(),
    projectId: text("project_id").$type<ProjectId>(),
    runId: text("run_id").$type<RunId>(),
    stepRunId: text("step_run_id").$type<StepRunId>(),
    subject: text({ mode: "json" }).$type<SubjectRef>(),
    payload: text({ mode: "json" }).$type<Event["payload"]>().notNull(),
  },
  (t) => [
    check("events_payload_json", sql`json_valid(${t.payload})`),
    index("events_run_seq").on(t.runId, t.seq),
    index("events_project_seq").on(t.projectId, t.seq),
    index("events_type_seq").on(t.type, t.seq),
  ],
);

export const DEF_SCOPES = ["builtin", "pack", "repo", "user"] as const;

/** Una sola tabla para todo lo versionado: la API y el MCP editan por kind sin casos especiales. */
export const defs = sqliteTable(
  "defs",
  {
    id: text().primaryKey(),
    kind: text().$type<DefKind>().notNull(),
    slug: text().notNull(),
    scope: text({ enum: DEF_SCOPES }).notNull(),
    repoId: text("repo_id").$type<RepoId>(),
    currentVersion: integer("current_version").notNull(),
    archivedAt: integer("archived_at"),
  },
  (t) => [
    // repo_id es NULL fuera de scope repo y SQLite trata los NULL como distintos en un UNIQUE:
    // coalesce evita duplicar el mismo (kind, slug, scope) en builtin, pack y user.
    uniqueIndex("defs_kind_slug_scope_repo").on(
      t.kind,
      t.slug,
      t.scope,
      sql`coalesce(${t.repoId}, '')`,
    ),
    check("defs_repo_id_iff_repo_scope", sql`(${t.scope} = 'repo') = (${t.repoId} IS NOT NULL)`),
  ],
);

/** Inmutable (trigger): editar una def es agregar una versión. */
export const defVersions = sqliteTable(
  "def_versions",
  {
    defId: text("def_id").notNull(),
    version: integer().notNull(),
    body: text({ mode: "json" }).notNull(),
    bodyHash: text("body_hash").notNull(),
    /** `ui`, `mcp`, `import` o `repo:.clanker/flows/x.json@sha`. */
    source: text().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.defId, t.version] }),
    foreignKey({ columns: [t.defId], foreignColumns: [defs.id] }),
    check("def_versions_body_json", sql`json_valid(${t.body})`),
  ],
);

export const AGENT_SESSION_STATUSES = [
  "running",
  "success",
  "error_max_turns",
  "error_max_budget_usd",
  "login_expired",
  "quota_exhausted",
  "report_invalid",
  "error",
] as const;

/** Una fila por sesión del runtime. Un resume que el runtime numera aparte es otra fila, enlazada. */
export const agentSessions = sqliteTable(
  "agent_sessions",
  {
    id: text().primaryKey(),
    /** Sin FK: Agents también corre sesiones sueltas, fuera de un paso (pruebas de un rol). */
    stepRunId: text("step_run_id"),
    roleDefId: text("role_def_id").notNull(),
    roleVersion: integer("role_version").notNull(),
    runtime: text().notNull(),
    sessionRef: text("session_ref").notNull(),
    resumedFrom: text("resumed_from"),
    cwd: text().notNull(),
    model: text().notNull(),
    effort: text(),
    status: text({ enum: AGENT_SESSION_STATUSES }).notNull(),
    /** El reporte validado; solo en la sesión que lo entregó. */
    report: text({ mode: "json" }),
    /** Por qué terminó mal: el mensaje del runtime o lo que no validó del reporte. */
    error: text(),
    turns: integer().notNull().default(0),
    /** Cuántas veces el runtime compactó la sesión: una compactada no se retoma (la ronda siguiente parte nueva, con handoff). */
    compactions: integer().notNull().default(0),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    tokensCacheRead: integer("tokens_cache_read").notNull().default(0),
    tokensCacheWrite: integer("tokens_cache_write").notNull().default(0),
    costMicros: integer("cost_micros").notNull().default(0),
    costSource: text("cost_source", { enum: ["runtime", "estimate"] }),
    transcriptPath: text("transcript_path"),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
  },
  (t) => [
    uniqueIndex("agent_sessions_runtime_session_ref").on(t.runtime, t.sessionRef),
    foreignKey({ columns: [t.resumedFrom], foreignColumns: [t.id] }),
    foreignKey({
      columns: [t.roleDefId, t.roleVersion],
      foreignColumns: [defVersions.defId, defVersions.version],
    }),
    check("agent_sessions_report_json", sql`${t.report} IS NULL OR json_valid(${t.report})`),
  ],
);

/**
 * Un turno de una sesión: un mensaje `assistant` (deduplicado por `message.id`). Los totales de la
 * sesión se actualizan en la misma tx que la fila, y `seq` sigue contando si un resume reusa la sesión.
 */
export const agentTurns = sqliteTable(
  "agent_turns",
  {
    sessionId: text("session_id").notNull(),
    seq: integer().notNull(),
    ts: integer().notNull(),
    model: text().notNull(),
    tokensIn: integer("tokens_in").notNull(),
    tokensOut: integer("tokens_out").notNull(),
    tokensCacheRead: integer("tokens_cache_read").notNull(),
    /** Todo lo escrito en la caché (5 min y 1 h). */
    tokensCacheWrite: integer("tokens_cache_write").notNull(),
    /** La parte de `tokens_cache_write` que fue a la caché de 1 h. */
    tokensCacheWrite1h: integer("tokens_cache_write_1h").notNull(),
    /** Lo que costó el turno: el USD que dijo el runtime o su estimación con `model_prices`. */
    costMicros: integer("cost_micros").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.seq] }),
    foreignKey({ columns: [t.sessionId], foreignColumns: [agentSessions.id] }),
  ],
);

/**
 * Lo que un paso consumió de una sesión. Un resume que reusa el id de sesión deja `agent_sessions.step_run_id`
 * en el paso original, así que el costo de un paso (y de su corrida) sale de aquí, no de la sesión. Sin FK a
 * `step_runs`, como `agent_sessions.step_run_id`: Agents corre sesiones sueltas.
 */
export const stepUsage = sqliteTable(
  "step_usage",
  {
    stepRunId: text("step_run_id").$type<StepRunId>().notNull(),
    sessionId: text("session_id").notNull(),
    /** Entrada, salida y caché (lectura y escritura). */
    tokens: integer().notNull(),
    costMicros: integer("cost_micros").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.stepRunId, t.sessionId] }),
    foreignKey({ columns: [t.sessionId], foreignColumns: [agentSessions.id] }),
  ],
);

/**
 * USD por millón de tokens, en micros (USD × 10⁶), para estimar el costo de un turno cuando el
 * runtime no lo reporta. `model` es un trozo del id de modelo: sirve a todo id que lo contenga
 * (`opus`, `sonnet-4-5`) y uno más largo gana. Rige el de mayor `valid_from` anterior al turno.
 * Un precio con `above_prompt_tokens` > 0 es el de los turnos cuyo prompt (entrada más caché) pasa de
 * ese tamaño, y reemplaza al base del mismo modelo y `valid_from`.
 */
export const modelPrices = sqliteTable(
  "model_prices",
  {
    model: text().notNull(),
    input: integer().notNull(),
    output: integer().notNull(),
    cacheRead: integer("cache_read").notNull(),
    cacheWrite5m: integer("cache_write_5m").notNull(),
    cacheWrite1h: integer("cache_write_1h").notNull(),
    validFrom: integer("valid_from").notNull(),
    abovePromptTokens: integer("above_prompt_tokens").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.model, t.validFrom, t.abovePromptTokens] })],
);

/**
 * Una cuenta conectada a un proveedor. Sin secretos: `secret_ref` es la clave bajo la que `Secrets`
 * guarda el token, nunca el token.
 */
export const connections = sqliteTable(
  "connections",
  {
    provider: text().$type<ConnectionProvider>().notNull(),
    account: text().notNull(),
    scopes: text({ mode: "json" }).$type<string[]>().notNull(),
    status: text().$type<ConnectionStatus>().notNull(),
    /** Vacío en `claude/subscription`: el login lo lee el `claude` instalado, nunca la app. */
    secretRef: text("secret_ref").notNull(),
    /** ms epoch; NULL si el token no vence. */
    expiresAt: integer("expires_at"),
    /** Solo GitHub: `pat` (pegado a mano) o `app` (device flow de la GitHub App). NULL en el resto. */
    auth: text().$type<GitHubAuth>(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.account] }),
    check("connections_scopes_json", sql`json_valid(${t.scopes})`),
  ],
);

export const WORKSPACE_STATES = ["creating", "leased", "idle", "archived"] as const;

/**
 * Un worktree por fila, con su lease. Lo que antes vivía en `.git/config` (dueño de la branch,
 * base) vive aquí: los worktrees comparten ese archivo y los escritores en paralelo se pisan.
 */
export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text().primaryKey(),
    repoId: text("repo_id").$type<RepoId>().notNull(),
    path: text().notNull(),
    branch: text().notNull(),
    /** La base normalizada: `main`, nunca `origin/main`. */
    baseRef: text("base_ref").notNull(),
    /** NULL mientras el worktree está en `creating`. */
    baseSha: text("base_sha"),
    headSha: text("head_sha"),
    /** Última punta que pusheó el core; la usa `--force-with-lease`. */
    remoteSha: text("remote_sha"),
    state: text({ enum: WORKSPACE_STATES }).notNull(),
    holderRunId: text("holder_run_id").$type<RunId>(),
    leaseUntil: integer("lease_until"),
    /** Sube en 1 en cada toma del lease; las operaciones con efecto lo validan antes de actuar. */
    fencingToken: integer("fencing_token").notNull().default(0),
    /** Desde cuándo está `archived` (su PR se mergeó o cerró); a los 7 días se borra. NULL en los demás estados. */
    archivedAt: integer("archived_at"),
  },
  (t) => [
    uniqueIndex("workspaces_path").on(t.path),
    uniqueIndex("workspaces_repo_branch_live")
      .on(t.repoId, t.branch)
      .where(sql`${t.state} != 'archived'`),
  ],
);

export const COMBINED_BASE_STATUSES = ["active", "conflict", "dissolved"] as const;

/** Un padre de una base combinada con la punta que se juntó (`CombinedParent` de `workspaces/combine.ts`). */
export interface CombinedBaseParent {
  key: string;
  branch: string;
  sha: string;
}

/**
 * La base sintética de una issue con dos o más padres (`docs/design.html#d-ops`, "Bases combinadas"): la
 * branch local `clanker/base/<issue>` con la punta de la branch por defecto (`default_sha`) y un merge de cada
 * padre, en orden (`parents`: el primero es la base del PR en GitHub). Guarda con qué se armó, para
 * recalcularla cuando se mergea un padre. Una issue de varios repos tiene una por repo (la branch sintética se llama
 * igual en todos). `head_sha` es la última punta que quedó aplicada (NULL si la base
 * nunca se pudo armar): un restack parte de ahí, así que un `conflict` al recalcular no la pisa.
 */
export const combinedBases = sqliteTable(
  "combined_bases",
  {
    repoId: text("repo_id").$type<RepoId>().notNull(),
    branch: text().notNull(),
    issueId: text("issue_id").$type<IssueId>()
      .notNull()
      .references(() => issues.id),
    defaultSha: text("default_sha").notNull(),
    parents: text({ mode: "json" }).$type<CombinedBaseParent[]>().notNull(),
    headSha: text("head_sha"),
    status: text({ enum: COMBINED_BASE_STATUSES }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.repoId, t.branch] }),
    uniqueIndex("combined_bases_repo_issue").on(t.repoId, t.issueId),
    check("combined_bases_parents_json", sql`json_valid(${t.parents})`),
  ],
);

/**
 * Un proyecto de Clanker (`docs/design.html#d-data`). `default_flow_id` y `default_profile_id` guardan
 * el slug de la def, no su id. `runs.project_id` y `issues.project_id` apuntan aquí sin FK: los
 * escenarios y tests siembran filas con proyectos que no existen.
 */
export const projects = sqliteTable(
  "projects",
  {
    id: text().$type<ProjectId>().primaryKey(),
    slug: text().notNull(),
    name: text().notNull(),
    tracker: text().$type<TrackerId>().notNull(),
    trackerRef: text("tracker_ref").notNull(),
    /** La cuenta del tracker de la que sale la cola (en Linear, el `urlKey` del workspace). `null` en `local` y en los proyectos que aún no la fijaron. */
    trackerAccount: text("tracker_account"),
    defaultFlowId: text("default_flow_id"),
    defaultProfileId: text("default_profile_id"),
    parallel: integer().notNull().default(1),
    stackOn: text("stack_on").$type<StackOn>().notNull().default("ci_green"),
    status: text().$type<ProjectStatus>().notNull().default("active"),
    flowParams: text("flow_params", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    queueFilter: text("queue_filter", { mode: "json" }).$type<IssueFilter>().notNull().default({}),
    conventions: text({ mode: "json" }).$type<Conventions>().notNull().default({}),
    /** `null` es sin tope. */
    maxCostUsd: real("max_cost_usd"),
    /** Estados del tracker que el proyecto cambia de categoría (`StatusMapping`). */
    statusMapping: text("status_mapping", { mode: "json" }).$type<StatusMapping>().notNull().default({}),
  },
  (t) => [
    uniqueIndex("projects_slug").on(t.slug),
    uniqueIndex("projects_tracker_ref").on(t.tracker, t.trackerRef),
    check("projects_parallel_positive", sql`${t.parallel} >= 1`),
    check("projects_flow_params_json", sql`json_valid(${t.flowParams})`),
    check("projects_queue_filter_json", sql`json_valid(${t.queueFilter})`),
    check("projects_conventions_json", sql`json_valid(${t.conventions})`),
  ],
);

/** Un checkout de git del usuario, de donde cuelgan los worktrees de Workspaces. */
export const repos = sqliteTable(
  "repos",
  {
    id: text().$type<RepoId>().primaryKey(),
    name: text().notNull(),
    path: text().notNull(),
    /** `owner/name` en GitHub; `null` si `origin` no es de GitHub. */
    remote: text(),
    defaultBranch: text("default_branch").notNull(),
    /** Pisa a `appliesWhen` del pack: `on` aplica su estrategia de merge aunque no se vea merge-queue, `off` no la aplica nunca; `null` lo detecta (decisión #33). */
    mergeStrategy: text("merge_strategy", { enum: ["on", "off"] }),
  },
  (t) => [uniqueIndex("repos_path").on(t.path)],
);

/**
 * Los repos de un proyecto. `ord` es el orden de la lista: el primero es el repo por defecto de
 * `runs.start`. `labels` son los labels de issue que mandan al repo.
 */
export const projectRepos = sqliteTable(
  "project_repos",
  {
    projectId: text("project_id")
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id),
    repoId: text("repo_id").$type<RepoId>()
      .$type<RepoId>()
      .notNull()
      .references(() => repos.id),
    ord: integer().notNull(),
    labels: text({ mode: "json" }).$type<string[]>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.repoId] }),
    uniqueIndex("project_repos_ord").on(t.projectId, t.ord),
    check("project_repos_labels_json", sql`json_valid(${t.labels})`),
  ],
);

/**
 * Estado de polling y cuota por recurso (`docs/design.html#d-ops`). Lo que Watch pide con ETag guarda el
 * suyo en `etag:github:<cuenta>:<ruta>`; `refs:<owner/repo>` guarda en `cursor` las puntas de las
 * branches del último `git ls-remote`; la cuota de GitHub va en `rate:github:<cuenta>:<recurso>`.
 */
export const syncCursors = sqliteTable("sync_cursors", {
  /** URL o recurso; la cuota de GitHub usa `rate:github:<cuenta>:<recurso>`. */
  key: text().primaryKey(),
  etag: text(),
  cursor: text(),
  checkedAt: integer("checked_at").notNull(),
  rateRemaining: integer("rate_remaining"),
  /** ms epoch en que se renueva la cuota. */
  resetAt: integer("reset_at"),
  /** El tope del recurso (`x-ratelimit-limit`): con él se sabe qué fracción de la cuota queda. */
  rateLimit: integer("rate_limit"),
});

/** Contenido direccionado por su SHA-256: el mismo contenido es una sola fila. */
export const artifacts = sqliteTable("artifacts", {
  hash: text().$type<ArtifactHash>().primaryKey(),
  kind: text().$type<ArtifactKind>().notNull(),
  mime: text().notNull(),
  size: integer().notNull(),
  /** El contenido si pesa lo que admite `artifacts.ts`; si no, es NULL y vive en `artifacts/ab/cd…`. */
  body: blob({ mode: "buffer" }),
  /** Último `put` de este contenido: el GC cuenta los 30 días desde aquí, no desde la primera vez. */
  lastPutAt: integer("last_put_at").notNull(),
});

/** Quién usa un artefacto y para qué. Mientras tenga alguna ref, el GC no lo toca. */
export const artifactRefs = sqliteTable(
  "artifact_refs",
  {
    hash: text()
      .$type<ArtifactHash>()
      .notNull()
      .references(() => artifacts.hash),
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    role: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.hash, t.ownerType, t.ownerId, t.role] })],
);

/**
 * Caché de las issues de los trackers, con la forma normalizada. Se llena con el sync; el scheduler y
 * la API leen de aquí. `project_id` es el proyecto de Clanker (sin FK hasta que exista `projects`).
 */
export const issues = sqliteTable(
  "issues",
  {
    id: text().$type<IssueId>().primaryKey(),
    tracker: text().$type<TrackerId>().notNull(),
    trackerId: text("tracker_id").notNull(),
    key: text().notNull(),
    url: text().notNull(),
    projectId: text("project_id").$type<ProjectId>().notNull(),
    /** El proyecto dentro del tracker (`Issue.project`). */
    trackerProject: text("tracker_project").notNull(),
    title: text().notNull(),
    body: text().notNull(),
    status: text().$type<StatusCategory>().notNull(),
    rawStatus: text("raw_status").notNull(),
    priority: integer().$type<Priority>().notNull(),
    assignee: text({ mode: "json" }).$type<Person>(),
    labels: text({ mode: "json" }).$type<string[]>().notNull(),
    estimate: real(),
    branchName: text("branch_name"),
    parent: text({ mode: "json" }).$type<IssueRef>(),
    milestone: text({ mode: "json" }).$type<Milestone>(),
    relations: text({ mode: "json" })
      .$type<{ blocks: IssueRef[]; blockedBy: IssueRef[]; related: IssueRef[] }>()
      .notNull(),
    remoteUpdatedAt: integer("remote_updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("issues_tracker_tracker_id").on(t.tracker, t.trackerId),
    index("issues_project_status_priority").on(t.projectId, t.status, t.priority),
    check("issues_labels_json", sql`json_valid(${t.labels})`),
    check("issues_relations_json", sql`json_valid(${t.relations})`),
    check("issues_assignee_json", sql`${t.assignee} IS NULL OR json_valid(${t.assignee})`),
    check("issues_parent_json", sql`${t.parent} IS NULL OR json_valid(${t.parent})`),
    check("issues_milestone_json", sql`${t.milestone} IS NULL OR json_valid(${t.milestone})`),
  ],
);

/** Las issues que el usuario le pidió al Scheduler que no lance (`projects.skipIssue`): siguen en el caché, fuera de la cola. */
export const issueSkips = sqliteTable(
  "issue_skips",
  {
    issueId: text("issue_id").$type<IssueId>().primaryKey(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [foreignKey({ columns: [t.issueId], foreignColumns: [issues.id] })],
);

/** Las issues que el usuario subió en la cola (`projects.boostIssue`): salen primero, la última subida arriba de todas. */
export const issueBoosts = sqliteTable(
  "issue_boosts",
  {
    issueId: text("issue_id").$type<IssueId>().primaryKey(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [foreignKey({ columns: [t.issueId], foreignColumns: [issues.id] })],
);

/** Las issues del tracker `local`: la fuente de verdad, no el caché. Ver `tracker/local.ts`. */
export const localIssues = sqliteTable(
  "local_issues",
  {
    id: text().primaryKey(),
    project: text().notNull(),
    /** Correlativo dentro del proyecto; con el proyecto forma la key (`DEMO-3`). */
    number: integer().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    status: text().$type<StatusCategory>().notNull(),
    rawStatus: text("raw_status").notNull(),
    priority: integer().$type<Priority>().notNull(),
    assignee: text({ mode: "json" }).$type<Person>(),
    labels: text({ mode: "json" }).$type<string[]>().notNull(),
    estimate: real(),
    parentId: text("parent_id"),
    milestone: text({ mode: "json" }).$type<Milestone>(),
    /** Sube con cada cambio de la issue (propio o de sus comentarios y relaciones): es el cursor de `changesSince`. */
    rev: integer().notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("local_issues_project_number").on(t.project, t.number),
    uniqueIndex("local_issues_rev").on(t.rev),
    foreignKey({ columns: [t.parentId], foreignColumns: [t.id] }),
    check("local_issues_labels_json", sql`json_valid(${t.labels})`),
    check("local_issues_assignee_json", sql`${t.assignee} IS NULL OR json_valid(${t.assignee})`),
    check("local_issues_milestone_json", sql`${t.milestone} IS NULL OR json_valid(${t.milestone})`),
  ],
);

/**
 * Una arista por relación: `blocks` va de quien bloquea a quien queda bloqueado (`blockedBy` es la
 * misma fila leída al revés) y `related` se guarda una vez, con los ids en orden.
 */
export const localRelations = sqliteTable(
  "local_relations",
  {
    fromId: text("from_id").notNull(),
    toId: text("to_id").notNull(),
    kind: text({ enum: ["blocks", "related"] }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.fromId, t.toId, t.kind] }),
    foreignKey({ columns: [t.fromId], foreignColumns: [localIssues.id] }),
    foreignKey({ columns: [t.toId], foreignColumns: [localIssues.id] }),
    check("local_relations_distinct", sql`${t.fromId} != ${t.toId}`),
  ],
);

export const localComments = sqliteTable(
  "local_comments",
  {
    id: text().primaryKey(),
    issueId: text("issue_id").notNull(),
    author: text({ mode: "json" }).$type<Person>().notNull(),
    text: text().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("local_comments_issue").on(t.issueId, t.createdAt),
    foreignKey({ columns: [t.issueId], foreignColumns: [localIssues.id] }),
    check("local_comments_author_json", sql`json_valid(${t.author})`),
  ],
);

export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting",
  "parked",
  "paused",
  "done",
  "failed",
  "canceled",
] as const;
export const PARK_REASONS = ["gate", "needs_human", "limit"] as const;
export const LANES = ["dev", "maintenance"] as const;

/**
 * Un slot de entorno (DB, puertos) de un repo, global a todos los proyectos que lo usan. `idx` va de 1
 * a N+M: 1..N son del pool `dev` y N+1..N+M del pool `maintenance` (`reserved_for`), con N y M de
 * `slots` en la receta. Se toma con lease y fencing igual que un worktree.
 */
export const slots = sqliteTable(
  "slots",
  {
    repoId: text("repo_id").$type<RepoId>().notNull(),
    idx: integer().notNull(),
    /** El entorno de receta con `{{slot}}` ya sustituido, como lo dejó el último `setup.slot`. */
    env: text({ mode: "json" }).$type<Record<string, string>>().notNull(),
    reservedFor: text("reserved_for", { enum: LANES }).notNull(),
    holderRunId: text("holder_run_id").$type<RunId>(),
    /** El worktree que preparó el slot con `setup.slot`; NULL si nunca se preparó o su estado ya no se sabe. */
    workspaceId: text("workspace_id"),
    /** Hash de los archivos de `setup.slotKey` con los que se preparó. */
    setupHash: text("setup_hash"),
    leaseUntil: integer("lease_until"),
    fencingToken: integer("fencing_token").notNull().default(0),
    /** `setup.slot` empezó y no terminó: lo que haya en el slot no es confiable. */
    dirty: integer({ mode: "boolean" }).notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.repoId, t.idx] })],
);

/** Una versión fijada de una def: lo que la corrida usa aunque después se guarde otra. */
export interface DefPin {
  id: string;
  version: number;
}

/**
 * Una corrida de un flujo sobre un sujeto. Fija la versión del flujo, de sus roles y del perfil al
 * empezar. `projects` aún no existe, así que `project_id` no tiene FK.
 */
export const runs = sqliteTable(
  "runs",
  {
    id: text().$type<RunId>().primaryKey(),
    projectId: text("project_id").$type<ProjectId>(),
    subjectType: text("subject_type").$type<SubjectRef["type"]>().notNull(),
    subjectId: text("subject_id").notNull(),
    flowDefId: text("flow_def_id").notNull(),
    flowVersion: integer("flow_version").notNull(),
    profileDefId: text("profile_def_id"),
    profileVersion: integer("profile_version"),
    /** Rol del flujo (slug) → versión fijada. */
    roles: text({ mode: "json" }).$type<Record<string, DefPin>>().notNull(),
    /** Subflujo (slug) → versión fijada, con los de los subflujos de sus subflujos. Las corridas hijas parten de aquí. */
    subflows: text({ mode: "json" }).$type<Record<string, DefPin>>().notNull().default({}),
    /** La corrida que lanzó esta como subflujo (nodo `flow`); `null` en una corrida raíz. */
    parentRunId: text("parent_run_id").$type<RunId>(),
    /** El paso `flow` del padre que espera a esta corrida. */
    parentStepRunId: text("parent_step_run_id").$type<StepRunId>(),
    /** El nodo del flujo antes del cual la corrida termina con `done` sin ejecutarlo (`stopBefore` del nodo `flow`). */
    stopBefore: text("stop_before"),
    /** La corrida de dev estacionada a la que esta (de mantenimiento) le pidió prestado el sujeto y el worktree; `null` si no es un préstamo. */
    borrowedFromRunId: text("borrowed_from_run_id").$type<RunId>(),
    /** El PR (`pull_requests.id`) que una corrida de issue tomó como sujeto al publicarlo, además del suyo. */
    claimedPrId: text("claimed_pr_id"),
    lane: text({ enum: LANES }).notNull(),
    status: text({ enum: RUN_STATUSES }).notNull(),
    parkReason: text("park_reason", { enum: PARK_REASONS }),
    /** `done`, `blocked` o `failed`: el `@fin` con que terminó el flujo. */
    outcome: text(),
    /** 0 si el flujo es `effects: "local"`. */
    writes: integer({ mode: "boolean" }).notNull(),
    /** Los params efectivos: defaults del flujo pisados por los de `start`. */
    params: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    /** Contador → veces que se tomó. Son de la corrida y no se reinician. */
    rounds: text({ mode: "json" }).$type<Record<string, number>>().notNull(),
    costMicros: integer("cost_micros").notNull().default(0),
    /** Solo las corridas que importó `clanker import legacy`: la clave de su fila de origen, para no importarla dos veces. `NULL` en las que corrió Clanker Yard. */
    sourceKey: text("source_key"),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
  },
  (t) => [
    uniqueIndex("runs_source_key").on(t.sourceKey),
    foreignKey({ columns: [t.flowDefId, t.flowVersion], foreignColumns: [defVersions.defId, defVersions.version] }),
    foreignKey({
      columns: [t.profileDefId, t.profileVersion],
      foreignColumns: [defVersions.defId, defVersions.version],
    }),
    // Un flujo no se lanza dos veces sobre el mismo sujeto mientras la corrida siga viva. Las
    // corridas hijas quedan fuera: heredan el sujeto del padre (el bench corre el mismo flujo varias veces).
    uniqueIndex("runs_active_flow_subject")
      .on(t.flowDefId, t.subjectType, t.subjectId)
      .where(sql`${t.parentRunId} IS NULL AND ${t.status} IN ('queued', 'running', 'waiting', 'parked', 'paused')`),
    foreignKey({ columns: [t.parentRunId], foreignColumns: [t.id] }),
    foreignKey({ columns: [t.borrowedFromRunId], foreignColumns: [t.id] }),
    // Una sola dueña que escribe por sujeto entre todos los flujos; las demás quedan `queued`, que no lo ocupa.
    // Las hijas quedan fuera (heredan el sujeto de su padre, que corre a la vez) y una corrida con un
    // sujeto prestado no es la dueña: lo es la corrida de dev estacionada a la que se lo pidió.
    uniqueIndex("runs_subject_owner")
      .on(t.subjectType, t.subjectId)
      .where(
        sql`${t.writes} = 1 AND ${t.parentRunId} IS NULL AND ${t.borrowedFromRunId} IS NULL AND ${t.status} IN ('running', 'waiting', 'parked', 'paused')`,
      ),
    // Lo mismo para el PR que la corrida de una issue toma al publicarlo. Que no lo tenga ya otra corrida con ese PR como sujeto lo revisa `ownerOf`: un índice solo ve una columna.
    uniqueIndex("runs_claimed_pr_owner")
      .on(t.claimedPrId)
      .where(
        sql`${t.writes} = 1 AND ${t.parentRunId} IS NULL AND ${t.borrowedFromRunId} IS NULL AND ${t.status} IN ('running', 'waiting', 'parked', 'paused')`,
      ),
    // Un solo préstamo a la vez por corrida dueña.
    uniqueIndex("runs_borrowed_from")
      .on(t.borrowedFromRunId)
      .where(sql`${t.status} IN ('running', 'waiting', 'parked', 'paused')`),
    // Un paso `flow` abre una sola corrida hija, aunque el paso se reabra tras un corte.
    uniqueIndex("runs_parent_step").on(t.parentStepRunId),
    index("runs_parent_run").on(t.parentRunId),
    check("runs_roles_json", sql`json_valid(${t.roles})`),
    check("runs_params_json", sql`json_valid(${t.params})`),
    check("runs_rounds_json", sql`json_valid(${t.rounds})`),
  ],
);

export const STEP_STATUSES = ["pending", "leased", "running", "waiting", "done", "failed", "canceled"] as const;

/**
 * Una visita de un nodo. Los reintentos son la misma fila con `attempt` mayor: `attempt` es el
 * token de fencing, y un cierre con un attempt que ya no es el vigente se rechaza.
 */
export const stepRuns = sqliteTable(
  "step_runs",
  {
    id: text().$type<StepRunId>().primaryKey(),
    runId: text("run_id")
      .$type<RunId>()
      .notNull()
      .references(() => runs.id),
    nodeId: text("node_id").notNull(),
    /** Cuántas veces se entró a este nodo en la corrida, desde 1. */
    visit: integer().notNull(),
    /** Vueltas que llevaba el edge que trajo hasta aquí; 0 si no cuenta rondas. */
    round: integer().notNull(),
    /** Ejecuciones empezadas; sube en cada lease. */
    attempt: integer().notNull().default(0),
    /** Cortes de la app con el paso en curso. */
    recoveries: integer().notNull().default(0),
    /** Veces que el entorno (login, cuota) frenó el paso. `attempt` solo sube, porque es el token de fencing; los intentos gastados son `attempt` − `recoveries` − `deferrals`. */
    deferrals: integer().notNull().default(0),
    status: text({ enum: STEP_STATUSES }).notNull(),
    /** Lo que declara el nodo, más `error`, `timeout` y `skipped`. */
    outcome: text(),
    /** Boot id del core dueño del lease. */
    owner: text(),
    /** Espera de backoff: no se despacha antes. */
    notBefore: integer("not_before"),
    /** Solo un wait en `waiting`: la clave de lo que espera (`WaitDef.key`). */
    waitKey: text("wait_key"),
    /** Solo un wait en `waiting` con `timeoutSec`: desde este instante vence con outcome `timeout`. */
    deadline: integer(),
    /** El input ya resuelto (artefacto `brief`). */
    inputHash: text("input_hash").$type<ArtifactHash>(),
    outputHash: text("output_hash").$type<ArtifactHash>(),
    leaseUntil: integer("lease_until"),
    error: text(),
    /** El paso cuyo edge trajo hasta aquí: lo que resuelve `$prev`. */
    prevStepRunId: text("prev_step_run_id").$type<StepRunId>(),
    costMicros: integer("cost_micros").notNull().default(0),
  },
  (t) => [
    uniqueIndex("step_runs_run_node_visit_attempt").on(t.runId, t.nodeId, t.visit, t.attempt),
    index("step_runs_status_lease").on(t.status, t.leaseUntil),
  ],
);

/** Lo que `ctx.once` ya hizo por etapa: una acción re-ejecutada con la misma clave salta esas etapas. */
export const actionEffects = sqliteTable(
  "action_effects",
  {
    /** `run:nodo:visita`. */
    idemKey: text("idem_key").notNull(),
    stage: text().notNull(),
    result: text({ mode: "json" }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.idemKey, t.stage] }),
    check("action_effects_result_json", sql`json_valid(${t.result})`),
  ],
);

export const PROC_KINDS = ["agent", "recipe", "git"] as const;

/**
 * Los procesos que lanza el core, cada uno en su propio grupo, con el `boot_id` que los lanzó. Tras un
 * crash, el próximo arranque mata los de otro `boot_id`. `started_at` es la hora de inicio que el SO
 * le da al proceso (no la del registro): si el pid fue reusado, no coincide.
 */
export const procs = sqliteTable(
  "procs",
  {
    pid: integer().notNull(),
    pgid: integer().notNull(),
    bootId: text("boot_id").notNull(),
    kind: text({ enum: PROC_KINDS }).notNull(),
    /** Sin FK ni tipo: un comando de receta puede correr fuera de un paso. */
    stepRunId: text("step_run_id"),
    startedAt: integer("started_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.bootId, t.pid] })],
);

export const DECISION_KINDS = ["gate", "needs_human", "question", "review_note", "note", "alert"] as const;
export const DECISION_STATUSES = ["pending", "accepted", "rejected", "answered", "expired", "superseded"] as const;

/**
 * La bandeja. Sin FK a `runs` ni a `projects`, como `runs.project_id`: una decisión sobrevive a su
 * corrida y los tests siembran filas sueltas.
 */
export const decisions = sqliteTable(
  "decisions",
  {
    id: text().$type<DecisionId>().primaryKey(),
    projectId: text("project_id").$type<ProjectId>(),
    runId: text("run_id").$type<RunId>(),
    stepRunId: text("step_run_id").$type<StepRunId>(),
    subject: text({ mode: "json" }).$type<SubjectRef>(),
    kind: text({ enum: DECISION_KINDS }).notNull(),
    title: text().notNull(),
    body: text().notNull(),
    options: text({ mode: "json" }).$type<string[]>().notNull(),
    status: text({ enum: DECISION_STATUSES }).notNull(),
    resolution: text({ mode: "json" }).$type<DecisionResolution>(),
    resolvedBy: text("resolved_by"),
    createdAt: integer("created_at").notNull(),
    resolvedAt: integer("resolved_at"),
  },
  (t) => [
    index("decisions_status_project").on(t.status, t.projectId),
    index("decisions_run").on(t.runId),
    check("decisions_options_json", sql`json_valid(${t.options})`),
    check("decisions_subject_json", sql`${t.subject} IS NULL OR json_valid(${t.subject})`),
    check("decisions_resolution_json", sql`${t.resolution} IS NULL OR json_valid(${t.resolution})`),
  ],
);

export const LEARNING_STATUSES = ["proposed", "approved", "rejected", "archived"] as const;
export const LEARNING_SOURCES = ["agent", "human", "import"] as const;

/**
 * Lo que un agente futuro necesita saber. Su alcance es `project_id` o `repo_id` (uno de los dos) y
 * `roles` vacío es todos los roles. Sin FK, como `decisions`: sobrevive a su corrida y a su proyecto.
 * El mismo texto no se repite en un alcance (`learnings_scope_text`): proponer lo que ya existe, en
 * cualquier estado, no lo duplica ni resucita lo que se rechazó.
 */
export const learnings = sqliteTable(
  "learnings",
  {
    id: text().$type<LearningId>().primaryKey(),
    projectId: text("project_id").$type<ProjectId>(),
    repoId: text("repo_id").$type<RepoId>(),
    text: text().notNull(),
    roles: text({ mode: "json" }).$type<string[]>().notNull(),
    tags: text({ mode: "json" }).$type<string[]>().notNull(),
    status: text({ enum: LEARNING_STATUSES }).notNull(),
    source: text({ enum: LEARNING_SOURCES }).notNull(),
    sourceRunId: text("source_run_id").$type<RunId>(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("learnings_project_status").on(t.projectId, t.status),
    index("learnings_repo_status").on(t.repoId, t.status),
    uniqueIndex("learnings_scope_text").on(sql`coalesce(${t.projectId}, '')`, sql`coalesce(${t.repoId}, '')`, t.text),
    check("learnings_one_scope", sql`(${t.projectId} IS NULL) != (${t.repoId} IS NULL)`),
    check("learnings_roles_json", sql`json_valid(${t.roles})`),
    check("learnings_tags_json", sql`json_valid(${t.tags})`),
  ],
);

export const PR_STATES = ["open", "closed", "merged"] as const;

/**
 * Un PR de GitHub que el core conoce (`docs/design.html#d-data`). Lo abre `pr.publish` (`owned`) o lo
 * descubre Watch en la búsqueda de tus PRs; Watch lo mantiene al día. `owned` es 1 si lo abrió el
 * sistema: solo esos se restackean, rebasean o responden. `repo_id` e `issue_id` no tienen FK, como
 * `runs.subject_id`. `state` es el de GitHub y `is_draft` va aparte. `detail` es el último `PrState`
 * que se leyó (JSON, lo que sirve `prs.list`) y `detail_at` cuándo; `head_changed_at` es cuándo se vio
 * moverse el head (un PR con push reciente es "caliente" para el polling).
 */
export const pullRequests = sqliteTable(
  "pull_requests",
  {
    id: text().primaryKey(),
    repoId: text("repo_id").$type<RepoId>().notNull(),
    number: integer().notNull(),
    nodeId: text("node_id").notNull(),
    headRef: text("head_ref").notNull(),
    baseRef: text("base_ref").notNull(),
    headSha: text("head_sha").notNull(),
    state: text({ enum: PR_STATES }).notNull(),
    isDraft: integer("is_draft", { mode: "boolean" }).notNull(),
    issueId: text("issue_id").$type<IssueId>(),
    runId: text("run_id").$type<RunId>(),
    owned: integer({ mode: "boolean" }).notNull().default(false),
    detail: text({ mode: "json" }).$type<PrState>(),
    detailAt: integer("detail_at"),
    headChangedAt: integer("head_changed_at"),
    /** "No mergear nunca este PR": lo marca el usuario y apaga `merge.offer` y `merge.auto` del `PrState`. */
    hold: integer({ mode: "boolean" }).notNull().default(false),
  },
  (t) => [uniqueIndex("pull_requests_repo_number").on(t.repoId, t.number)],
);

/**
 * Lo que Watch ya vio de cada PR (`docs/design.html#d-ops`, "Watch: eventos y qué disparan"). Insertar una
 * marca es emitir el evento: el índice único `(pr_id, kind, key)` hace que cada clave salga una sola vez.
 * `kind` es el tipo del evento (`pr.ci`, `pr.comment`...) y `key` su clave de dedupe (un sha, un id de
 * thread). `head` no es un evento: es la punta que Watch ya evaluó, y sirve para detectar la primera vez
 * que ve un PR y de qué sha viene una punta nueva.
 */
export const watchMarks = sqliteTable(
  "watch_marks",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    prId: text("pr_id")
      .notNull()
      .references(() => pullRequests.id),
    kind: text().notNull(),
    key: text().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("watch_marks_pr_kind_key").on(t.prId, t.kind, t.key)],
);

/**
 * La decisión que ofrece mergear un PR (`pr.mergeReady` con nivel `offer`) y el head sobre el que se ofreció:
 * aprobarla vale para ese contenido, así que si el head cambió después no se comenta nada.
 */
export const mergeOffers = sqliteTable(
  "merge_offers",
  {
    decisionId: text("decision_id").$type<DecisionId>().primaryKey(),
    prId: text("pr_id")
      .notNull()
      .references(() => pullRequests.id),
    headSha: text("head_sha").notNull(),
  },
  (t) => [index("merge_offers_pr").on(t.prId)],
);

/**
 * De qué PRs cuelga un PR del sistema: su base es la branch de cada padre (`docs/design.html#d-ops`,
 * restack). `pr.publish` la escribe al abrir un PR sobre la branch de otro PR abierto; `stack.restack`
 * borra la fila cuando el padre se mergeó y el hijo ya quedó sobre la base nueva.
 */
export const prParents = sqliteTable(
  "pr_parents",
  {
    childId: text("child_id")
      .notNull()
      .references(() => pullRequests.id),
    parentId: text("parent_id")
      .notNull()
      .references(() => pullRequests.id),
  },
  (t) => [primaryKey({ columns: [t.childId, t.parentId] }), index("pr_parents_parent").on(t.parentId)],
);

/**
 * Lo que una corrida cerrada dejó, calculado al cerrarla (`recordRunMetrics`); de aquí salen todas
 * las métricas. `result` es el outcome de la corrida o `canceled`. Sin columnas de un rol: las rondas
 * de review, bot y CI salen de `rounds` (contador → vueltas) y `outcomes` (nodo → outcome → pasos).
 */
export const runMetrics = sqliteTable(
  "run_metrics",
  {
    runId: text("run_id")
      .$type<RunId>()
      .primaryKey()
      .references(() => runs.id),
    result: text().notNull(),
    /** De `started_at` a `ended_at`: incluye lo que la corrida estuvo estacionada. */
    minutes: real().notNull(),
    rounds: text({ mode: "json" }).$type<Record<string, number>>().notNull(),
    outcomes: text({ mode: "json" }).$type<Record<string, Record<string, number>>>().notNull(),
    /** Lo que costaron las sesiones de los pasos de esta corrida, sin las de sus hijas. */
    costMicros: integer("cost_micros").notNull(),
  },
  (t) => [
    check("run_metrics_rounds_json", sql`json_valid(${t.rounds})`),
    check("run_metrics_outcomes_json", sql`json_valid(${t.outcomes})`),
  ],
);

/** El costo de un rol en una corrida: un rol usa un solo modelo por corrida (lo fija el perfil). */
export const runRoleCosts = sqliteTable(
  "run_role_costs",
  {
    runId: text("run_id")
      .$type<RunId>()
      .notNull()
      .references(() => runs.id),
    /** Slug del rol. */
    role: text().notNull(),
    model: text().notNull(),
    effort: text(),
    /** Entrada, salida y caché (lectura y escritura). */
    tokens: integer().notNull(),
    costMicros: integer("cost_micros").notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.role] })],
);
