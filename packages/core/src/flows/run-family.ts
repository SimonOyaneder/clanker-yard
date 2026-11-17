import { LIVE_RUN_STATUSES, type Origin, type RunId, type StepRunId } from "@clanker/api";
import { and, eq, inArray } from "drizzle-orm";
import { closeDecision } from "../decisions/decisions";
import { recordRunMetrics } from "../metrics/record";
import { decisions, runs, stepRuns } from "../store/schema";
import type { Tx } from "../store/store";
import { scopeOf, type RunRow } from "./engine-shared";
import { RunNotFoundError } from "./run-reads";
import type { createSubjects } from "./subjects";

/** Lo que el motor hace con una corrida y sus hijas (las de los subflujos): moverlas de estado, cancelarlas e interrumpir lo que tienen en vuelo. */
export function createRunFamily({
  now,
  subjects,
  controllers,
  nextProbeAt,
}: {
  now: () => number;
  subjects: ReturnType<typeof createSubjects>;
  /** El abort de cada paso que este proceso ejecuta. */
  controllers: Map<StepRunId, AbortController>;
  /** El próximo sondeo de cada wait de este proceso. */
  nextProbeAt: Map<StepRunId, number>;
}) {
  /** La corrida y todas sus descendientes (las de los subflujos), la corrida primero. */
  function familyOf(tx: Tx, runId: RunId): RunId[] {
    const family = [runId];
    for (const id of family) {
      family.push(...tx.db.select({ id: runs.id }).from(runs).where(eq(runs.parentRunId, id)).all().map((r) => r.id));
    }
    return family;
  }

  function runOrThrow(tx: Tx, runId: RunId): RunRow {
    const run = tx.db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!run) throw new RunNotFoundError(runId);
    return run;
  }

  /** Pasa a `to` las corridas de la familia que están en `from` y lo anota con quién lo pidió. Devuelve las que cambió. */
  function moveFamily(tx: Tx, runId: RunId, from: RunRow["status"], to: RunRow["status"], by: Origin, extra: object = {}): RunRow[] {
    const moved = tx.db
      .update(runs)
      .set({ status: to })
      .where(and(inArray(runs.id, familyOf(tx, runId)), eq(runs.status, from)))
      .returning()
      .all();
    for (const run of moved) tx.emit({ type: "run.status", origin: by, ...scopeOf(run), payload: { from, to, ...extra } });
    return moved;
  }

  function cancelFamily(tx: Tx, runId: RunId, by: Origin): StepRunId[] {
    runOrThrow(tx, runId);
    const canceled: StepRunId[] = [];
    for (const run of tx.db.select().from(runs).where(and(inArray(runs.id, familyOf(tx, runId)), inArray(runs.status, LIVE_RUN_STATUSES))).all()) {
      const steps = tx.db
        .update(stepRuns)
        .set({ status: "canceled", error: `La corrida ${runId} se canceló.`, owner: null, leaseUntil: null, notBefore: null })
        .where(and(eq(stepRuns.runId, run.id), inArray(stepRuns.status, ["pending", "leased", "running", "waiting"])))
        .returning({ id: stepRuns.id })
        .all();
      canceled.push(...steps.map((s) => s.id));
      const blocking = tx.db
        .select({ id: decisions.id })
        .from(decisions)
        .where(and(eq(decisions.runId, run.id), eq(decisions.status, "pending"), inArray(decisions.kind, ["gate", "needs_human"])))
        .all();
      for (const { id } of blocking) closeDecision(tx, id, { status: "superseded", by });
      const endedAt = now();
      tx.db.update(runs).set({ status: "canceled", parkReason: null, endedAt }).where(eq(runs.id, run.id)).run();
      recordRunMetrics(tx, run.id);
      subjects.ended(tx, run);
      tx.emit({
        type: "run.finished",
        origin: by,
        ...scopeOf(run),
        payload: { outcome: "canceled", costMicros: run.costMicros, minutes: (endedAt - run.startedAt) / 60_000 },
      });
    }
    return canceled;
  }

  /** Lo que este proceso tiene en vuelo de esos pasos se interrumpe: su cierre ya no calza con su attempt y se descarta. */
  function abortInFlight(stepIds: StepRunId[], reason: Error): void {
    for (const id of stepIds) {
      nextProbeAt.delete(id);
      controllers.get(id)?.abort(reason);
    }
  }

  return { familyOf, runOrThrow, moveFamily, cancelFamily, abortInFlight };
}

export type RunFamily = ReturnType<typeof createRunFamily>;
