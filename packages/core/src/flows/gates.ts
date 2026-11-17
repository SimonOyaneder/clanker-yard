import { type DecisionId, type Origin, type RunId, type StepRunId } from "@clanker/api";
import { and, asc, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { closeDecision } from "../decisions/decisions";
import type { Defs } from "../defs/defs";
import { decisions, runs, stepRuns } from "../store/schema";
import type { Store, Tx } from "../store/store";
import { edgeFor, takeEdge } from "./edges";
import {
  DecisionNotFoundError,
  DecisionResolveError,
  FORCE,
  LATEST_PROFILE,
  RunCanceled,
  scopeOf,
  StaleStepError,
  stepPayload,
  StepTimeout,
  type EngineSteps,
  type GateNode,
  type Job,
  type RunRow,
  type Settled,
} from "./engine-shared";
import type { RunFamily } from "./run-family";
import { loanOf, type createSubjects } from "./subjects";

/**
 * Los gates y las decisiones que estacionan una corrida (`gate`, `needs_human`): abrirlos, vencerlos, resolverlos y
 * sacar a la corrida del estacionamiento hacia la cola de su carril.
 */
export function createGates({
  store,
  now,
  defs,
  subjects,
  steps,
  family,
}: {
  store: Store;
  now: () => number;
  defs: Pick<Defs, "get">;
  subjects: ReturnType<typeof createSubjects>;
  steps: Pick<EngineSteps, "wake" | "jobOf" | "loadJob" | "park" | "advance" | "insertStep" | "nextVisit" | "openEdgeNote" | "follow">;
  family: Pick<RunFamily, "cancelFamily" | "abortInFlight">;
}) {
  const { wake, jobOf, loadJob, park, advance, insertStep, nextVisit, openEdgeNote, follow } = steps;
  const { cancelFamily, abortInFlight } = family;

  /**
   * Entra a un gate: el paso queda `waiting` (con su plazo si hay `timeoutSec`), se abre la decisión
   * `gate` y la corrida queda parked, todo en una transacción. Solo esta corrida espera: no retiene
   * slot ni cupo, y el worktree sigue suyo. Lo cierra `resolveGate` o el vencimiento del plazo.
   */
  function openGate(job: Job, node: GateNode, question: unknown): Settled {
    const { run, step } = job;
    const deadline = node.timeoutSec === undefined ? null : now() + node.timeoutSec * 1000;
    store.tx((tx) => {
      const waiting = tx.db
        .update(stepRuns)
        .set({ status: "waiting", owner: null, leaseUntil: null, deadline })
        .where(and(eq(stepRuns.id, step.id), eq(stepRuns.attempt, step.attempt), eq(stepRuns.status, "running")))
        .returning({ id: stepRuns.id })
        .get();
      if (!waiting) throw new StaleStepError(step.id);
      tx.emit({ type: "step.waiting", origin: "core", ...scopeOf(run, step.id), payload: { ...stepPayload(step), waitKey: null, deadline } });
      park(tx, run, step, {
        reason: "gate",
        kind: "gate",
        title: typeof question === "string" ? question : JSON.stringify(question),
        body: node.options.map((option) => `${option.id}: ${option.label}`).join("\n"),
        options: node.options.map((option) => option.id),
      });
    });
    return { kind: "waiting" };
  }

  /** El tick: los gates con `timeoutSec` cuyo plazo pasó siguen solos, con su `default` o con outcome `timeout`. */
  function sweepGates(): void {
    const due = store.db
      .select({ step: stepRuns, run: runs })
      .from(stepRuns)
      .innerJoin(runs, eq(stepRuns.runId, runs.id))
      .where(
        and(
          eq(stepRuns.status, "waiting"),
          isNull(stepRuns.waitKey),
          isNotNull(stepRuns.deadline),
          lte(stepRuns.deadline, now()),
          eq(runs.status, "parked"),
          eq(runs.parkReason, "gate"),
        ),
      )
      .orderBy(asc(stepRuns.id))
      .all();
    for (const { step, run } of due) {
      const job = loadJob(run, step);
      if (job?.node.type !== "gate") continue;
      const { node } = job;
      try {
        store.tx((tx) => {
          const decision = pendingDecisionOf(tx, step.id);
          if (!decision) return;
          const fallback = node.default;
          closeDecision(tx, decision.id, {
            status: "expired",
            resolution: fallback === undefined ? { option: null } : { option: fallback },
            by: "timeout",
          });
          leaveParking(tx, run, decision.id, (current) =>
            advance(
              tx,
              current,
              step,
              node,
              fallback ?? "timeout",
              undefined,
              fallback === undefined ? new StepTimeout(node.timeoutSec ?? 0, "El gate").message : undefined,
            ),
          );
        });
      } catch (error) {
        if (error instanceof StaleStepError) continue;
        console.error(`No se pudo vencer el gate ${step.id} (${step.nodeId}):`, error);
      }
    }
  }

  /** La decisión bloqueante que sigue abierta sobre `stepId`. */
  function pendingDecisionOf(tx: Tx, stepId: StepRunId) {
    return tx.db
      .select()
      .from(decisions)
      .where(and(eq(decisions.stepRunId, stepId), eq(decisions.status, "pending"), inArray(decisions.kind, ["gate", "needs_human"])))
      .get();
  }

  /**
   * La corrida deja de estar estacionada: `leave` la lleva adonde corresponda (el edge de un gate, un
   * paso nuevo, nada) y, si sigue viva, vuelve a la cola de su carril. Va antes que las corridas nuevas
   * porque el dispatcher toma primero las más antiguas. Si mantenimiento tiene prestado su sujeto, la
   * decisión queda resuelta pero la corrida sigue `parked` hasta que se lo devuelvan (`subjects.ended`).
   * Lo mismo si su carril no tiene cupo: sigue `parked` hasta que lo haya.
   */
  function leaveParking(tx: Tx, run: RunRow, decisionId: DecisionId, leave: (current: RunRow) => void): void {
    // Sin cupo en su carril, igual que con el sujeto prestado: la decisión queda resuelta y la corrida sigue
    // `parked` hasta que `promoteQueued` la devuelva (con `run.requeued`).
    const waits = loanOf(tx.db, run.id) !== undefined || !subjects.hasLaneRoom(tx.db, run);
    const resumed: RunRow = waits ? run : { ...run, status: "running", parkReason: null };
    if (!waits) tx.db.update(runs).set({ status: "running", parkReason: null }).where(eq(runs.id, run.id)).run();
    leave(resumed);
    const after = tx.db.select().from(runs).where(eq(runs.id, run.id)).get();
    if (!waits && after?.status === "running") {
      tx.emit({ type: "run.requeued", origin: "core", ...scopeOf(run), payload: { decisionId, reason: run.parkReason } });
    }
  }

  /** La corrida pasa a la versión vigente del perfil que fijó (no cambia de perfil); sin perfil fijado no hay nada que tomar. */
  function adoptCurrentProfile(tx: Tx, run: RunRow): void {
    if (run.profileDefId === null) return;
    const current = defs.get("profile", run.profileDefId);
    if (!current) throw new DecisionResolveError(`El perfil que fijó la corrida ${run.id} ya no existe.`);
    tx.db.update(runs).set({ profileVersion: current.currentVersion }).where(eq(runs.id, run.id)).run();
  }

  function resolveGate(decisionId: DecisionId, option: string, by: Origin): void {
    const canceled = store.tx((tx) => resolveDecision(tx, decisionId, option, by));
    if (canceled) abortInFlight(canceled.stepIds, new RunCanceled(canceled.runId));
    wake();
  }

  /** `resolveGate` dentro de la transacción de quien llama. Si la opción canceló la corrida, devuelve lo que `abortInFlight` debe interrumpir. */
  function resolveDecision(tx: Tx, decisionId: DecisionId, option: string, by: Origin): { runId: RunId; stepIds: StepRunId[] } | undefined {
    const decision = tx.db.select().from(decisions).where(eq(decisions.id, decisionId)).get();
    if (!decision) throw new DecisionNotFoundError(decisionId);
    if (decision.status !== "pending") {
      throw new DecisionResolveError(`La decisión ${decisionId} ya está ${decision.status}: no hay nada que resolver.`);
    }
    // Una decisión que no bloquea (nota, pregunta, alerta) no tiene corrida que reencolar: resolverla es
    // dejar constancia de lo elegido o respondido (`option` es una de sus opciones o un texto libre).
    if (decision.kind !== "gate" && decision.kind !== "needs_human") {
      closeDecision(tx, decisionId, { status: "answered", resolution: { option }, by });
      return undefined;
    }
    const run = decision.runId === null ? undefined : tx.db.select().from(runs).where(eq(runs.id, decision.runId)).get();
    const step = decision.stepRunId === null ? undefined : tx.db.select().from(stepRuns).where(eq(stepRuns.id, decision.stepRunId)).get();
    if (!run || run.status !== "parked" || !step) {
      throw new DecisionResolveError(`La decisión ${decisionId} no tiene a ninguna corrida estacionada esperándola.`);
    }
    if (!decision.options.includes(option)) {
      throw new DecisionResolveError(`"${option}" no es una opción de la decisión ${decisionId}: ${decision.options.join(", ")}.`);
    }
    closeDecision(tx, decisionId, { status: "answered", resolution: { option }, by });

    if (run.parkReason === "gate") {
      const { node } = jobOf(run, step);
      if (node.type !== "gate") throw new DecisionResolveError(`El paso ${step.id} no es un gate.`);
      leaveParking(tx, run, decisionId, (current) => advance(tx, current, step, node, option, undefined, undefined));
    } else if (option === "cancel") {
      return { runId: run.id, stepIds: cancelFamily(tx, run.id, by) };
    } else if (option === "continue" || option === `continue${LATEST_PROFILE}`) {
      // El paso listo sigue pending: al volver la corrida a running, el dispatcher lo toma.
      leaveParking(tx, run, decisionId, (current) => {
        if (option !== "continue") adoptCurrentProfile(tx, current);
      });
    } else if (option === "retry" || option === `retry${LATEST_PROFILE}`) {
      leaveParking(tx, run, decisionId, (current) => {
        if (option !== "retry") adoptCurrentProfile(tx, current);
        insertStep(tx, current, step.nodeId, { visit: nextVisit(tx, run.id, step.nodeId), round: step.round, prev: step.prevStepRunId ?? undefined });
      });
    } else {
      const outcome = option.slice(FORCE.length);
      const { node } = jobOf(run, step);
      leaveParking(tx, run, decisionId, (current) => {
        const edge = edgeFor(node, outcome);
        if (edge === undefined) throw new DecisionResolveError(`El nodo "${step.nodeId}" no tiene edge para el outcome "${outcome}".`);
        const taken = takeEdge(edge, `${step.nodeId}.${outcome}`, current.rounds, current.params);
        if (taken.note !== undefined) openEdgeNote(tx, current, step, outcome, taken.note);
        follow(tx, current, step, taken, 0);
      });
    }
    return undefined;
  }

  return { openGate, sweepGates, leaveParking, resolveGate, resolveDecision };
}

export type Gates = ReturnType<typeof createGates>;
