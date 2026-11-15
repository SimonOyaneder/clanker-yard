import type {
  ArtifactHash,
  ArtifactKind,
  ConnectionProvider,
  ConnectionStatus,
  Event,
  EventType,
  IssueId,
  IssueRef,
  Milestone,
  Origin,
  Person,
  Priority,
  ProjectId,
  RunId,
  StatusCategory,
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

export const DEF_KINDS = ["flow", "role", "profile", "recipe", "context", "pack"] as const;
export const DEF_SCOPES = ["builtin", "pack", "repo", "user"] as const;

/** Una sola tabla para todo lo versionado: la API y el MCP editan por kind sin casos especiales. */
export const defs = sqliteTable(
  "defs",
  {
    id: text().primaryKey(),
    kind: text({ enum: DEF_KINDS }).notNull(),
    slug: text().notNull(),
    scope: text({ enum: DEF_SCOPES }).notNull(),
    repoId: text("repo_id"),
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
    /** Sin FK hasta que exista `step_runs`. */
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
    secretRef: text("secret_ref").notNull(),
    /** ms epoch; NULL si el token no vence. */
    expiresAt: integer("expires_at"),
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
    repoId: text("repo_id").notNull(),
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
  },
  (t) => [
    uniqueIndex("workspaces_path").on(t.path),
    uniqueIndex("workspaces_repo_branch_live")
      .on(t.repoId, t.branch)
      .where(sql`${t.state} != 'archived'`),
  ],
);

/** Estado de polling y cuota por recurso: ETags (`etag`, `cursor`) y la última cuota que GitHub informó. */
export const syncCursors = sqliteTable("sync_cursors", {
  /** URL o recurso; la cuota de GitHub usa `rate:github:<cuenta>:<recurso>`. */
  key: text().primaryKey(),
  etag: text(),
  cursor: text(),
  checkedAt: integer("checked_at").notNull(),
  rateRemaining: integer("rate_remaining"),
  /** ms epoch en que se renueva la cuota. */
  resetAt: integer("reset_at"),
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
