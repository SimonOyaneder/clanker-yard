import type { ArtifactHash, DecisionId, FlowDef, Node, ParkReason, ProposedLearning, RepoId, RunId, StepRunId } from "@clanker/api";
import { BadRequestError, NotFoundError } from "../errors/domain";
import type { runs, stepRuns } from "../store/schema";
import type { Tx } from "../store/store";
import type { Taken } from "./edges";

// Lo que comparten el motor (`engine.ts`) y los módulos que lo componen (`run-family.ts`, `gates.ts`,
// `commands.ts`): las filas, el trabajo de un paso, cómo se cierra, los errores y las marcas con que un paso
// vuelve a pending.

/** El `error` con que `recover` reabre un paso: lo que sigue en el paso hasta que se cierre o falle de nuevo. */
export const RESUMED_AFTER_CUT = "La app se cerró con este paso en curso; se retoma.";
/** El `error` con que se reabre un paso cuya corrida se pausó con `now`: igual que un corte, pero lo pidió una persona. */
const RESUMED_AFTER_PAUSE = "La corrida se pausó con este paso en curso; se retoma.";
/** El `error` con que se reabre un paso al que una persona le dejó un mensaje (`steer`): se retoma la sesión con ese mensaje. */
export const STEERED = "Una persona le dejó un mensaje al agente; se retoma su sesión.";
/** El `error` de un paso que una persona reintentó: su sesión es nueva aunque el nodo diga `resumeFrom`. */
export const RETRIED = "Una persona reintentó este paso; la sesión es nueva.";
/** El `error` de una sesión de agente que una interrupción (corte, apagado, pausa o mensaje) dejó sin cerrar: así `performAgent` la reconoce para retomarla. */
export const SESSION_CUT = "La sesión se interrumpió con el paso en curso; se retoma.";
const CUT_NOTICE =
  "La app se reinició mientras trabajabas en esta tarea. Revisa el worktree: puede tener cambios a medias de antes del corte. Termina tu tarea.";
const PAUSE_NOTICE =
  "Una persona pausó la corrida mientras trabajabas en esta tarea. Revisa el worktree: puede tener cambios a medias de antes de la pausa. Termina tu tarea.";
/** El `error` con que se reintenta un paso de agente que se pasó de su tope: así `performAgent` sabe que ya escaló y la segunda vez no reintenta. */
export const ESCALATED = "El agente se pasó de su tope de gasto o de turnos; se reintenta con el perfil escalado y un handoff.";
export const STEER_NOTICE = "Una persona que supervisa esta corrida te dejó este mensaje para tu tarea:";
const HANDOFF_NOTICE =
  "La sesión anterior de esta tarea se pasó de su tope de gasto o de turnos y se cerró. Revisa el worktree (git status y git diff --stat): puede tener cambios a medias. Termina tu tarea.";

/**
 * Por qué se reabrió un paso de agente, leído de su `error` (lo único que sobrevive a un corte): con qué aviso
 * arranca el agente y qué sesión retoma. `unfinished` es la que la interrupción dejó sin cerrar, `steer` la del
 * mensaje de la persona y `none` una nueva (sin `resumeFrom` del nodo).
 */
export const REOPENED: Record<string, { notice?: string; resume: "unfinished" | "steer" | "none" }> = {
  [RESUMED_AFTER_CUT]: { notice: CUT_NOTICE, resume: "unfinished" },
  [RESUMED_AFTER_PAUSE]: { notice: PAUSE_NOTICE, resume: "unfinished" },
  [STEERED]: { resume: "steer" },
  [ESCALATED]: { notice: HANDOFF_NOTICE, resume: "none" },
  [RETRIED]: { resume: "none" },
};
/** Prefijo de la opción de un `needs_human` que sigue el edge de un outcome sin ejecutar el paso: `force:ok`. */
export const FORCE = "force:";

/** Si una persona puede forzar el outcome del nodo: solo action y wait, nunca un agente (decisión #44). */
export function forceable(node: Node): boolean {
  return node.type === "action" || node.type === "wait";
}
/**
 * Sufijo de `retry` y `continue` en una decisión de `needs_human`: antes de seguir, la corrida toma la versión
 * vigente de su perfil en vez de la que fijó al empezar (así un tope por rol que la persona subió vale ya).
 * Es lo único que una opción cambia del pin: los roles y los flujos siguen en su versión.
 */
export const LATEST_PROFILE = ":latest-profile";

export type RunRow = typeof runs.$inferSelect;
export type StepRow = typeof stepRuns.$inferSelect;

export type GateNode = Extract<Node, { type: "gate" }>;

/** El comando no se puede aplicar a la corrida o al paso en su estado actual: no cambió nada y el mensaje dice qué hacer. */
export class RunCommandError extends BadRequestError {}

/** El `reason` del abort de los pasos de una corrida cancelada. */
export class RunCanceled extends Error {
  constructor(runId: RunId) {
    super(`La corrida ${runId} se canceló.`);
  }
}

/** El `reason` del abort de un paso que una persona reemplazó (`retry`) o cerró a mano (`force`): su cierre tardío se descarta. */
export class StepSuperseded extends Error {
  constructor(stepId: StepRunId) {
    super(`El paso ${stepId} lo reemplazó una persona.`);
  }
}

/**
 * El `reason` del abort de un paso en vuelo que no falló: el core se apaga, la corrida se pausa con `now` o una
 * persona le deja un mensaje. El paso vuelve a pending, sin gastar intento, y su sesión se retoma. `at` es el
 * instante de la interrupción: la sesión que terminó después es la que cortó.
 */
