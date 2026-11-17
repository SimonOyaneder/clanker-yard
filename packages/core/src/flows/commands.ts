import { isLiveRun, LIVE_RUN_STATUSES, type Edge, type Origin, type RunId, type StepRunId } from "@clanker/api";
import { and, eq, inArray } from "drizzle-orm";
import { closeDecision } from "../decisions/decisions";
import { messageOf } from "../errors/format";
import { decisions, runs, stepRuns } from "../store/schema";
import type { Store, Tx } from "../store/store";
import { edgeFor, takeEdge } from "./edges";
import {
  FORCE,
  forceable,
  Interruption,
  RETRIED,
  RunCanceled,
  RunCommandError,
  scopeOf,
  STEERED,
  stepPayload,
  StepSuperseded,
  type EngineSteps,
  type Job,
  type StepRow,
} from "./engine-shared";
import type { Gates } from "./gates";
import type { RunFamily } from "./run-family";
import { StepNotFoundError } from "./step-detail";

/** Lo que `stepCommand` hace tras confirmar la transacción: qué pasos interrumpir y cuál es la corrida. */
interface Commanded {
  runId: RunId;
  /** Pasos que una persona reemplazó o cerró: su cierre tardío se descarta. */
  superseded: StepRunId[];
  /** El paso en curso que recibe un mensaje: vuelve a pending y retoma su sesión. */
  interrupt?: Interruption;
}

/**
 * Lo que una persona le pide a una corrida (`control`: pausar, retomar, cancelar) o a uno de sus pasos
 * (`stepCommand`: reintentar, dejarle un mensaje, forzar su outcome). `by` queda en los eventos.
 */
