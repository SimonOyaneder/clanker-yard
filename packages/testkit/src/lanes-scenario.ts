import { type Client, type FlowDef, FlowBody, type NewLocalIssue, type RepoId } from "@clanker/api";
import { createDefs, newId, type Store } from "@clanker/core";

// El escenario de `DEMO_SCENARIO=lanes` (ver `demo-core.ts`): el proyecto de las capturas de la vista de
// Operación. Dev está lleno (1/1) con una corrida en review, otra corrida de dev está estacionada con su
// decisión y su PR prestado a un rebase que corre en mantenimiento (0 de dev, 1/2 de mantenimiento), la
// cola tiene dos issues listas (una subida) y una saltada, y el breaker de GitHub está abierto.
//
// Las corridas se escriben directo en la base, con el estado que el motor les dejaría, porque el runtime
// fake no se queda quieto en un estado el rato que dura una captura. Nada las despacha: los pasos `running`
// y `waiting` son de un core que ya no existe y el dispatcher solo toma los `pending`.

const MIN = 60_000;

const REBASE: FlowDef = {
  schema: 1,
  id: "rebase",
  name: "Rebase de un PR",
  trigger: { type: "pr.conflict" },
  lane: "maintenance",
  start: "attach",
  nodes: {
    attach: { type: "action", action: "workspace.attach", args: {}, on: { ok: "rebase" } },
    rebase: { type: "action", action: "workspace.rebase", args: {}, on: { ok: "checks" } },
    checks: { type: "action", action: "recipe.check", args: {}, on: { ok: "push" } },
    push: { type: "action", action: "pr.pushLease", args: {}, on: { ok: "@done" } },
  },
};

type StepStatus = "done" | "running" | "waiting" | "failed" | "pending";
type Step = [node: string, status: StepStatus, costMicros?: number, outcome?: string | null, error?: string];

