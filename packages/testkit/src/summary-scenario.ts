import { fileURLToPath } from "node:url";
import { type Client, type IssueId, type ProjectId } from "@clanker/api";
import { createDefs, newId, recordRunMetrics, type Store } from "@clanker/core";

// El escenario de `DEMO_SCENARIO=summary` (ver `demo-core.ts`): el proyecto de las capturas del Resumen. Importa el
// fixture del clanker-loop (`packages/core/fixtures/legacy`: 9 corridas con costo por rol y rondas, sin pasos) y le suma
// corridas de Yard del flujo `techlead-clasico`, con sus pasos, sesiones y uso, en el mismo proyecto: así el Resumen
// mezcla lo importado y lo nuevo, y el filtro de origen los separa.
//
// Las corridas de Yard se escriben directo en la base con las sesiones y el uso que dejaría el motor, y sus métricas las
// calcula `recordRunMetrics` (el mismo código que corre al cerrar una corrida real), así que `projects.summary`,
// `metrics.byStep` y `metrics.byIssue` cuadran entre sí como en el core.

const DAY = 86_400_000;
/** El proyecto de `fixtures/legacy` que recibe las corridas de Yard. */
export const SUMMARY_PROJECT_SLUG = "demo-lote-0a1b2c3d4e5f";

const LEGACY_FIXTURE = fileURLToPath(new URL("../../core/fixtures/legacy", import.meta.url));

// Lo que sincronizaría Linear: el importador deja el título igual a la clave.
const TITLES: Record<string, string> = {
  "DEMO-1": "Extraer los helpers de fechas a un módulo propio",
  "DEMO-2": "Usar el módulo de fechas en el selector de rangos",
  "DEMO-3": "Date picker del dashboard con el módulo de fechas",
  "DEMO-4": "Fechas apiladas: zona horaria del bot en el rebase",
  "DEMO-11": "Cubrir los husos con medio día de diferencia",
  "DEMO-12": "Documentar el módulo de fechas en el README",
  "DEMO-13": "Migrar los formatos de fecha del exportador",
};
const NEW_ISSUES = ["DEMO-11", "DEMO-12", "DEMO-13"];

type Node = [node: string, role: string, model: string, usd: number, visit?: number];
interface YardRun {
  issue: string;
  endedDaysAgo: number;
  minutes: number;
  outcome: "done" | "failed";
  rounds: Record<string, number>;
  steps: Node[];
}

const YARD_RUNS: YardRun[] = [
  {
    issue: "DEMO-4",
    endedDaysAgo: 7,
    minutes: 41,
    outcome: "done",
    rounds: { review: 1, external: 1 },
    steps: [["plan", "dev", "opus", 0.55], ["implement", "dev", "opus", 2.3], ["rv-bugs", "review-bugs", "sonnet", 0.32], ["rv-tests", "review-tests", "sonnet", 0.14], ["rv-patterns", "review-patterns", "sonnet", 0.11], ["rv-lore", "review-lore", "haiku", 0.04], ["commit", "committer", "haiku", 0.05]],
  },
  {
    issue: "DEMO-11",
    endedDaysAgo: 5,
    minutes: 33,
    outcome: "done",
    rounds: { review: 1 },
    steps: [["plan", "dev", "opus", 0.42], ["plan-check", "plan-check", "sonnet", 0.08], ["implement", "dev", "opus", 1.65], ["rv-bugs", "review-bugs", "sonnet", 0.3], ["rv-tests", "review-tests", "sonnet", 0.12], ["commit", "committer", "haiku", 0.04]],
  },
  {
    issue: "DEMO-12",
    endedDaysAgo: 3,
    minutes: 74,
    outcome: "done",
    rounds: { review: 3, external: 2 },
    steps: [
      ["plan", "dev", "opus", 0.61],
      ["implement", "dev", "opus", 2.9],
      ["rv-bugs", "review-bugs", "sonnet", 0.36],
      ["rv-tests", "review-tests", "sonnet", 0.15],
      ["fix", "dev", "opus", 1.4],
      ["rv-bugs", "review-bugs", "sonnet", 0.33, 2],
      ["fix", "dev", "opus", 0.95, 2],
      ["rv-bugs", "review-bugs", "sonnet", 0.3, 3],
      ["commit", "committer", "haiku", 0.05],
    ],
  },
  {
    issue: "DEMO-13",
    endedDaysAgo: 1,
    minutes: 58,
    outcome: "failed",
    rounds: { review: 3 },
    steps: [["plan", "dev", "opus", 0.7], ["implement", "dev", "opus", 3.1], ["rv-bugs", "review-bugs", "sonnet", 0.4], ["fix", "dev", "opus", 1.2], ["rv-bugs", "review-bugs", "sonnet", 0.36, 2], ["fix", "dev", "opus", 1.1, 2], ["rv-bugs", "review-bugs", "sonnet", 0.35, 3]],
  },
];

