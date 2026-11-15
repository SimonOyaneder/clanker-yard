import type { DayMetrics, DayMetricsFilter, IssueId, IssueMetrics, MetricsFilter, ModelMetrics, ProjectId, ProjectSummary, RoleMetrics, StepMetrics } from "@clanker/api";
import { and, desc, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { defs, runMetrics, runRoleCosts, runs, stepRuns, stepUsage } from "../store/schema";
import type { Store } from "../store/store";

export interface Metrics {
  byRole(filter?: MetricsFilter): RoleMetrics[];
  byDay(filter?: DayMetricsFilter): DayMetrics[];
  byModel(filter?: MetricsFilter): ModelMetrics[];
  /** Por costo: lo que gastó cada nodo de cada flujo. Las corridas importadas no tienen pasos. */
  byStep(filter?: MetricsFilter): StepMetrics[];
  /** Por costo: cada issue con su costo y las vueltas de sus contadores. */
  byIssue(filter?: MetricsFilter): IssueMetrics[];
  /** Solo corridas cerradas del proyecto; `filter` acota por cierre y origen como en `byRole`. */
  summary(projectId: ProjectId, filter?: Omit<MetricsFilter, "projectId">): ProjectSummary;
}

/** Lo que se calculó al cerrar cada corrida (`recordRunMetrics`), agregado. */
export function createMetrics(store: Pick<Store, "db">): Metrics {
  const { db } = store;
  const closed = (f: MetricsFilter) =>
    and(
      f.projectId === undefined ? undefined : eq(runs.projectId, f.projectId),
      f.from === undefined ? undefined : gte(runs.endedAt, f.from),
      f.to === undefined ? undefined : lt(runs.endedAt, f.to),
      f.imported === undefined ? undefined : f.imported ? isNotNull(runs.sourceKey) : isNull(runs.sourceKey),
    );
  const cost = sql<number>`sum(${runRoleCosts.costMicros})`.mapWith(Number);
  const tokens = sql<number>`sum(${runRoleCosts.tokens})`.mapWith(Number);

  function byRole(filter: MetricsFilter = {}): RoleMetrics[] {
    return db
      .select({ role: runRoleCosts.role, runs: sql<number>`count(*)`.mapWith(Number), tokens, costMicros: cost })
      .from(runRoleCosts)
      .innerJoin(runs, eq(runs.id, runRoleCosts.runId))
      .where(closed(filter))
      .groupBy(runRoleCosts.role)
      .orderBy(desc(cost), runRoleCosts.role)
      .all();
  }

  function byModel(filter: MetricsFilter = {}): ModelMetrics[] {
    return db
      .select({ model: runRoleCosts.model, tokens, costMicros: cost })
      .from(runRoleCosts)
      .innerJoin(runs, eq(runs.id, runRoleCosts.runId))
      .where(closed(filter))
      .groupBy(runRoleCosts.model)
      .orderBy(desc(cost), runRoleCosts.model)
      .all();
  }

  function byDay({ utcOffsetMinutes = 0, ...filter }: DayMetricsFilter = {}): DayMetrics[] {
    const day = sql<string>`strftime('%Y-%m-%d', (${runs.endedAt} + ${utcOffsetMinutes * 60_000}) / 1000, 'unixepoch')`;
    return db
      .select({
        day,
        runs: sql<number>`coalesce(sum(${runs.parentRunId} IS NULL), 0)`.mapWith(Number),
        costMicros: sql<number>`sum(${runMetrics.costMicros})`.mapWith(Number),
      })
      .from(runMetrics)
      .innerJoin(runs, eq(runs.id, runMetrics.runId))
      .where(closed(filter))
      .groupBy(day)
      .orderBy(day)
      .all();
  }

  function byStep(filter: MetricsFilter = {}): StepMetrics[] {
    const cost = sql<number>`sum(${stepUsage.costMicros})`.mapWith(Number);
    return db
      .select({ flow: defs.slug, node: stepRuns.nodeId, steps: sql<number>`count(distinct ${stepRuns.id})`.mapWith(Number), costMicros: cost })
      .from(stepUsage)
      .innerJoin(stepRuns, eq(stepRuns.id, stepUsage.stepRunId))
      .innerJoin(runs, eq(runs.id, stepRuns.runId))
      .innerJoin(runMetrics, eq(runMetrics.runId, runs.id))
      .innerJoin(defs, eq(defs.id, runs.flowDefId))
      .where(closed(filter))
      .groupBy(defs.slug, stepRuns.nodeId)
      .having(sql`${cost} > 0`)
      .orderBy(desc(cost), defs.slug, stepRuns.nodeId)
      .all();
  }

  function byIssue(filter: MetricsFilter = {}): IssueMetrics[] {
    const rows = db
      .select({ issueId: runs.subjectId, root: sql<boolean>`${runs.parentRunId} IS NULL`.mapWith(Boolean), rounds: runMetrics.rounds, costMicros: runMetrics.costMicros })
      .from(runMetrics)
      .innerJoin(runs, eq(runs.id, runMetrics.runId))
      .where(and(closed(filter), eq(runs.subjectType, "issue")))
      .all();
    const byId = new Map<string, IssueMetrics>();
    for (const { issueId, root, rounds, costMicros } of rows) {
      const issue = byId.get(issueId) ?? { issueId: issueId as IssueId, runs: 0, costMicros: 0, rounds: {} };
      byId.set(issueId, issue);
      if (root) issue.runs++;
      issue.costMicros += costMicros;
      for (const [counter, n] of Object.entries(rounds)) if (n > 0) issue.rounds[counter] = (issue.rounds[counter] ?? 0) + n;
    }
    return [...byId.values()].sort((a, b) => b.costMicros - a.costMicros || a.issueId.localeCompare(b.issueId));
  }

  function summary(projectId: ProjectId, filter: Omit<MetricsFilter, "projectId"> = {}): ProjectSummary {
    const scope = closed({ ...filter, projectId });
    const roots = db
      .select({
        result: runMetrics.result,
        count: sql<number>`count(*)`.mapWith(Number),
        minutes: sql<number>`sum(${runMetrics.minutes})`.mapWith(Number),
      })
      .from(runMetrics)
      .innerJoin(runs, eq(runs.id, runMetrics.runId))
      .where(and(scope, isNull(runs.parentRunId)))
      .groupBy(runMetrics.result)
      .orderBy(sql`count(*) desc`, runMetrics.result)
      .all();
    const total = db
      .select({
        costMicros: sql<number>`coalesce(sum(${runMetrics.costMicros}), 0)`.mapWith(Number),
        firstAt: sql<number | null>`min(${runs.endedAt})`.mapWith((v) => (v === null ? null : Number(v))),
        lastAt: sql<number | null>`max(${runs.endedAt})`.mapWith((v) => (v === null ? null : Number(v))),
      })
      .from(runMetrics)
      .innerJoin(runs, eq(runs.id, runMetrics.runId))
      .where(scope)
      .get();
    // Las rondas son del flujo de cada corrida (también de las hijas): se suman por contador.
    const rounds = db.all<{ counter: string; total: number }>(sql`
      SELECT j.key AS counter, sum(j.value) AS total
      FROM run_metrics
      JOIN runs ON runs.id = run_metrics.run_id, json_each(run_metrics.rounds) j
      WHERE ${scope}
      GROUP BY j.key
      ORDER BY j.key`);

    const runCount = roots.reduce((n, r) => n + r.count, 0);
    const minutes = roots.reduce((sum, r) => sum + r.minutes, 0);
    const costMicros = total?.costMicros ?? 0;
    return {
      runs: runCount,
      results: roots.map(({ result, count }) => ({ result, count })),
      costMicros,
      avgCostMicros: runCount === 0 ? null : costMicros / runCount,
      minutes,
      avgMinutes: runCount === 0 ? null : minutes / runCount,
      rounds: rounds.map(({ counter, total }) => ({ counter, total, perRun: runCount === 0 ? 0 : total / runCount })),
      byRole: byRole({ ...filter, projectId }),
      firstAt: total?.firstAt ?? null,
      lastAt: total?.lastAt ?? null,
    };
  }

  return { byRole, byDay, byModel, byStep, byIssue, summary };
}
