import type {
  ConnectionProvider,
  ConnectionStatus,
  Event,
  EventType,
  Origin,
  ProjectId,
  RunId,
  StepRunId,
  SubjectRef,
} from "@clanker/api";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
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