export class Interruption extends Error {
  constructor(
    readonly why: "stop" | "pause" | "steer",
    readonly at: number,
  ) {
    super(
      why === "stop"
        ? "El core se apagó con este paso en curso."
        : why === "pause"
          ? "La corrida se pausó con este paso en curso."
          : "Una persona le dejó un mensaje a este paso.",
    );
  }

  /** El `error` con que el paso queda en pending: lo que `performAgent` lee para saber cómo retomarlo. */
  get marker(): string {
    return this.why === "stop" ? RESUMED_AFTER_CUT : this.why === "pause" ? RESUMED_AFTER_PAUSE : STEERED;
  }
}

/** Un cierre con un attempt que ya no es el vigente: otro dueño tomó el paso y este resultado se descarta. */
export class StaleStepError extends Error {}

/** Cómo terminó una ejecución, antes de decidir qué hace el motor con ella. */
export type Settled =
  /** Un outcome del nodo, o `error`/`timeout`/`skipped`: sigue su edge. `reported` es lo que el reporte del agente le deja a una persona. */
  | { kind: "outcome"; outcome: string; output?: unknown; error?: string; reported?: Reported }
  /** Una excepción: se reintenta según `retry`. */
  | { kind: "failed"; error: string }
  /** El agente se pasó de su tope: un reintento con el perfil escalado y un handoff, sin gastar el `retry` del nodo. */
  | { kind: "escalate" }
  /** Falló el entorno, no el paso: vuelve a pending sin gastar intento. */
  | { kind: "deferred"; error: string; notBefore: number }
  /** Un parallel que abrió sus ramas: el padre espera y lo cierra la transacción de la última rama. */
  | { kind: "waiting" };

/** Lo que un agente dejó en su reporte para una persona (`Report.decisions` y `Report.learnings`): ninguna cosa bloquea a la corrida. */
export interface Reported {
  notes: { title: string; body: string }[];
  learnings: ProposedLearning[];
  /** El repo del worktree donde corrió el agente: el alcance `repo` de sus learnings. */
  repoId?: RepoId;
}

export interface Job {
  run: RunRow;
  /** Con el attempt de este lease. */
  step: StepRow;
  flow: FlowDef;
  node: Node;
  /** Si el paso es una rama de un parallel o su rol consolidador: el id del parallel. */
  parallel?: { parent: string; role: "branch" | "join" };
}


/** La decisión pedida no existe. */
export class DecisionNotFoundError extends NotFoundError {
  constructor(id: DecisionId) {
    super(`No existe la decisión ${id}.`);
  }
}

/** La decisión no se puede resolver así (ya se resolvió, no estaciona a nadie o la opción no es suya): no cambió nada. */
export class DecisionResolveError extends BadRequestError {}


export class StepTimeout extends Error {
  constructor(
    readonly timeoutSec: number,
    subject = "El paso",
  ) {
    super(`${subject} superó su timeoutSec de ${timeoutSec} s.`);
  }
}

export const timedOut = (timeout: StepTimeout): Settled => ({ kind: "outcome", outcome: "timeout", error: timeout.message });

/** Un error que reintentar no arregla (args inválidos, tope de turnos): el outcome `error` sin reintento. */
export const permanent = (error: string): Settled => ({ kind: "outcome", outcome: "error", error });

export const stepPayload = (step: StepRow) => ({
  stepId: step.id,
  nodeId: step.nodeId,
  round: step.round,
  attempt: step.attempt,
});


/** Los campos de un evento sobre la corrida (y el paso, si se da). */
export const scopeOf = (run: RunRow, stepRunId?: StepRunId) => ({
    projectId: run.projectId ?? undefined,
    runId: run.id,
    stepRunId,
    subject: { type: run.subjectType, id: run.subjectId },
  });

/** Cómo queda estacionada una corrida: el motivo y la decisión que se abre. */
export interface Parking {
  reason: ParkReason;
  kind: "gate" | "needs_human";
  title: string;
  body: string;
  options: string[];
}

/** Dónde entra un paso nuevo de un nodo: su visita, su ronda y el paso anterior. */
export interface InsertAt {
  visit: number;
  round: number;
  prev?: StepRunId;
  /** Lo que `performAgent` lee para saber cómo retomarlo. */
  error?: string;
}

/** Cómo se cierra un paso. */
export interface Closing {
  status: "done" | "failed";
  outcome: string;
  outputHash?: ArtifactHash;
  message?: string;
  /** La nota del edge que se tomó. */
  note?: string;
  /** En qué estados está el paso que se cierra; por defecto, el de uno que se ejecutó. Una persona puede cerrar uno pending. */
  from?: StepRow["status"][];
  /** Lo que el reporte del agente le deja a una persona. */
  reported?: Reported;
}

/** Lo que el motor le presta a sus módulos: despertar al dispatcher y cargar, abrir, estacionar, cerrar y seguir un paso. */
export interface EngineSteps {
  wake(): void;
  jobOf(run: RunRow, step: StepRow): Job;
  loadJob(run: RunRow, step: StepRow): Job | undefined;
  park(tx: Tx, run: RunRow, step: StepRow, parking: Parking): void;
  insertStep(tx: Tx, run: RunRow, nodeId: string, at: InsertAt): StepRunId;
  nextVisit(tx: Tx, runId: RunId, nodeId: string): number;
  advance(tx: Tx, run: RunRow, step: StepRow, node: Node, outcome: string, outputHash: ArtifactHash | undefined, error: string | undefined, reported?: Reported): void;
  follow(tx: Tx, run: RunRow, step: StepRow, taken: Taken, cost: number): void;
  openEdgeNote(tx: Tx, run: RunRow, step: StepRow, outcome: string, note: string): void;
  /** Devuelve el costo del paso. */
  closeStep(tx: Tx, run: RunRow, step: StepRow, closing: Closing): number;
  lastSessionOf(stepId: StepRunId): string | undefined;
}