export function createRunCommands({
  store,
  now,
  controllers,
  agentSteps,
  steps,
  family,
  gates,
}: {
  store: Store;
  now: () => number;
  controllers: Map<StepRunId, AbortController>;
  /** Los pasos de agente en vuelo: los únicos que una pausa con `now` interrumpe. */
  agentSteps: Set<StepRunId>;
  steps: Pick<EngineSteps, "wake" | "jobOf" | "insertStep" | "nextVisit" | "lastSessionOf" | "closeStep" | "follow">;
  family: RunFamily;
  gates: Pick<Gates, "leaveParking" | "resolveDecision">;
}) {
  const { wake, jobOf, insertStep, nextVisit, lastSessionOf, closeStep, follow } = steps;
  const { familyOf, runOrThrow, moveFamily, cancelFamily, abortInFlight } = family;
  const { leaveParking, resolveDecision } = gates;

  function control(runId: RunId, cmd: "pause" | "resume" | "cancel", by: Origin, { now: immediately = false }: { now?: boolean } = {}): void {
    if (cmd === "cancel") abortInFlight(store.tx((tx) => cancelFamily(tx, runId, by)), new RunCanceled(runId));
    else if (cmd === "pause") pause(runId, by, immediately);
    else resume(runId, by);
    wake();
  }

  function pause(runId: RunId, by: Origin, immediately: boolean): void {
    const interrupted = store.tx((tx) => {
      const run = runOrThrow(tx, runId);
      if (run.status === "running") moveFamily(tx, runId, "running", "paused", by, { now: immediately });
      else if (run.status !== "paused") {
        throw new RunCommandError(
          run.status === "parked"
            ? `La corrida ${runId} está estacionada: ya espera a una persona y no ocupa nada. Resuelve su decisión o cancélala.`
            : `La corrida ${runId} está ${run.status}: solo se pausa una corrida que corre.`,
        );
      }
      if (!immediately) return [];
      // Los agentes de las corridas pausadas (también las que ya lo estaban) vuelven a pending con su sesión.
      return tx.db
        .select({ id: stepRuns.id })
        .from(stepRuns)
        .innerJoin(runs, eq(stepRuns.runId, runs.id))
        .where(and(inArray(runs.id, familyOf(tx, runId)), eq(runs.status, "paused"), inArray(stepRuns.status, ["leased", "running"])))
        .all()
        .map((step) => step.id);
    });
    const interruption = new Interruption("pause", now());
    for (const id of interrupted) if (agentSteps.has(id)) controllers.get(id)?.abort(interruption);
  }

  function resume(runId: RunId, by: Origin): void {
    store.tx((tx) => {
      const run = runOrThrow(tx, runId);
      if (run.status === "paused") moveFamily(tx, runId, "paused", "running", by);
      else if (run.status !== "running") {
        throw new RunCommandError(`La corrida ${runId} está ${run.status}: solo se retoma una pausada.`);
      }
    });
  }

  function stepCommand(stepId: StepRunId, cmd: { retry: true } | { steer: string } | { force: string }, by: Origin): RunId {
    const done = store.tx((tx) => {
      const step = tx.db.select().from(stepRuns).where(eq(stepRuns.id, stepId)).get();
      const run = step && tx.db.select().from(runs).where(eq(runs.id, step.runId)).get();
      if (!step || !run) throw new StepNotFoundError(stepId);
      if (run.status === "queued" || !isLiveRun(run.status)) {
        throw new RunCommandError(`La corrida ${run.id} está ${run.status}: solo se comanda un paso de una corrida viva.`);
      }
      let job: Job;
      try {
        job = jobOf(run, step);
      } catch (error) {
        throw new RunCommandError(`No se puede cargar el paso ${stepId}: ${messageOf(error)}`, { cause: error });
      }
      if ("retry" in cmd) return retryStep(tx, job, by);
      if ("steer" in cmd) return steerStep(tx, job, cmd.steer, by);
      return forceStep(tx, job, cmd.force, by);
    });
    abortInFlight(done.superseded, new StepSuperseded(stepId));
    if (done.interrupt) controllers.get(stepId)?.abort(done.interrupt);
    wake();
    return done.runId;
  }


  function emitCommanded(tx: Tx, { run, step }: Job, by: Origin, command: string, extra: object = {}, at: StepRow = step): void {
    tx.emit({ type: "step.commanded", origin: by, ...scopeOf(run, at.id), payload: { ...stepPayload(at), command, ...extra } });
  }

  /** La decisión bloqueante abierta sobre la corrida. Hay una a lo más: un paso a la vez avanza una corrida. */
  function blockingDecision(tx: Tx, runId: RunId) {
    return tx.db
      .select()
      .from(decisions)
      .where(and(eq(decisions.runId, runId), eq(decisions.status, "pending"), inArray(decisions.kind, ["gate", "needs_human"])))
      .get();
  }

  /**
   * "Reintentar desde acá": cancela lo que la corrida tiene en marcha (pasos, ramas y corridas hijas), cierra la
   * decisión que la estacionaba y deja una visita nueva del nodo, con sesión nueva. Una corrida estacionada vuelve a
   * la cola de su carril; una pausada sigue pausada.
   */
  function retryStep(tx: Tx, job: Job, by: Origin): Commanded {
    const { run, step } = job;
    if (job.parallel) {
      throw new RunCommandError(`El paso "${step.nodeId}" es ${job.parallel.role === "join" ? "el join" : "una rama"} del parallel "${job.parallel.parent}": reintenta el parallel.`);
    }
    const decision = blockingDecision(tx, run.id);
    const active = tx.db
      .update(stepRuns)
      .set({ status: "canceled", error: `${by} reintentó la corrida desde "${step.nodeId}".`, owner: null, leaseUntil: null, notBefore: null })
      .where(and(eq(stepRuns.runId, run.id), inArray(stepRuns.status, ["pending", "leased", "running", "waiting"])))
      .returning({ id: stepRuns.id })
      .all()
      .map((s) => s.id);
    // Las corridas hijas de lo que se cancela (un nodo `flow` espera a la suya) no pueden seguir sueltas.
    const children = tx.db
      .select({ id: runs.id })
      .from(runs)
      .where(and(inArray(runs.parentStepRunId, active), inArray(runs.status, LIVE_RUN_STATUSES)))
      .all();
    const superseded = [...active, ...children.flatMap((child) => cancelFamily(tx, child.id, by))];
    if (decision) {
      // Reintentar el paso que falló es justo la opción `retry` de su decisión.
      const answered = decision.stepRunId === step.id && decision.options.includes("retry");
      closeDecision(tx, decision.id, { status: answered ? "answered" : "superseded", ...(answered && { resolution: { option: "retry" } }), by });
    }
    emitCommanded(tx, job, by, "retry");
    const reopen = () => insertStep(tx, run, step.nodeId, { visit: nextVisit(tx, run.id, step.nodeId), round: step.round, prev: step.prevStepRunId ?? undefined, error: RETRIED });
    if (decision) leaveParking(tx, run, decision.id, reopen);
    else reopen();
    return { runId: run.id, superseded };
  }

  function steerStep(tx: Tx, job: Job, message: string, by: Origin): Commanded {
    const { run, step, node } = job;
    if (node.type !== "agent") throw new RunCommandError(`Solo un paso de agente recibe un mensaje: "${step.nodeId}" es un ${node.type}.`);
    if (message.trim() === "") throw new RunCommandError("El mensaje para el agente está vacío.");
    if (step.status === "leased" || step.status === "running") {
      if (!controllers.has(step.id)) throw new RunCommandError(`El paso ${step.id} no está en curso en este core.`);
      emitCommanded(tx, job, by, "steer", { message });
      return { runId: run.id, superseded: [], interrupt: new Interruption("steer", now()) };
    }
    if (step.status === "pending") {
      tx.db.update(stepRuns).set({ error: STEERED, notBefore: null }).where(eq(stepRuns.id, step.id)).run();
      emitCommanded(tx, job, by, "steer", { message });
      return { runId: run.id, superseded: [] };
    }
    const decision = blockingDecision(tx, run.id);
    if (step.status === "failed" && run.status === "parked" && decision?.kind === "needs_human" && decision.stepRunId === step.id) {
      // El paso nuevo retoma la última sesión del que falló, con el mensaje.
      closeDecision(tx, decision.id, { status: "superseded", by });
      leaveParking(tx, run, decision.id, (current) => {
        const reopened = insertStep(tx, current, step.nodeId, {
          visit: nextVisit(tx, run.id, step.nodeId),
          round: step.round,
          prev: step.prevStepRunId ?? undefined,
          error: STEERED,
        });
        const session = lastSessionOf(step.id);
        tx.emit({
          type: "step.commanded",
          origin: by,
          ...scopeOf(run, reopened),
          payload: { stepId: reopened, nodeId: step.nodeId, round: step.round, attempt: 0, command: "steer", message, ...(session && { session }) },
        });
      });
      return { runId: run.id, superseded: [] };
    }
    throw new RunCommandError(
      `El paso "${step.nodeId}" está ${step.status}: un mensaje solo llega a un agente en curso, pendiente o que falló y espera tu decisión. Para volver a correr un paso terminado, reintenta desde él.`,
    );
  }

  function forceStep(tx: Tx, job: Job, outcome: string, by: Origin): Commanded {
    const { run, step, node } = job;
    if (!forceable(node)) {
      throw new RunCommandError(`Solo se fuerza el resultado de un paso action o wait (nunca el de un agente): "${step.nodeId}" es un ${node.type}.`);
    }
    if (job.parallel) {
      throw new RunCommandError(`El paso "${step.nodeId}" es una rama del parallel "${job.parallel.parent}": fuerza el parallel o reintenta.`);
    }
    const declared = Object.keys(node.on ?? {});
    if (!declared.includes(outcome)) {
      throw new RunCommandError(`El nodo "${step.nodeId}" no declara el outcome "${outcome}": ${declared.join(", ") || "ninguno"}.`);
    }
    const decision = blockingDecision(tx, run.id);
    if (step.status === "failed" && run.status === "parked" && decision?.kind === "needs_human" && decision.stepRunId === step.id) {
      emitCommanded(tx, job, by, "force", { outcome });
      resolveDecision(tx, decision.id, `${FORCE}${outcome}`, by);
      return { runId: run.id, superseded: [] };
    }
    const open = ["pending", "leased", "running", "waiting"].includes(step.status);
    if (!open || run.status === "parked") {
      throw new RunCommandError(
        run.status === "parked"
          ? `La corrida ${run.id} está estacionada esperando una decisión: resuélvela, o reintenta desde el paso.`
          : `El paso "${step.nodeId}" está ${step.status}: solo se fuerza el que la corrida tiene en marcha.`,
      );
    }
    // Como `advance`, pero el paso no se ejecutó (o no terminó de esperar): lo cierra la persona.
    const taken = takeEdge(edgeFor(node, outcome) as Edge, `${step.nodeId}.${outcome}`, run.rounds, run.params);
    emitCommanded(tx, job, by, "force", { outcome });
    const cost = closeStep(tx, run, step, { status: "done", outcome, note: taken.note, from: ["pending", "leased", "running", "waiting"] });
    follow(tx, tx.db.select().from(runs).where(eq(runs.id, run.id)).get() ?? run, step, taken, cost);
    return { runId: run.id, superseded: [step.id] };
  }

  return { control, stepCommand };
}
