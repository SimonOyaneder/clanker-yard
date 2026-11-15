import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const meta = sqliteTable("meta", {
  key: text().primaryKey(),
  value: text().notNull(),
});

export const events = sqliteTable(
  "events",
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    ts: integer().notNull(),
    type: text().notNull(),
    origin: text({ enum: ["core", "ui", "cli", "mcp", "watch", "import"] }).notNull(),
    projectId: text("project_id"),
    runId: text("run_id"),
    stepRunId: text("step_run_id"),
    subject: text(),
    payload: text({ mode: "json" }).notNull(),
  },
  (t) => [
    check("events_payload_json", sql`json_valid(${t.payload})`),
    index("events_run_seq").on(t.runId, t.seq),
    index("events_project_seq").on(t.projectId, t.seq),
    index("events_type_seq").on(t.type, t.seq),
  ],
);