const micros = (usd: number) => Math.round(usd * 1_000_000);

export async function seedSummary({ client, store, now = Date.UTC(2026, 10, 15, 12) }: { client: Client; store: Store; now?: number }): Promise<{ projectId: ProjectId }> {
  await client.imports.legacy({ from: LEGACY_FIXTURE });
  const project = (await client.projects.list()).find((p) => p.slug === SUMMARY_PROJECT_SLUG);
  if (!project) throw new Error(`El fixture importado no trajo el proyecto ${SUMMARY_PROJECT_SLUG}.`);
  const sql = store.db.$client;
  const defs = createDefs(store);
  const flow = defs.resolve("flow", "techlead-clasico");
  if (!flow) throw new Error("El core no instaló la plantilla techlead-clasico.");

  const rename = sql.prepare("UPDATE issues SET title = ? WHERE project_id = ? AND key = ?");
  for (const [key, title] of Object.entries(TITLES)) rename.run(title, project.id, key);
  for (const key of NEW_ISSUES) {
    sql
      .prepare(
        `INSERT INTO issues (id, tracker, tracker_id, key, url, project_id, tracker_project, title, body, status, raw_status, priority, labels, relations, remote_updated_at)
         VALUES (?, 'linear', ?, ?, ?, ?, ?, ?, '', 'in_review', 'In Review', 0, '[]', '{"blocks":[],"blockedBy":[],"related":[]}', ?)`,
      )
      .run(newId("iss"), key, key, `https://linear.app/acme/issue/${key}`, project.id, project.trackerRef, TITLES[key] ?? key, now);
  }
  const issueId = (key: string) => (sql.prepare("SELECT id FROM issues WHERE project_id = ? AND key = ?").get(project.id, key) as { id: IssueId }).id;

  for (const run of YARD_RUNS) {
    const id = newId("run");
    const endedAt = now - run.endedDaysAgo * DAY;
    sql
      .prepare(
        `INSERT INTO runs (id, project_id, subject_type, subject_id, flow_def_id, flow_version, roles, lane, status, outcome, writes, params, rounds, cost_micros, started_at, ended_at)
         VALUES (?, ?, 'issue', ?, ?, ?, '{}', 'dev', ?, ?, 0, '{}', ?, ?, ?, ?)`,
      )
      .run(id, project.id, issueId(run.issue), flow.id, flow.version, run.outcome, run.outcome, JSON.stringify(run.rounds), run.steps.reduce((sum, s) => sum + micros(s[3]), 0), endedAt - run.minutes * 60_000, endedAt);
    for (const [node, role, model, usd, visit = 1] of run.steps) {
      const roleDef = defs.resolve("role", role);
      if (!roleDef) throw new Error(`La plantilla no trae el rol ${role}.`);
      const step = newId("stp");
      const session = newId("ses");
      const tokens = Math.round(usd * 400_000);
      sql.prepare(`INSERT INTO step_runs (id, run_id, node_id, visit, round, attempt, status, outcome, cost_micros) VALUES (?, ?, ?, ?, ?, 1, 'done', 'ok', ?)`).run(step, id, node, visit, visit - 1, micros(usd));
      sql
        .prepare(
          `INSERT INTO agent_sessions (id, step_run_id, role_def_id, role_version, runtime, session_ref, cwd, model, status, tokens_out, cost_micros, started_at)
           VALUES (?, ?, ?, ?, 'fake', ?, '/tmp/demo', ?, 'success', ?, ?, ?)`,
        )
        .run(session, step, roleDef.id, roleDef.version, `fake-${session}`, model, tokens, micros(usd), endedAt - run.minutes * 60_000);
      sql.prepare(`INSERT INTO step_usage (step_run_id, session_id, tokens, cost_micros) VALUES (?, ?, ?, ?)`).run(step, session, tokens, micros(usd));
    }
    store.tx((tx) => recordRunMetrics(tx, id));
  }
  return { projectId: project.id };
}