export async function seedLanes({ client, store, repoId, now = Date.now() }: { client: Client; store: Store; repoId: RepoId; now?: number }): Promise<void> {
  const sql = store.db.$client;
  const defs = createDefs(store);
  // Otro `Defs` sobre la misma base: solo para dejar el flujo de rebase, que el core todavía no trae como plantilla.
  defs.register("flow", FlowBody);
  const rebase = defs.save({ kind: "flow", slug: "rebase", scope: "builtin", source: "demo", body: REBASE });
  const techlead = defs.resolve("flow", "techlead-clasico");
  if (!techlead) throw new Error("El core no instaló la plantilla techlead-clasico.");

  const project = await client.projects.create({
    slug: "boundaries",
    name: "Boundaries de engines",
    tracker: "local",
    defaultFlowId: "techlead-clasico",
    parallel: 1,
    repos: [{ repoId, labels: [] }],
    flowParams: { repo: repoId },
  });
  const issue = async (title: string, priority: NewLocalIssue["priority"]) => (await client.issues.createLocal({ projectId: project.id, title, priority })).id;
  const reviewing = await issue("Separar el cálculo de comisiones por organización", 2);
  const parked = await issue("Lint de imports entre engines", 2);
  const shipped = await issue("Prohibir imports cruzados entre engines", 3);
  await issue("Reglas de boundaries para engines nuevas", 2);
  const later = await issue("Documentar los boundaries en el README", 4);
  const skipped = await issue("Migrar los helpers de fechas a un engine propio", 2);
  await client.projects.skipIssue({ id: project.id, issueId: skipped });
  // La de menos prioridad sube sola al principio: eso es lo que hace "subirla en la cola".
  await client.projects.boostIssue({ id: project.id, issueId: later });

  const pr = (number: number, issueId: string, runId: string, branch: string) => {
    const id = newId("pr");
    sql
      .prepare(
        `INSERT INTO pull_requests (id, repo_id, number, node_id, head_ref, base_ref, head_sha, state, is_draft, issue_id, run_id, owned)
         VALUES (?, ?, ?, ?, ?, 'main', ?, 'open', ?, ?, ?, 1)`,
      )
      .run(id, repoId, number, `PR_${number}`, branch, "a".repeat(40), number === 4251 ? 1 : 0, issueId, runId);
    return id;
  };

  const run = (input: { issueId: string; subject?: { type: "issue" | "pr"; id: string }; flow: { id: string; version: number }; lane: "dev" | "maintenance"; status: string; parkReason?: string; outcome?: string; borrowedFrom?: string; claimedPr?: string; startedMin: number; endedMin?: number; cost: number; steps: Step[] }) => {
    const id = newId("run");
    const subject = input.subject ?? { type: "issue", id: input.issueId };
    sql
      .prepare(
        `INSERT INTO runs (id, project_id, subject_type, subject_id, flow_def_id, flow_version, roles, lane, status, park_reason, outcome, writes, params, rounds,
                           cost_micros, started_at, ended_at, borrowed_from_run_id, claimed_pr_id)
         VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, 1, '{"base":"main"}', '{}', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        project.id,
        subject.type,
        subject.id,
        input.flow.id,
        input.flow.version,
        input.lane,
        input.status,
        input.parkReason ?? null,
        input.outcome ?? null,
        input.cost,
        now - input.startedMin * MIN,
        input.endedMin === undefined ? null : now - input.endedMin * MIN,
        input.borrowedFrom ?? null,
        input.claimedPr ?? null,
      );
    for (const [node, status, cost = 0, outcome = status === "done" ? "ok" : null, error] of input.steps) {
      sql
        .prepare(`INSERT INTO step_runs (id, run_id, node_id, visit, round, attempt, status, outcome, error, cost_micros) VALUES (?, ?, ?, 1, 0, 1, ?, ?, ?, ?)`)
        .run(newId("stp"), id, node, status, outcome, error ?? null, cost);
    }
    return id;
  };
  const tl = { id: techlead.id, version: techlead.version };

  // Dev lleno: una corrida en la segunda ronda de reviews.
  run({
    issueId: reviewing,
    flow: tl,
    lane: "dev",
    status: "running",
    startedMin: 24,
    cost: 3_100_000,
    steps: [["ws", "done"], ["plan", "done", 400_000], ["implement", "done", 1_200_000], ["checks", "done"], ["reviews", "waiting"], ["rv-bugs", "running", 310_000], ["rv-tests", "done", 120_000], ["rv-patterns", "done", 100_000], ["rv-lore", "done", 90_000]],
  });

  // Estacionada: el paso implement se pasó del tope y falló tras su reintento. Ya tiene un PR en draft, que mantenimiento le pidió prestado.
  const parkedRun = run({
    issueId: parked,
    flow: tl,
    lane: "dev",
    status: "parked",
    parkReason: "needs_human",
    startedMin: 50,
    cost: 3_350_000,
    steps: [["ws", "done"], ["plan", "done", 350_000], ["implement", "failed", 3_000_000, null, "tope de gasto excedido"]],
  });
  const parkedPr = pr(4251, parked, parkedRun, "lint-imports-entre-engines");
  sql.prepare("UPDATE runs SET claimed_pr_id = ? WHERE id = ?").run(parkedPr, parkedRun);
  sql
    .prepare(
      `INSERT INTO decisions (id, project_id, run_id, subject, kind, title, body, options, status, created_at)
       VALUES (?, ?, ?, ?, 'needs_human', ?, ?, ?, 'pending', ?)`,
    )
    .run(
      newId("dec"),
      project.id,
      parkedRun,
      JSON.stringify({ type: "issue", id: parked }),
      "El paso implement se pasó del tope de gasto tras su reintento",
      "Solo se estaciona esta corrida: el carril dev y el de mantenimiento siguen.",
      JSON.stringify(["retry", "cancel"]),
      now - 38 * MIN,
    );

  // El rebase que mantenimiento corre sobre ese PR mientras dev sigue lleno.
  run({
    issueId: parked,
    subject: { type: "pr", id: parkedPr },
    flow: { id: rebase.id, version: rebase.version },
    lane: "maintenance",
    status: "running",
    borrowedFrom: parkedRun,
    startedMin: 3,
    cost: 0,
    steps: [["attach", "done"], ["rebase", "done"], ["checks", "running"]],
  });

  // Una terminada, con su PR abierto.
  const shippedRun = run({
    issueId: shipped,
    flow: tl,
    lane: "dev",
    status: "done",
    outcome: "done",
    startedMin: 180,
    endedMin: 150,
    cost: 3_020_000,
    steps: [["ws", "done"], ["plan", "done", 300_000], ["implement", "done", 2_100_000], ["checks", "done"], ["reviews", "done"], ["sync", "done", 0, "same"], ["commit", "done", 150_000], ["publish", "done"], ["feedback", "done", 0, "done"]],
  });
  pr(4249, shipped, shippedRun, "prohibir-imports-cruzados");

  // GitHub cortó las requests por cuota: el breaker abre solo y se vuelve a probar cuando la cuota se reinicia.
  store.tx((tx) => tx.emit({ type: "sync.rate_limited", origin: "core", payload: { resetAt: now + 40 * MIN } }));
}
