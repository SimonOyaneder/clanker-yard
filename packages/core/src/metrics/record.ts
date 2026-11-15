import type { RunId } from "@clanker/api";
import { asc, eq } from "drizzle-orm";
import { agentSessions, defs, runMetrics, runRoleCosts, runs, stepRuns, stepUsage } from "../store/schema";
import type { Tx } from "../store/store";

/**
 * Llena `run_metrics` y `run_role_costs` de una corrida que acaba de cerrar, en la tx que la cierra:
 * el contador de rondas y los pasos son los de ese instante. El costo y los tokens salen de `step_usage`
 * (lo que cada paso consumió, también en un resume con el mismo id de sesión) y el rol, el modelo y el
 * effort, de la sesión; no de `runs.cost_micros`, que una cancelación no actualiza. La suma de los
 * roles es el total. Se puede repetir: reemplaza lo que hubiera.
 */
export function recordRunMetrics(tx: Tx, runId: RunId): void {
  const run = tx.db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run || run.endedAt === null) throw new Error(`La corrida ${runId} no está cerrada: no hay métricas que registrar.`);

  const outcomes: Record<string, Record<string, number>> = {};
  for (const { nodeId, outcome } of tx.db.select().from(stepRuns).where(eq(stepRuns.runId, runId)).all()) {
    if (outcome === null) continue;
    const node = (outcomes[nodeId] ??= {});
    node[outcome] = (node[outcome] ?? 0) + 1;
  }

  const usage = tx.db
    .select({ session: agentSessions, role: defs.slug, tokens: stepUsage.tokens, costMicros: stepUsage.costMicros })
    .from(stepUsage)
    .innerJoin(stepRuns, eq(stepRuns.id, stepUsage.stepRunId))
    .innerJoin(agentSessions, eq(agentSessions.id, stepUsage.sessionId))
    .innerJoin(defs, eq(defs.id, agentSessions.roleDefId))
    .where(eq(stepRuns.runId, runId))
    .orderBy(asc(agentSessions.startedAt), asc(agentSessions.id))
    .all();
  const byRole = new Map<string, typeof runRoleCosts.$inferInsert>();
  for (const { session, role, tokens, costMicros } of usage) {
    const acc = byRole.get(role);
    if (acc) {
      acc.tokens += tokens;
      acc.costMicros += costMicros;
    } else {
      byRole.set(role, { runId, role, model: session.model, effort: session.effort, tokens, costMicros });
    }
  }

  const row = {
    result: run.outcome ?? run.status,
    minutes: (run.endedAt - run.startedAt) / 60_000,
    rounds: run.rounds,
    outcomes,
    costMicros: [...byRole.values()].reduce((sum, r) => sum + r.costMicros, 0),
  };
  tx.db.insert(runMetrics).values({ runId, ...row }).onConflictDoUpdate({ target: runMetrics.runId, set: row }).run();
  tx.db.delete(runRoleCosts).where(eq(runRoleCosts.runId, runId)).run();
  if (byRole.size > 0) tx.db.insert(runRoleCosts).values([...byRole.values()]).run();
}
