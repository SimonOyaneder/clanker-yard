import type {
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
