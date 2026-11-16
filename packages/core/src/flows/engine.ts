import {
  FlowDef,
  Profile,
  Role,
  type AgentRuntimeId,
  type ArtifactHash,
  type Brief,
  type DecisionId,
  type Edge,
  type Node,
  type Origin,
  type ParkReason,
  type ProjectId,
  type RunId,
  type RunUsage,
  type RunWorkspace,
  type StepRunId,
  type SubjectRef, type RepoId } from "@clanker/api";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lte, max, ne, or, sql, sum } from "drizzle-orm";
import type { AgentResult, Agents } from "../agents/agents";
import type { Artifacts } from "../artifacts/artifacts";
import { GITHUB_SCOPE, repoScope, runtimeScope, type Breakers } from "../breakers/breakers";
import { closeDecision, openDecision } from "../decisions/decisions";
import type { Defs } from "../defs/defs";
import { MAX_PROPOSED_PER_STEP } from "../learnings/criteria";
import { proposeLearning } from "../learnings/learnings";
import { recordRunMetrics } from "../metrics/record";
import { microsToUsd, newId, usdToMicros } from "../store/conventions";
import { actionEffects, agentSessions, decisions, projects, runs, stepRuns, stepUsage, type DefPin } from "../store/schema";
import type { Store, Tx } from "../store/store";
import { EnvironmentError, PermanentActionError, type ActionCtx, type ActionDef, type ConsolidatorDef, type ExternalEvent, type RetryPolicy, type WaitDef, type WaitResult } from "./catalog";
import { edgeFor, edgesOf, maxRoundsOf, takeEdge, type Taken } from "./edges";
import {
  agentRolesOf,
  branchIds,
  joinStepId,
  parallelOf,
  stepNode,
  type ParallelNode,
} from "./parallel";
import { createRunReads, OUTPUT_INLINE_MAX_BYTES, RunNotFoundError } from "./run-reads";
import { createSubjects, hasWaiting, loanOf, type SubjectsDeps } from "./subjects";
import { StepNotFoundError } from "./step-detail";
import { isTruthy, resolveRefs } from "./refs";
import { calledFlows, LANE_BY_TRIGGER } from "./validate";
import { issuesInline, messageOf } from "../errors/format";
import { isRecord } from "../defs/defs";
import { BadRequestError, NotFoundError } from "../errors/domain";
import { createErrorReporter, type ErrorReporter } from "../errors/reporter";

/** El lease de un paso: el core dueño lo renueva cada tercio mientras el paso vive. */
const STEP_LEASE_TTL_MS = 120_000;
/** Entre dos despertares del dispatcher, más que esto es que la máquina durmió: los timers no corrieron. */
const CLOCK_JUMP_MS = 30_000;
/** A la tercera vez que un corte interrumpe el mismo paso, el paso da error en vez de reabrirse. */
const MAX_CUTS = 3;
/** El `error` con que `recover` reabre un paso: lo que sigue en el paso hasta que se cierre o falle de nuevo. */
const RESUMED_AFTER_CUT = "La app se cerró con este paso en curso; se retoma.";
/** El `error` con que se reabre un paso cuya corrida se pausó con `now`: igual que un corte, pero lo pidió una persona. */
const RESUMED_AFTER_PAUSE = "La corrida se pausó con este paso en curso; se retoma.";
/** El `error` con que se reabre un paso al que una persona le dejó un mensaje (`steer`): se retoma la sesión con ese mensaje. */
const STEERED = "Una persona le dejó un mensaje al agente; se retoma su sesión.";
/** El `error` de un paso que una persona reintentó: su sesión es nueva aunque el nodo diga `resumeFrom`. */
const RETRIED = "Una persona reintentó este paso; la sesión es nueva.";
/** El `error` de una sesión de agente que una interrupción (corte, apagado, pausa o mensaje) dejó sin cerrar: así `performAgent` la reconoce para retomarla. */
const SESSION_CUT = "La sesión se interrumpió con el paso en curso; se retoma.";
const CUT_NOTICE =
  "La app se reinició mientras trabajabas en esta tarea. Revisa el worktree: puede tener cambios a medias de antes del corte. Termina tu tarea.";
const PAUSE_NOTICE =
  "Una persona pausó la corrida mientras trabajabas en esta tarea. Revisa el worktree: puede tener cambios a medias de antes de la pausa. Termina tu tarea.";
/** El `error` con que se reintenta un paso de agente que se pasó de su tope: así `performAgent` sabe que ya escaló y la segunda vez no reintenta. */
const ESCALATED = "El agente se pasó de su tope de gasto o de turnos; se reintenta con el perfil escalado y un handoff.";
const STEER_NOTICE = "Una persona que supervisa esta corrida te dejó este mensaje para tu tarea:";
const HANDOFF_NOTICE =
  "La sesión anterior de esta tarea se pasó de su tope de gasto o de turnos y se cerró. Revisa el worktree (git status y git diff --stat): puede tener cambios a medias. Termina tu tarea.";

/**
 * Por qué se reabrió un paso de agente, leído de su `error` (lo único que sobrevive a un corte): con qué aviso
 * arranca el agente y qué sesión retoma. `unfinished` es la que la interrupción dejó sin cerrar, `steer` la del
 * mensaje de la persona y `none` una nueva (sin `resumeFrom` del nodo).
 */
const REOPENED: Record<string, { notice?: string; resume: "unfinished" | "steer" | "none" }> = {
  [RESUMED_AFTER_CUT]: { notice: CUT_NOTICE, resume: "unfinished" },
  [RESUMED_AFTER_PAUSE]: { notice: PAUSE_NOTICE, resume: "unfinished" },
  [STEERED]: { resume: "steer" },
  [ESCALATED]: { notice: HANDOFF_NOTICE, resume: "none" },
  [RETRIED]: { resume: "none" },
};
/** Prefijo de la opción de un `needs_human` que sigue el edge de un outcome sin ejecutar el paso: `force:ok`. */
const FORCE = "force:";

/** Si una persona puede forzar el outcome del nodo: solo action y wait, nunca un agente (decisión #44). */
function forceable(node: Node): boolean {
  return node.type === "action" || node.type === "wait";
}
/**
 * Sufijo de `retry` y `continue` en una decisión de `needs_human`: antes de seguir, la corrida toma la versión
 * vigente de su perfil en vez de la que fijó al empezar (así un tope por rol que la persona subió vale ya).
 * Es lo único que una opción cambia del pin: los roles y los flujos siguen en su versión.
 */
const LATEST_PROFILE = ":latest-profile";
export const TICK_MS = 5000;
export const DEFAULT_MAX_AGENTS = 4;
/** Cada cuánto se sondea un wait con `probe`; Watch avisa antes con `signal`, así que el sondeo es la red de seguridad. */
export const DEFAULT_PROBE_EVERY_SEC = 60;
/** Cuánto se espera antes de reintentar un paso frenado por el entorno (login vencido, cuota agotada). */
const ENVIRONMENT_BACKOFF_MS = 60_000;

const DEFAULT_ACTION_RETRY: RetryPolicy = { max: 3, backoffSec: [10, 60, 300] };
const DEFAULT_AGENT_RETRY: RetryPolicy = { max: 1, backoffSec: [10] };

/** Los estados en que una corrida sigue viva: los mismos del índice parcial de `runs`. */
const LIVE_RUN_STATUSES = ["queued", "running", "waiting", "parked", "paused"] as const;
/** Una corrida pausada no despacha pasos nuevos, pero sus waits y sus hijas siguen cerrándose: lo que pasó mientras tanto no se pierde. */
const ADVANCING_RUN_STATUSES = ["running", "paused"] as const;

type RunRow = typeof runs.$inferSelect;
type StepRow = typeof stepRuns.$inferSelect;
type FlowNode = Extract<Node, { type: "flow" }>;
type GateNode = Extract<Node, { type: "gate" }>;

export interface StartOptions {
  projectId?: ProjectId;
  /** Para resolver el flujo y los roles con scope `repo`. */
  repoId?: RepoId;
  /** Slug del perfil. Obligatorio si el flujo tiene pasos agent. */
  profile?: string;
  /** Quién la lanzó, para `run.started`; por defecto el core (un trigger, el Scheduler). */
  by?: Origin;
}

export interface StepView {
  id: StepRunId;
  nodeId: string;
  visit: number;
  round: number;
  attempt: number;
  status: StepRow["status"];
  outcome: string | null;
  outputHash: ArtifactHash | null;
  error: string | null;
  /** Backoff pendiente: no se despacha antes. */
  notBefore: number | null;
  /** Un wait: qué espera (`WaitDef.key`). */
  waitKey: string | null;
  /** Un wait con `timeoutSec`: desde cuándo vence con outcome `timeout`. */
  deadline: number | null;
  costMicros: number;
  startedAt: number | null;
  endedAt: number | null;
}

export interface RunView {
  id: RunId;
  projectId: ProjectId | null;
  /** La corrida que la lanzó con un nodo `flow`; `null` en una corrida raíz. */
  parentRunId: RunId | null;
  /** La corrida de dev estacionada que le prestó su sujeto a esta (de mantenimiento); `null` si no es un préstamo. */
  borrowedFromRunId: RunId | null;
  flow: { slug: string; version: number };
  subject: SubjectRef;
  lane: RunRow["lane"];
  status: RunRow["status"];
  parkReason: RunRow["parkReason"];
  /** `done`, `blocked` o `failed` cuando la corrida terminó; `null` si se canceló. */
  outcome: string | null;
  params: Record<string, unknown>;
  /** Contador → veces que se tomó. */
  rounds: Record<string, number>;
  costMicros: number;
  startedAt: number;
  endedAt: number | null;
  /** En el orden en que se crearon. */
  steps: StepView[];
  /** El flujo en la versión que fijó la corrida. */
  flowDef: FlowDef;
  workspace: RunWorkspace | null;
  usage: RunUsage;
}

/** La corrida sin lo que solo trae `getRun`. */
export type RunSummary = Omit<RunView, "steps" | "flowDef" | "workspace" | "usage">;

/** Lo que el motor sabe de un paso agent al armarle el brief. */
export interface StepBriefRequest {
  run: Brief["run"];
  nodeId: string;
  /** Cuántas veces entró la corrida a este nodo, desde 1. */
  visit: number;
  mode: string;
  /** El slug del rol del nodo y el proyecto de la corrida: con el repo del worktree, deciden qué learnings entran. */
  role: string;
  /** El modo propone learnings (`RoleMode.learnings`): su brief lleva también los propuestos pendientes. */
  proposesLearnings: boolean;
  projectId?: ProjectId;
  /** El brief del nodo con sus refs resueltas. */
  payload: unknown;
  /** La corrida y sus padres: el worktree y los reportes previos pueden ser de cualquiera. */
  lineage: RunId[];
}

export interface EngineDeps extends SubjectsDeps {
  store: Store;
  defs: Defs;
  agents: Agents;
  artifacts: Artifacts;
  actions: ReadonlyMap<string, ActionDef>;
  consolidators: ReadonlyMap<string, ConsolidatorDef>;
  waits: ReadonlyMap<string, WaitDef>;
  /**
   * El worktree de la corrida (el que tiene tomado), donde corren sus agentes. Con `workspaceId` y
   * `fencingToken`, un `$nodo` que lo nombra (el output de `workspace.acquire`) lleva siempre el token vigente: un
   * préstamo del sujeto lo sube y la dueña, al retomar, no puede seguir con el que tomó antes.
   */
  workspaceOf?: (runId: RunId) => { path: string; base: string; repoId?: RepoId; workspaceId?: string; fencingToken?: number } | undefined;
  /**
   * Arma el brief de un paso agent: deja en el worktree lo que el agente lee (`.clanker-run/`) y lo cita en
   * el brief. Sin esto el brief lleva solo el payload del nodo.
   */
  briefFor?: (request: StepBriefRequest) => Promise<Brief>;
  /**
   * Los circuit breakers por causa (`docs/design.html#d-ops`) y el runtime de cada agente (su ámbito es
   * `runtime:<id>`). Un paso cuyo ámbito está abierto no se despacha; un error de entorno abre el de su causa.
   * `runtimeOf` dice qué runtime corre una entrada de perfil que pide `requested` (`ProfileRole.runtime`).
   */
  environment?: { breakers: Pick<Breakers, "openReason" | "trip">; runtimeOf(requested: AgentRuntimeId | undefined): string };
  /** Tope global de agentes a la vez. */
  maxAgents?: number;
  tickMs?: number;
  /** Cada cuánto se sondea un wait con `probe`; por defecto `DEFAULT_PROBE_EVERY_SEC`. */
  probeEverySec?: number;
  /** Identifica a este core como dueño de los leases. */
  bootId?: string;
  /** Al despertar de un sleep, además de los leases de los pasos: extender los de lo que este core mantiene fuera del motor. */
  onClockJump?: () => void;
  /** Donde queda lo que falla en un despertar del dispatcher (`flows.dispatch`); sin él, el que crea con el store. */
  errors?: ErrorReporter;
  now?: () => number;
}

export interface Engine {
  /**
   * Lanza `flow` (slug) sobre `subject`. Idempotente: si ya hay una corrida viva de ese flujo sobre
   * ese sujeto devuelve su id sin mirar `params`. La corrida fija la versión del flujo, de sus roles
   * y del perfil, y también los de los subflujos que llama (nodo `flow`). Falla, sin crear nada, si faltan
   * params, los maxRounds apuntan a un valor inválido o el flujo (o un subflujo) tiene un gate como rama de un parallel.
   */
  start(flow: string, subject: SubjectRef, params?: Record<string, unknown>, opts?: StartOptions): RunId;
  /**
   * Entrega un hecho externo a los waits que esperan: cada uno cuyo `match` lo reconoce termina con
   * el outcome que devuelve. Los waits que no calzan siguen esperando.
   */
  signal(event: ExternalEvent): void;
  /** Las claves (`WaitDef.key`) de los waits que esperan ahora en corridas activas: qué mira Watch con más cuidado. */
  waitKeys(): string[];
  /**
   * Resuelve la decisión que tiene estacionada a una corrida. Un gate se cierra con la opción como
   * outcome del paso. En un `needs_human` la opción es `retry` (el nodo vuelve a correr como una visita
   * nueva), `force:<outcome>` (sigue el edge de ese outcome sin ejecutar el paso) o `cancel`; en un
   * tope de la corrida, `continue` (el tope se suma otra vez) o `cancel`. `retry:latest-profile` y
   * `continue:latest-profile` (si la corrida fijó un perfil) hacen lo mismo y antes pasan la corrida a la
   * versión vigente de ese perfil, sin cancelarla: la corrida fija las versiones al empezar y esta es la
   * forma de soltar un tope por rol que la persona subió. La corrida vuelve a la cola
   * de su carril, antes que las corridas nuevas, y emite `run.requeued`. Lanza `DecisionNotFoundError`
   * si no existe y `DecisionResolveError` si ya se resolvió o la opción no es una de las suyas.
   */
  resolveGate(decisionId: DecisionId, option: string, by: Origin): void;
  /**
   * Lo que una persona le pide a una corrida (`by` queda en los eventos). Lanza `RunNotFoundError` si no existe y
   * `RunCommandError` si el estado de la corrida no lo permite.
   *
   * - `cancel`: cancela la corrida y todas sus corridas hijas: los pasos pending, running, waiting y las
   *   decisiones que las estacionan quedan `canceled` o `superseded`, los agentes en curso se interrumpen y las
   *   acciones reciben el abort de su `signal`. Cada corrida emite `run.finished` con outcome `canceled`. No hace
   *   nada con una corrida que ya terminó.
   * - `pause`: la corrida y sus hijas que corren pasan a `paused` (siguen ocupando su cupo y su sujeto): no se
   *   despachan pasos nuevos y los agentes en curso terminan lo suyo. Con `now` se interrumpen y su paso vuelve a
   *   pending con la sesión lista para retomarse, sin gastar intento. Pausar una corrida ya pausada con `now`
   *   interrumpe a los agentes que sigan. Solo se pausa lo que corre: una corrida estacionada ya espera a una persona.
   * - `resume`: las pausadas vuelven a `running`; en una corrida que ya corre no hace nada.
   */
  control(runId: RunId, cmd: "pause" | "resume" | "cancel", by: Origin, opts?: { now?: boolean }): void;
  /**
   * Un comando sobre un paso de una corrida viva, y la corrida a la que pertenece. Lanza `StepNotFoundError` si el
   * paso no existe y `RunCommandError` si no se puede en su estado (los mensajes dicen qué hacer).
   *
   * - `retry`: el nodo vuelve a correr como una visita nueva con sesión nueva y todo lo que la corrida tenía en
   *   marcha (el paso en curso, sus ramas, las corridas hijas) se cancela: "reintentar desde acá". Sobre el paso
   *   que está en espera de backoff solo lo despacha ya. No sirve sobre una rama de un parallel (se reintenta el parallel).
   * - `steer`: solo agentes. Le deja un mensaje y retoma su sesión con él: si el paso está en curso lo interrumpe, si
   *   está pending lo marca, y si es el paso en que la corrida espera una decisión `needs_human`, la reemplaza por una
   *   visita nueva que retoma la última sesión del paso.
   * - `force`: solo pasos `action` y `wait` (decisión #44, nunca un agente): sigue el edge de `force` sin ejecutar
   *   (o sin terminar de esperar) el paso. Es lo mismo que la opción `force:<outcome>` de un `needs_human`.
   */
  stepCommand(stepId: StepRunId, cmd: { retry: true } | { steer: string } | { force: string }, by: Origin): RunId;
  /**
   * Admite las corridas que esperan sujeto o cupo (primero las del carril de mantenimiento, luego las
   * más antiguas) y despacha lo que haya quedado listo. Lo llaman las transiciones y un timer de 5 s;
   * el Scheduler lo llama antes de repartir los cupos libres entre las issues nuevas.
   */
  wake(): void;
  /** Lanza `RunNotFoundError` si no existe. */
  getRun(runId: RunId): RunView;
  /** Las corridas más recientes primero, sin sus pasos. */
  listRuns(filter?: { projectId?: ProjectId; status?: readonly RunRow["status"][] }): RunSummary[];
  /**
   * Al bootear, antes de aceptar trabajo y con los módulos que registran acciones y waits ya cargados:
   * reabre los pasos que un corte dejó `leased` o `running` (los lease de otro boot, sea cual sea su
   * vencimiento: este core tiene el lock y el anterior ya murió), da error al que lleva
   * `MAX_CUTS` cortes y despierta al dispatcher. Los waits quedan esperando y el primer tick los
   * sondea (el calendario de sondeos vive en memoria), así que lo que pasó con la app cerrada no se
   * pierde. Un gate no necesita nada: su corrida sigue parked con la decisión abierta, y su plazo lo vence el tick. Devuelve cuántos pasos tocó.
   */
  recover(): number;
  /**
   * Deja de despachar y espera a los pasos en curso. Sin `graceMs` solo espera. Con `graceMs` es el
   * apagado del core: interrumpe de inmediato a los agentes, da hasta `graceMs` a las acciones y
   * después aborta lo que quede. Cada paso cortado vuelve a `pending` sin gastar intento, con su sesión
   * lista para retomarse, igual que tras un crash pero sin contar como corte. Resuelve cuando ya no
   * queda nada en vuelo.
   */
  close(opts?: { graceMs: number }): Promise<void>;
}

/** `start` rechazó el pedido (flujo o perfil que no existen, params inválidos): no se creó nada y el mensaje dice qué cambiar. */
export class RunStartError extends BadRequestError {}

/** La decisión pedida no existe. */
export class DecisionNotFoundError extends NotFoundError {
  constructor(id: DecisionId) {
    super(`No existe la decisión ${id}.`);
  }
}

/** La decisión no se puede resolver así (ya se resolvió, no estaciona a nadie o la opción no es suya): no cambió nada. */
export class DecisionResolveError extends BadRequestError {}

export { OUTPUT_INLINE_MAX_BYTES, RunNotFoundError };

/** El comando no se puede aplicar a la corrida o al paso en su estado actual: no cambió nada y el mensaje dice qué hacer. */
export class RunCommandError extends BadRequestError {}

/** El `reason` del abort de los pasos de una corrida cancelada. */
class RunCanceled extends Error {
  constructor(runId: RunId) {
    super(`La corrida ${runId} se canceló.`);
  }
}

/** El `reason` del abort de un paso que una persona reemplazó (`retry`) o cerró a mano (`force`): su cierre tardío se descarta. */
class StepSuperseded extends Error {
  constructor(stepId: StepRunId) {
    super(`El paso ${stepId} lo reemplazó una persona.`);
  }
}

/**
 * El `reason` del abort de un paso en vuelo que no falló: el core se apaga, la corrida se pausa con `now` o una
 * persona le deja un mensaje. El paso vuelve a pending, sin gastar intento, y su sesión se retoma. `at` es el
 * instante de la interrupción: la sesión que terminó después es la que cortó.
 */
class Interruption extends Error {
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
class StaleStepError extends Error {}

/** Cómo terminó una ejecución, antes de decidir qué hace el motor con ella. */
type Settled =
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
interface Reported {
  notes: { title: string; body: string }[];
  learnings: string[];
}

interface Job {
  run: RunRow;
  /** Con el attempt de este lease. */
  step: StepRow;
  flow: FlowDef;
  node: Node;
  /** Si el paso es una rama de un parallel o su rol consolidador: el id del parallel. */
  parallel?: { parent: string; role: "branch" | "join" };
}

/** Qué hacer con el parallel al cerrar un paso suyo. */
type JoinPlan =
  /** Quedan ramas corriendo. */
  | { kind: "wait" }
  /** El join es un rol: falta su paso de agente. */
  | { kind: "agent" }
  /** El parallel termina con este outcome. */
  | { kind: "done"; outcome: string; outputHash?: ArtifactHash; error?: string };

/** Cómo quedó una rama, o cómo quedará con el cierre que se está planeando. */
interface BranchState {
  /** El id de la rama; en un forEach, su posición. */
  key: string;
  stepId: StepRunId;
  status: StepRow["status"];
  outcome: string | null;
  outputHash: ArtifactHash | null;
  error: string | null;
}

/** El `scope` del evento `error` cuando falla un despertar del dispatcher. */
const DISPATCH_SCOPE = "flows.dispatch";

export function createEngine(deps: EngineDeps): Engine {
  const { store, defs, agents, artifacts, actions, consolidators, waits, workspaceOf, briefFor, environment, now = Date.now } = deps;
  const maxAgents = deps.maxAgents ?? DEFAULT_MAX_AGENTS;
  const probeEveryMs = (deps.probeEverySec ?? DEFAULT_PROBE_EVERY_SEC) * 1000;
  const bootId = deps.bootId ?? newId("boot");
  const errors = deps.errors ?? createErrorReporter(store);
  const { flowOf, workspaceFor, lineage, resolveRef, selectStep, readArtifact, parallelStepOf, itemsOf, latestStep, getRun, listRuns } =
    createRunReads({ store, defs, artifacts, workspaceOf });
  const inFlight = new Set<Promise<void>>();
  /** Cuándo toca el próximo sondeo de cada wait de este proceso. Sin entrada (tras un reinicio), toca ya. */
  const nextProbeAt = new Map<StepRunId, number>();
  /** El abort de cada paso que este proceso ejecuta, para que `cancel` lo interrumpa. */
  const controllers = new Map<StepRunId, AbortController>();
  const agentSteps = new Set<StepRunId>();
  const probing = new Set<StepRunId>();
  const subjects = createSubjects(deps);
  let activeAgents = 0;
  let lastWakeAt = now();
  let ticker: NodeJS.Timeout | undefined;
  let closed = false;

  const scopeOf = (run: RunRow, stepRunId?: StepRunId) => ({
    projectId: run.projectId ?? undefined,
    runId: run.id,
    stepRunId,
    subject: { type: run.subjectType, id: run.subjectId },
  });

  // --- start -----------------------------------------------------------------------------------

  function start(flowSlug: string, subject: SubjectRef, given: Record<string, unknown> = {}, opts: StartOptions = {}): RunId {
    const id = store.tx((tx) => {
      const def = defs.resolve("flow", flowSlug, { repoId: opts.repoId });
      if (!def) throw new RunStartError(`No existe el flujo "${flowSlug}".`);
      const live = tx.db
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.flowDefId, def.id),
            eq(runs.subjectType, subject.type),
            eq(runs.subjectId, subject.id),
            isNull(runs.parentRunId),
            inArray(runs.status, LIVE_RUN_STATUSES),
          ),
        )
        .get();
      if (live) return live.id;

      const flow = FlowDef.parse(def.body);
      const { flows, subflows } = pinCalls(flow, opts.repoId);
      // Un gate estaciona la corrida entera: una rama de un parallel no podría esperar sola.
      const gateBranches = flows.flatMap((f) =>
        Object.entries(f.nodes).flatMap(([nodeId, n]) => {
          if (n.type !== "parallel") return [];
          const branches: [string, Node | undefined][] = Array.isArray(n.branches)
            ? n.branches.map((id) => [id, f.nodes[id]])
            : [[`${nodeId}.branch`, n.branches.branch]];
          return branches.filter(([, branch]) => branch?.type === "gate").map(([id]) => `${f === flow ? "" : `${f.id}.`}${id}`);
        }),
      );
      if (gateBranches.length > 0) {
        throw new RunStartError(
          `El flujo "${flowSlug}" usa un gate como rama de un parallel: ${gateBranches.join(", ")}. Un gate estaciona su corrida entera; ponlo como nodo suelto.`,
        );
      }
      const params = paramsFor(flow, given);

      const roles: Record<string, DefPin> = {};
      for (const slug of flows.flatMap(agentRolesOf)) {
        if (roles[slug]) continue;
        const role = defs.resolve("role", slug, { repoId: opts.repoId });
        if (!role) throw new RunStartError(`El flujo "${flowSlug}" usa el rol "${slug}", que no existe.`);
        roles[slug] = { id: role.id, version: role.version };
      }
      let profile: DefPin | undefined;
      if (opts.profile !== undefined) {
        const found = defs.resolve("profile", opts.profile, { repoId: opts.repoId });
        if (!found) throw new RunStartError(`No existe el perfil "${opts.profile}".`);
        profile = { id: found.id, version: found.version };
      } else if (Object.keys(roles).length > 0) {
        throw new RunStartError(`El flujo "${flowSlug}" tiene pasos agent: pasa el perfil con que corre.`);
      }

      return insertRun(tx, {
        projectId: opts.projectId,
        subject,
        def,
        flow,
        params,
        roles,
        subflows,
        profile,
        lane: flow.lane ?? LANE_BY_TRIGGER[flow.trigger.type] ?? "dev",
        writes: flow.effects !== "local",
        by: opts.by,
      }).id;
    });
    wake();
    return id;
  }

  /** Los defaults del flujo pisados por lo que pasa quien lo lanza. Un param sin default es obligatorio. */
  function effectiveParams(flow: FlowDef, given: Record<string, unknown>): Record<string, unknown> {
    const declared = flow.params ?? {};
    const unknown = Object.keys(given).filter((name) => !Object.hasOwn(declared, name));
    if (unknown.length > 0) {
      throw new RunStartError(`El flujo "${flow.id}" no declara los params: ${unknown.join(", ")}.`);
    }
    const params: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(declared)) {
      if (Object.hasOwn(given, name)) params[name] = given[name];
      else if (typeof spec === "object") params[name] = spec.default;
      else throw new RunStartError(`Falta el param "${name}" del flujo "${flow.id}".`);
    }
    return params;
  }

  /** `effectiveParams` y, además, que cada `maxRounds` que apunta a un param valga un entero positivo. */
  function paramsFor(flow: FlowDef, given: Record<string, unknown>): Record<string, unknown> {
    const params = effectiveParams(flow, given);
    try {
      for (const node of Object.values(flow.nodes)) {
        for (const edge of edgesOf(node)) maxRoundsOf(edge, params);
      }
    } catch (error) {
      throw new RunStartError(messageOf(error), { cause: error });
    }
    return params;
  }

  /**
   * El flujo y los subflujos que llama, también los de sus subflujos: lo que la corrida fija al
   * empezar. Así una corrida hija parte de las versiones del padre aunque el flujo cambie después.
   */
  function pinCalls(root: FlowDef, repoId: RepoId | undefined): { flows: FlowDef[]; subflows: Record<string, DefPin> } {
    const flows = [root];
    const subflows: Record<string, DefPin> = {};
    for (const flow of flows) {
      for (const slug of calledFlows(flow)) {
        if (subflows[slug]) continue;
        const def = defs.resolve("flow", slug, { repoId });
        if (!def) throw new RunStartError(`El flujo "${flow.id}" llama al subflujo "${slug}", que no existe.`);
        subflows[slug] = { id: def.id, version: def.version };
        flows.push(FlowDef.parse(def.body));
      }
    }
    return { flows, subflows };
  }

  /**
   * Crea la corrida con su primer paso en pending y emite `run.started`. Si otra corrida es la dueña de
   * su sujeto, queda `queued` (el dispatcher no la toma) o, si la dueña es de dev y está estacionada y
   * esta es de mantenimiento, corre con el sujeto prestado.
   */
  function insertRun(
    tx: Tx,
    n: {
      projectId: ProjectId | null | undefined;
      subject: SubjectRef;
      def: { id: string; slug: string; version: number };
      flow: FlowDef;
      params: Record<string, unknown>;
      roles: Record<string, DefPin>;
      subflows: Record<string, DefPin>;
      profile: DefPin | undefined;
      lane: RunRow["lane"];
      writes: boolean;
      parent?: { runId: RunId; stepRunId: StepRunId; stopBefore: string | undefined };
      by?: Origin;
    },
  ): RunRow {
    const admission = subjects.admit(tx.db, {
      subjectType: n.subject.type,
      subjectId: n.subject.id,
      lane: n.lane,
      writes: n.writes,
      parentRunId: n.parent?.runId ?? null,
      projectId: n.projectId ?? null,
    });
    const run = tx.db
      .insert(runs)
      .values({
        id: newId("run"),
        projectId: n.projectId,
        subjectType: n.subject.type,
        subjectId: n.subject.id,
        flowDefId: n.def.id,
        flowVersion: n.def.version,
        profileDefId: n.profile?.id,
        profileVersion: n.profile?.version,
        roles: n.roles,
        subflows: n.subflows,
        parentRunId: n.parent?.runId,
        parentStepRunId: n.parent?.stepRunId,
        stopBefore: n.parent?.stopBefore,
        lane: n.lane,
        status: admission.status,
        borrowedFromRunId: "lender" in admission ? admission.lender.id : undefined,
        writes: n.writes,
        params: n.params,
        rounds: {},
        startedAt: now(),
      })
      .returning()
      .get();
    insertStep(tx, run, n.flow.start, { visit: 1, round: 0 });
    tx.emit({
      type: "run.started",
      origin: n.by ?? "core",
      ...scopeOf(run),
      payload: {
        runId: run.id,
        flow: `${n.def.slug}@${n.def.version}`,
        subject: n.subject,
        lane: run.lane,
        ...(n.parent && { parentRunId: n.parent.runId }),
      },
    });
    if ("lender" in admission) subjects.lend(tx, run, admission.lender);
    return run;
  }

  function insertStep(
    tx: Tx,
    run: RunRow,
    nodeId: string,
    at: { visit: number; round: number; prev?: StepRunId; /** Lo que `performAgent` lee para saber cómo retomarlo. */ error?: string },
  ): StepRunId {
    const id = newId("stp");
    tx.db
      .insert(stepRuns)
      .values({
        id,
        runId: run.id,
        nodeId,
        visit: at.visit,
        round: at.round,
        status: "pending",
        prevStepRunId: at.prev,
        error: at.error,
      })
      .run();
    return id;
  }

  // --- dispatcher ------------------------------------------------------------------------------

  function jobOf(run: RunRow, step: StepRow): Job {
    const flow = flowOf(run);
    const target = stepNode(flow, step.nodeId);
    const parallel = target.kind === "plain" ? undefined : { parent: target.parent, role: target.kind };
    return { run, step, flow, node: target.node, parallel };
  }

  /** El `Job` del paso. Si su flujo o su nodo ya no se pueden cargar, el paso falla, solo su corrida queda parked y devuelve `undefined`. */
  function loadJob(run: RunRow, step: StepRow): Job | undefined {
    try {
      return jobOf(run, step);
    } catch (error) {
      parkUnloadable(run, step, messageOf(error));
      return undefined;
    }
  }

  /** Despierta al dispatcher: lo llaman cada transición y el tick de 5 s (backoff vencido, timeouts y sondeos de waits). */
  function wake(): void {
    if (closed) return;
    ticker ??= setInterval(wake, deps.tickMs ?? TICK_MS).unref();
    try {
      const t = now();
      // Antes de reconciliar nada: dormir no es perder el lease.
      if (t - lastWakeAt > CLOCK_JUMP_MS) extendOwnLeases(t);
      lastWakeAt = t;
      // Antes de despachar: un wait que vence o se resuelve deja su paso siguiente listo en esta misma vuelta.
      sweepWaits();
      sweepGates();
      sweepChildren();
      // Una dueña que se estacionó o terminó puede dejar libre (o prestable) el sujeto de una corrida que espera, y una que terminó o se estacionó deja un cupo.
      if (hasWaiting(store.db)) store.tx((tx) => subjects.promoteQueued(tx));
      dispatch();
      errors.clear(DISPATCH_SCOPE);
    } catch (error) {
      // Un wake que lanza tumbaría a quien lo llamó (un `start`, el cierre de otro paso, un timer).
      errors.report(DISPATCH_SCOPE, error);
    }
  }

  function extendOwnLeases(t: number): void {
    store.tx((tx) =>
      tx.db
        .update(stepRuns)
        .set({ leaseUntil: t + STEP_LEASE_TTL_MS })
        .where(and(eq(stepRuns.owner, bootId), inArray(stepRuns.status, ["leased", "running"])))
        .run(),
    );
    deps.onClockJump?.();
  }

  /** Toma los pasos pending listos: primero los del carril de mantenimiento, luego las corridas más antiguas. */
  function dispatch(): void {
    const ready = store.db
      .select({ step: stepRuns, run: runs })
      .from(stepRuns)
      .innerJoin(runs, eq(stepRuns.runId, runs.id))
      .where(
        and(
          eq(stepRuns.status, "pending"),
          eq(runs.status, "running"),
          or(isNull(stepRuns.notBefore), lte(stepRuns.notBefore, now())),
        ),
      )
      .orderBy(desc(sql`${runs.lane} = 'maintenance'`), asc(runs.id), asc(stepRuns.id))
      .all();

    for (const { step, run } of ready) {
      const planned = loadJob(run, step);
      if (!planned) continue;
      // Pausado por un breaker: sigue pending, sin gastar intento, hasta que el breaker se cierre.
      if (pausedBy(planned) !== undefined) continue;
      if (parkOverLimit(planned)) continue;
      const isAgent = planned.node.type === "agent";
      if (isAgent && activeAgents >= maxAgents) continue;
      const leased = lease(step);
      if (!leased) continue;
      if (isAgent) activeAgents++;
      const job = runWithLease({ ...planned, step: leased }).finally(() => {
        if (isAgent) activeAgents--;
        inFlight.delete(job);
        wake();
      });
      inFlight.add(job);
    }
  }

  /**
   * Los ámbitos de breaker de los que depende un paso: un agente, de su runtime y del entorno de su repo; una
   * acción que corre la receta, del entorno de su repo; una que publica, de GitHub. Los waits, gates y
   * subflujos no dependen de ninguno (Watch sigue contando).
   */
  function scopesOf(run: RunRow, node: Node): string[] {
    if (!environment) return [];
    const scopes: string[] = [];
    const repoId = workspaceFor(run)?.repoId;
    if (node.type === "agent") scopes.push(runtimeScope(runtimeOfNode(run, node)));
    if (repoId !== undefined && (node.type === "agent" || (node.type === "action" && actions.get(node.action)?.needsRepoEnv))) {
      scopes.push(repoScope(repoId));
    }
    if (node.type === "action" && actions.get(node.action)?.effects === "remote") scopes.push(GITHUB_SCOPE);
    return scopes;
  }

  /**
   * El runtime que correrá un nodo agente: el de su entrada del perfil fijado por la corrida (`profileRole` o el rol).
   * Un paso escalado usa la entrada de escalada; si su runtime es otro, su breaker lo abre el resultado del paso.
   */
  function runtimeOfNode(run: RunRow, node: Extract<Node, { type: "agent" }>): string {
    const body = run.profileDefId !== null && run.profileVersion !== null ? defs.get("profile", run.profileDefId, run.profileVersion)?.body : undefined;
    const profile = Profile.safeParse(body);
    const entry = profile.success ? profile.data.roles[node.profileRole ?? node.role] : undefined;
    return environment?.runtimeOf(entry?.runtime) ?? "";
  }

  /** El ámbito abierto que pausa a este paso, o `undefined`. */
  function pausedBy({ run, node }: Job): string | undefined {
    return scopesOf(run, node).find((scope) => environment?.breakers.openReason(scope) !== undefined);
  }

  /** El paso (pending, en un wait o a medias por un corte) no se pudo cargar: falla sin correr y su corrida queda parked. */
  function parkUnloadable(run: RunRow, step: StepRow, error: string): void {
    try {
      store.tx((tx) => {
        const failed = tx.db
          .update(stepRuns)
          .set({ status: "failed", outcome: "error", error, notBefore: null })
          .where(and(eq(stepRuns.id, step.id), inArray(stepRuns.status, ["pending", "waiting", "leased", "running"])))
          .returning({ id: stepRuns.id })
          .get();
        if (!failed) return;
        tx.emit({
          type: "step.finished",
          origin: "core",
          ...scopeOf(run, step.id),
          payload: { ...stepPayload(step), outcome: "error", outputHash: null, costMicros: 0, error },
        });
        parkForHuman(tx, run, step, undefined, error);
      });
    } catch (cause) {
      console.error(`No se pudo estacionar la corrida ${run.id}, que no se puede cargar (${error}):`, cause);
    }
  }

  // --- estacionar ------------------------------------------------------------------------------

  /**
   * Estaciona la corrida y abre la decisión que la espera, en la transacción de quien la estaciona. Un
   * paso a la vez avanza una corrida, así que no hay otra decisión bloqueante abierta sobre ella.
   */
  function park(
    tx: Tx,
    run: RunRow,
    step: StepRow,
    parking: { reason: ParkReason; kind: "gate" | "needs_human"; title: string; body: string; options: string[] },
  ): void {
    tx.db.update(runs).set({ status: "parked", parkReason: parking.reason }).where(eq(runs.id, run.id)).run();
    const { reason, ...decision } = parking;
    const opened = openDecision(tx, { ...scopeOf(run, step.id), ...decision });
    tx.emit({ type: "run.parked", origin: "core", ...scopeOf(run, step.id), payload: { reason, decisionId: opened.id } });
  }

  /** El paso `step` terminó sin un edge que lo lleve a ningún lado: la corrida espera a una persona. Sin `node` (no se pudo cargar) solo se puede reintentar o cancelar. */
  function parkForHuman(tx: Tx, run: RunRow, step: StepRow, node: Node | undefined, message: string): void {
    // Solo action y wait se fuerzan (decisión #44, igual que `forceStep`): el resultado de un agente nunca lo pone una persona.
    const forced = node !== undefined && forceable(node) ? Object.keys(node.on ?? {}).map((outcome) => `${FORCE}${outcome}`) : [];
    park(tx, run, step, {
      reason: "needs_human",
      kind: "needs_human",
      title: `El paso "${step.nodeId}" no puede seguir`,
      body: message,
      options: ["retry", ...(run.profileDefId === null ? [] : [`retry${LATEST_PROFILE}`]), ...forced, "cancel"],
    });
  }

  /**
   * Si la corrida ya llegó a su tope de gasto o de pasos, la estaciona (`limit`) y el paso listo queda
   * pending: al resolverse la decisión corre ese paso. Es solo esa corrida: el resto sigue.
   */
  function parkOverLimit({ run, step, flow }: Job): boolean {
    const exceeded = limitExceeded(run, step, flow);
    if (exceeded === undefined) return false;
    try {
      store.tx((tx) => {
        const current = tx.db.select().from(runs).where(eq(runs.id, run.id)).get();
        // Dos pasos listos de la misma corrida en una vuelta del dispatcher: solo el primero la estaciona.
        if (current?.status !== "running") return;
        park(tx, current, step, {
          reason: "limit",
          kind: "needs_human",
          title: "La corrida llegó a su tope",
          body: `${exceeded} Continuar le suma otra vez el tope; cancelar la termina.`,
          options: ["continue", ...(run.profileDefId === null ? [] : [`continue${LATEST_PROFILE}`]), "cancel"],
        });
      });
    } catch (error) {
      console.error(`No se pudo estacionar la corrida ${run.id}, que llegó a su tope:`, error);
    }
    return true;
  }

  /**
   * Qué tope de la corrida se pasó, o `undefined`. El tope de gasto del proyecto manda sobre el del
   * flujo. Cada `continue` ya resuelto suma otra vez el tope entero. `step` no cuenta en `maxSteps`: es el que va a correr.
   */
  function limitExceeded(run: RunRow, step: StepRow, flow: FlowDef): string | undefined {
    const project = run.projectId === null ? undefined : store.db.select({ cap: projects.maxCostUsd }).from(projects).where(eq(projects.id, run.projectId)).get();
    const maxCostUsd = project?.cap ?? flow.limits?.maxCostUsd ?? null;
    const maxSteps = flow.limits?.maxSteps;
    if (maxCostUsd === null && maxSteps === undefined) return undefined;
    const steps =
      maxSteps === undefined
        ? 0
        : store.db.select({ n: count() }).from(stepRuns).where(and(eq(stepRuns.runId, run.id), ne(stepRuns.id, step.id))).get()?.n ?? 0;
    const over = (times: number) => {
      if (maxCostUsd !== null && run.costMicros > usdToMicros(maxCostUsd * times)) {
        return `Lleva gastados USD ${microsToUsd(run.costMicros).toFixed(2)} y su tope es USD ${maxCostUsd * times}.`;
      }
      if (maxSteps !== undefined && steps >= maxSteps * times) return `Lleva ${steps} pasos y su tope es ${maxSteps * times}.`;
    };
    if (over(1) === undefined) return undefined;
    const continued =
      store.db
        .select({ n: count() })
        .from(decisions)
        .where(and(eq(decisions.runId, run.id), eq(decisions.kind, "needs_human"), sql`json_extract(${decisions.resolution}, '$.option') IN ('continue', ${`continue${LATEST_PROFILE}`})`))
        .get()?.n ?? 0;
    return over(1 + continued);
  }

  function lease(step: StepRow): StepRow | undefined {
    return store.tx((tx) =>
      tx.db
        .update(stepRuns)
        .set({
          status: "leased",
          owner: bootId,
          attempt: sql`${stepRuns.attempt} + 1`,
          leaseUntil: now() + STEP_LEASE_TTL_MS,
        })
        .where(and(eq(stepRuns.id, step.id), eq(stepRuns.status, "pending")))
        .returning()
        .get(),
    );
  }

  async function runWithLease(job: Job): Promise<void> {
    const controller = new AbortController();
    controllers.set(job.step.id, controller);
    if (job.node.type === "agent") agentSteps.add(job.step.id);
    // Un timer no lanza: si el latido falla o el lease ya es de otro attempt, se interrumpe el paso en
    // vez de dejarlo corriendo sin lease (un agente de un intento anterior no puede seguir escribiendo).
    const renew = setInterval(() => {
      try {
        const renewed = store.tx((tx) =>
          tx.db
            .update(stepRuns)
            .set({ leaseUntil: now() + STEP_LEASE_TTL_MS })
            .where(and(eq(stepRuns.id, job.step.id), eq(stepRuns.attempt, job.step.attempt), inArray(stepRuns.status, ["leased", "running"])))
            .returning({ id: stepRuns.id })
            .get(),
        );
        if (!renewed) controller.abort(new StaleStepError(job.step.id));
      } catch (error) {
        controller.abort(error);
      }
    }, STEP_LEASE_TTL_MS / 3).unref();
    try {
      let settled: Settled;
      try {
        settled = await dispatchNode(job, controller);
      } catch (error) {
        if (error instanceof StaleStepError) throw error;
        settled = { kind: "failed", error: messageOf(error) };
      }
      const { reason } = controller.signal;
      if (settled.kind === "failed" && reason instanceof Interruption) reopenInterrupted(job, reason);
      else if (settled.kind !== "waiting") settle(job, settled);
    } catch (error) {
      if (error instanceof StaleStepError) return;
      console.error(`No se pudo cerrar el paso ${job.step.id} (${job.step.nodeId}):`, error);
      parkAfterFailure(job, messageOf(error));
    } finally {
      clearInterval(renew);
      controllers.delete(job.step.id);
      agentSteps.delete(job.step.id);
    }
  }

  /**
   * Una interrupción (apagado, pausa con `now` o un mensaje) cortó el paso en curso: vuelve a pending como tras un
   * corte, pero sin sumar a `recoveries` (no cuenta para el loop de crash) y sin gastar intento. La sesión
   * que se interrumpió queda marcada para que `performAgent` la retome.
   */
  function reopenInterrupted(job: Job, interruption: Interruption): void {
    store.tx((tx) => {
      const reopened = tx.db
        .update(stepRuns)
        .set({ status: "pending", owner: null, leaseUntil: null, notBefore: null, deferrals: sql`${stepRuns.deferrals} + 1`, error: interruption.marker })
        .where(and(eq(stepRuns.id, job.step.id), eq(stepRuns.attempt, job.step.attempt), inArray(stepRuns.status, ["leased", "running"])))
        .returning({ id: stepRuns.id })
        .get();
      if (!reopened) throw new StaleStepError(job.step.id);
      const interrupted = tx.db
        .select({ id: agentSessions.id })
        .from(agentSessions)
        .where(and(eq(agentSessions.stepRunId, job.step.id), eq(agentSessions.status, "error"), gte(agentSessions.endedAt, interruption.at)))
        .orderBy(desc(agentSessions.id))
        .limit(1)
        .get();
      if (interrupted) tx.db.update(agentSessions).set({ error: SESSION_CUT }).where(eq(agentSessions.id, interrupted.id)).run();
      tx.emit({
        type: "step.retrying",
        origin: "core",
        ...scopeOf(job.run, job.step.id),
        payload: { ...stepPayload(job.step), error: interruption.marker },
      });
    });
  }

  /**
   * Cerrar el paso falló por algo del propio motor (la base, un edge mal formado): sin esto el paso
   * quedaría `running` con su `step.started` sin cierre. Un nodo sin `on` no tiene edge, así que la
   * corrida queda parked en este paso, a la espera de una persona.
   */
  function parkAfterFailure(job: Job, error: string): void {
    try {
      transition({ ...job, node: { ...job.node, on: {} } }, "error", undefined, error);
    } catch (cause) {
      if (!(cause instanceof StaleStepError)) console.error(`Tampoco se pudo estacionar la corrida ${job.run.id}:`, cause);
    }
  }

  // --- recuperación ----------------------------------------------------------------------------

  function recover(): number {
    const orphans = store.db
      .select({ step: stepRuns, run: runs })
      .from(stepRuns)
      .innerJoin(runs, eq(stepRuns.runId, runs.id))
      .where(and(inArray(stepRuns.status, ["leased", "running"]), or(isNull(stepRuns.owner), ne(stepRuns.owner, bootId))))
      .orderBy(asc(stepRuns.id))
      .all();
    for (const { step, run } of orphans) {
      // Como en el dispatcher, un paso que no se puede recuperar estaciona solo su corrida: si lanzara,
      // el arranque fallaría y cada arranque siguiente tropezaría con el mismo paso.
      try {
        recoverStep(run, step);
      } catch (error) {
        console.error(`No se pudo recuperar el paso ${step.id} (${step.nodeId}):`, error);
        parkUnloadable(run, step, messageOf(error));
      }
    }
    wake();
    return orphans.length;
  }

  function recoverStep(run: RunRow, step: StepRow): void {
    const cuts = step.recoveries + 1;
    if (cuts >= MAX_CUTS) {
      store.tx((tx) => closeCutSessions(tx, run, step));
      const job = loadJob(run, step);
      if (job) {
        transition(job, "error", undefined, `La app se cortó ${cuts} veces con este paso en curso: se da por fallado para no entrar en un loop de crash.`);
      }
      return;
    }
    store.tx((tx) => {
      const reopened = tx.db
        .update(stepRuns)
        .set({ status: "pending", owner: null, leaseUntil: null, notBefore: null, recoveries: cuts, error: RESUMED_AFTER_CUT })
        .where(and(eq(stepRuns.id, step.id), eq(stepRuns.attempt, step.attempt), inArray(stepRuns.status, ["leased", "running"])))
        .returning({ id: stepRuns.id })
        .get();
      if (!reopened) throw new StaleStepError(step.id);
      closeCutSessions(tx, run, step);
      tx.emit({
        type: "step.retrying",
        origin: "core",
        ...scopeOf(run, step.id),
        payload: { ...stepPayload(step), recoveries: cuts, error: RESUMED_AFTER_CUT },
      });
    });
  }

  /** Las sesiones del paso que seguían `running` no tienen a quién esperar: quedan cerradas con error. */
  function closeCutSessions(tx: Tx, run: RunRow, step: StepRow): void {
    const cut = tx.db
      .update(agentSessions)
      .set({ status: "error", error: SESSION_CUT, endedAt: now() })
      .where(and(eq(agentSessions.stepRunId, step.id), eq(agentSessions.status, "running")))
      .returning({ id: agentSessions.id })
      .all();
    for (const { id } of cut) {
      tx.emit({ type: "agent.ended", origin: "core", ...scopeOf(run, step.id), payload: { sessionId: id, status: "error" } });
    }
  }

  // --- ejecución de un paso --------------------------------------------------------------------

  async function dispatchNode(job: Job, controller: AbortController): Promise<Settled> {
    const { run, step, node } = job;
    const resolve = (ref: string) => resolveRef(run, step, ref);
    if (node.when !== undefined && !isTruthy(resolveRefs(node.when, resolve))) {
      return { kind: "outcome", outcome: "skipped" };
    }
    if (node.type === "parallel") return openBranches(job, node);
    if (node.type === "flow") return openChild(job, node);
    // Lo que las ramas dejaron no pasa por `resolveRefs`: un texto que parezca un ref no se toca.
    const input =
      job.parallel?.role === "join"
        ? branchOutputs(run.id, job.parallel.parent, job.flow)
        : resolveRefs(
            node.type === "agent" ? node.brief : node.type === "action" || node.type === "wait" ? node.args : node.type === "gate" ? node.question : null,
            resolve,
          );
    const inputHash = artifacts.put(JSON.stringify(input), "brief", { mime: "application/json" });
    artifacts.ref(inputHash, { type: "step_run", id: step.id, role: "input" });
    markRunning(job, inputHash);
    // En un wait `timeoutSec` es el plazo de la espera (`deadline`), no un límite a esta ejecución.
    if (node.type === "wait") return enterWait(job, node.event, input);
    if (node.type === "gate") return openGate(job, node, input);

    const timeoutSec = node.timeoutSec ?? (node.type === "action" ? actions.get(node.action)?.timeoutSec : undefined);
    const timer =
      timeoutSec === undefined ? undefined : setTimeout(() => controller.abort(new StepTimeout(timeoutSec)), timeoutSec * 1000);
    try {
      return node.type === "agent"
        ? await performAgent(job, input, controller.signal)
        : await performAction(job, input, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  function markRunning(job: Job, inputHash: ArtifactHash): void {
    store.tx((tx) => {
      const claimed = tx.db
        .update(stepRuns)
        .set({ status: "running", inputHash })
        .where(and(eq(stepRuns.id, job.step.id), eq(stepRuns.attempt, job.step.attempt), eq(stepRuns.status, "leased")))
        .returning({ id: stepRuns.id })
        .get();
      if (!claimed) throw new StaleStepError(job.step.id);
      tx.emit({
        type: "step.started",
        origin: "core",
        ...scopeOf(job.run, job.step.id),
        payload: stepPayload(job.step),
      });
    });
  }

  async function performAction(job: Job, input: unknown, signal: AbortSignal): Promise<Settled> {
    const { run, step, node } = job;
    if (node.type !== "action") throw new Error("performAction recibió un nodo que no es una acción.");
    const action = actions.get(node.action);
    if (!action) return permanent(`La acción "${node.action}" no está registrada.`);
    const args = action.args.safeParse(input);
    if (!args.success) return permanent(`Los args de "${node.action}" no son válidos: ${issuesInline(args.error.issues)}`);

    const key = `${run.id}:${step.nodeId}:${step.visit}`;
    const ctx: ActionCtx = { runId: run.id, stepId: step.id, key, signal, once: (stage, fn) => once(key, stage, fn) };
    let result;
    try {
      result = await raceAbort(action.run(args.data, ctx), signal);
    } catch (error) {
      if (signal.reason instanceof StepTimeout) return timedOut(signal.reason);
      if (error instanceof EnvironmentError) {
        environment?.breakers.trip({ scope: error.scope, cause: "environment", reason: error.message });
        return deferUntil(error.message, now() + ENVIRONMENT_BACKOFF_MS);
      }
      return error instanceof PermanentActionError ? permanent(error.message) : { kind: "failed", error: messageOf(error) };
    }
    if (!action.outcomes.includes(result.outcome)) {
      return permanent(`La acción "${node.action}" devolvió el outcome "${result.outcome}", que no declara (${action.outcomes.join(", ")}).`);
    }
    const output = action.output?.safeParse(result.output);
    if (output && !output.success) {
      return permanent(`El output de "${node.action}" no cumple su esquema: ${issuesInline(output.error.issues)}`);
    }
    return { kind: "outcome", outcome: result.outcome, output: result.output };
  }

  async function performAgent(job: Job, payload: unknown, signal: AbortSignal): Promise<Settled> {
    const { run, step, node } = job;
    if (node.type !== "agent") throw new Error("performAgent recibió un nodo que no es un agente.");
    const workspace = workspaceFor(run);
    if (!workspace) return permanent(`El paso "${step.nodeId}" es un agente y la corrida no tiene un workspace tomado.`);
    const roleDef = run.roles[node.role];
    const profileDef = run.profileDefId !== null && run.profileVersion !== null ? { id: run.profileDefId, version: run.profileVersion } : undefined;
    const profile = profileDef && defs.get("profile", profileDef.id, profileDef.version);
    if (!roleDef || !profile) return permanent(`La corrida no fijó el rol "${node.role}" o su perfil.`);

    const roleBody = Role.safeParse(defs.get("role", roleDef.id, roleDef.version)?.body);
    const proposesLearnings = roleBody.success && roleBody.data.modes[node.mode]?.learnings === true;
    const briefRun: Brief["run"] = { id: run.id, subject: { type: run.subjectType, id: run.subjectId }, round: step.round, attempt: step.attempt };
    const brief: Brief = briefFor
      ? await briefFor({ run: briefRun, nodeId: step.nodeId, visit: step.visit, mode: node.mode, role: node.role, proposesLearnings, projectId: run.projectId ?? undefined, payload, lineage: lineage(run) })
      : { run: briefRun, worktree: workspace.path, base: workspace.base, mode: node.mode, artifacts: {}, payload };
    const reopened = step.error === null ? undefined : REOPENED[step.error];
    // Tras pasarse del tope el paso reintenta con el perfil escalado y una sesión nueva con handoff.
    const escalated = step.error === ESCALATED;
    const steer = reopened?.resume === "steer" ? steerOf(step) : undefined;
    const placement = {
      profile: profile.slug,
      profileDef,
      stepRunId: step.id,
      projectId: run.projectId ?? undefined,
      repoId: workspace.repoId,
      signal,
      notice: reopened?.notice ?? (steer && `${STEER_NOTICE}\n\n${steer.message}`),
    };
    // Una sesión que la interrupción dejó `running` se retoma; sin ella (llegó antes de que el runtime
    // le diera id) empieza una nueva con el mismo brief. Con un mensaje se retoma la última del paso (o la que
    // la persona eligió al darle un paso nuevo), aunque haya terminado.
    const resumable = steer ? (steer.session ?? lastSessionOf(step.id)) : reopened?.resume === "unfinished" ? unfinishedSession(step.id) : undefined;
    const result = resumable
      ? await agents.resume({ ...placement, sessionId: resumable, mode: node.mode, brief })
      : await agents.run({
          ...placement,
          role: node.role,
          profileRole: escalated ? node.escalate?.profileRole : node.profileRole,
          roleDef,
          mode: node.mode,
          brief,
          workspace: workspace.path,
          resumeFrom: node.resumeFrom === undefined || reopened?.resume === "none" ? undefined : priorSession(run, node.resumeFrom),
        });
    if (signal.reason instanceof StepTimeout) return timedOut(signal.reason);
    const overspent = result.status === "error_max_turns" || result.status === "error_max_budget_usd";
    if (overspent && node.escalate && !escalated) return { kind: "escalate" };
    return fromAgentResult(result, () => runtimeOfNode(run, node));
  }

  /** `runtimeOf`: el runtime del nodo, por si el resultado no dice cuál falló. */
  function fromAgentResult(result: AgentResult, runtimeOf: () => string): Settled {
    switch (result.status) {
      case "success":
        return { kind: "outcome", outcome: result.report.outcome, output: result.report.payload, reported: { notes: result.report.decisions ?? [], learnings: result.report.learnings ?? [] } };
      case "error":
        return { kind: "failed", error: result.message };
      case "login_expired":
      case "quota_exhausted":
        environment?.breakers.trip({
          scope: runtimeScope(result.runtime ?? runtimeOf()),
          cause: result.status,
          reason: result.message,
          ...(result.resetsAt === undefined ? {} : { resetsAt: result.resetsAt }),
        });
        return deferUntil(result.message, result.resetsAt ?? now() + ENVIRONMENT_BACKOFF_MS);
      case "error_max_turns":
      case "error_max_budget_usd":
      case "report_invalid":
        return permanent(result.message);
    }
  }

  /**
   * Falló el entorno, no el paso. Con breakers, quien manda la espera es el breaker de la causa (el paso sigue
   * pending y no se despacha mientras esté abierto, y sigue en cuanto se cierra: reconectar no espera a un
   * backoff); sin ellos, `notBefore`.
   */
  function deferUntil(error: string, notBefore: number): Settled {
    return { kind: "deferred", error, notBefore: environment ? now() : notBefore };
  }

  /** La sesión de este paso que un corte dejó sin cerrar. */
  function unfinishedSession(stepId: StepRunId): string | undefined {
    return store.db
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(and(eq(agentSessions.stepRunId, stepId), eq(agentSessions.error, SESSION_CUT)))
      .orderBy(desc(agentSessions.id))
      .limit(1)
      .get()?.id;
  }

  /** La última sesión del paso, terminada o no. */
  function lastSessionOf(stepId: StepRunId): string | undefined {
    return store.db
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(eq(agentSessions.stepRunId, stepId))
      .orderBy(desc(agentSessions.id))
      .limit(1)
      .get()?.id;
  }

  /** El mensaje que una persona le dejó al paso con `steer` (el último) y la sesión que quiso retomar, si eligió una. */
  function steerOf(step: StepRow): { message: string; session?: string } | undefined {
    const commands = store.events
      .since(0, { runId: step.runId, types: ["step.commanded"] })
      .filter((e) => e.stepRunId === step.id && e.payload.command === "steer");
    const last = commands.at(-1);
    if (!last || typeof last.payload.message !== "string") return undefined;
    return { message: last.payload.message, ...(typeof last.payload.session === "string" && { session: last.payload.session }) };
  }

  /** La última sesión de un paso terminado de ese nodo, en la corrida o en sus padres, para que `resumeFrom` parta de ella. */
  function priorSession(run: RunRow, nodeId: string): string | undefined {
    for (const runId of lineage(run)) {
      const found = store.db
        .select({ id: agentSessions.id })
        .from(agentSessions)
        .innerJoin(stepRuns, eq(agentSessions.stepRunId, stepRuns.id))
        .where(and(eq(stepRuns.runId, runId), eq(stepRuns.nodeId, nodeId), eq(stepRuns.status, "done")))
        .orderBy(desc(agentSessions.id))
        .limit(1)
        .get()?.id;
      if (found) return found;
    }
    return undefined;
  }

  async function once<T>(key: string, stage: string, fn: () => Promise<T>): Promise<T> {
    const done = store.db
      .select({ result: actionEffects.result })
      .from(actionEffects)
      .where(and(eq(actionEffects.idemKey, key), eq(actionEffects.stage, stage)))
      .get();
    if (done) return (done.result as { value: T }).value;
    const value = await fn();
    store.tx((tx) =>
      tx.db
        .insert(actionEffects)
        .values({ idemKey: key, stage, result: { value: value ?? null }, createdAt: now() })
        .onConflictDoNothing()
        .run(),
    );
    return value;
  }

  // --- refs ------------------------------------------------------------------------------------

  // --- cierre de un paso -----------------------------------------------------------------------

  function settle(job: Job, settled: Settled): void {
    switch (settled.kind) {
      case "outcome": {
        const outputHash =
          settled.output === undefined
            ? undefined
            : artifacts.put(JSON.stringify(settled.output), "report", { mime: "application/json" });
        if (outputHash) artifacts.ref(outputHash, { type: "step_run", id: job.step.id, role: "output" });
        transition(job, settled.outcome, outputHash, settled.error, settled.reported);
        return;
      }
      case "failed": {
        // Con el breaker de su ámbito abierto, la falla es del entorno y no del paso (un 401 de GitHub que
        // acaba de abrir el breaker `github`): espera sin gastar intento.
        if (pausedBy(job) !== undefined) return requeue(job, settled.error, now(), true);
        const policy = retryOf(job.node);
        // Ni un corte ni una espera del entorno gastan intento.
        const spent = job.step.attempt - job.step.recoveries - job.step.deferrals;
        if (spent > policy.max) return transition(job, "error", undefined, settled.error);
        const wait = policy.backoffSec[Math.min(spent, policy.backoffSec.length) - 1] ?? 0;
        return requeue(job, settled.error, now() + wait * 1000, false);
      }
      case "deferred":
        return requeue(job, settled.error, settled.notBefore, true);
      case "escalate":
        return requeue(job, ESCALATED, now(), false);
    }
  }

  function retryOf(node: Node): RetryPolicy {
    if (node.retry) return node.retry;
    if (node.type === "action") return actions.get(node.action)?.retry ?? DEFAULT_ACTION_RETRY;
    if (node.type === "wait") return DEFAULT_ACTION_RETRY;
    return DEFAULT_AGENT_RETRY;
  }

  /** El paso vuelve a pending con su backoff; `attempt` es lo que queda gastado. */
  function requeue(job: Job, error: string, notBefore: number, deferred: boolean): void {
    store.tx((tx) => {
      const requeued = tx.db
        .update(stepRuns)
        .set({
          status: "pending",
          notBefore,
          ...(deferred && { deferrals: sql`${stepRuns.deferrals} + 1` }),
          error,
          owner: null,
          leaseUntil: null,
        })
        .where(and(eq(stepRuns.id, job.step.id), eq(stepRuns.attempt, job.step.attempt), inArray(stepRuns.status, ["leased", "running"])))
        .returning({ id: stepRuns.id })
        .get();
      if (!requeued) throw new StaleStepError(job.step.id);
      tx.emit({
        type: "step.retrying",
        origin: "core",
        ...scopeOf(job.run, job.step.id),
        payload: { ...stepPayload(job.step), notBefore, error },
      });
    });
  }

  /**
   * La transición: cierra el paso, elige el edge por outcome, cuenta la ronda, crea el paso
   * siguiente en pending y escribe los eventos, todo en la misma transacción. Sin edge para el
   * outcome (un `error` que el nodo no maneja) la corrida queda parked en este paso.
   *
   * Una rama de un parallel no sigue edges: al cerrarse mira si era la última, y si lo era la
   * misma transacción cierra el parallel con el edge de su outcome. El output del join se guarda
   * antes, porque los artefactos abren su propia transacción.
   */
  function transition(
    job: Job,
    outcome: string,
    outputHash: ArtifactHash | undefined,
    error: string | undefined,
    reported?: Reported,
  ): void {
    const { step, node, parallel } = job;
    const failed = outcome === "error" || outcome === "timeout";
    const parent = parallel && parallelStepOf(step.runId, parallel.parent);
    const plan =
      parallel?.role === "branch" && parent
        ? planJoin(job, parent, { stepId: step.id, status: failed ? "failed" : "done", outcome, outputHash: outputHash ?? null, error: error ?? null })
        : undefined;

    store.tx((tx) => {
      const run = tx.db.select().from(runs).where(eq(runs.id, step.runId)).get();
      if (!run) throw new Error(`Desapareció la corrida ${step.runId}.`);
      if (!parallel || !parent) return advance(tx, run, step, node, outcome, outputHash, error, reported);

      closeStep(tx, run, step, { status: failed ? "failed" : "done", outcome, outputHash, message: error, reported });
      // El cierre sumó su costo a la corrida: `advance` parte de la fila al día.
      const current = tx.db.select().from(runs).where(eq(runs.id, run.id)).get() ?? run;
      const parentNode = parallelOf(job.flow, parallel.parent);
      if (parallel.role === "join") {
        // Un join que falla es un error del parallel; si no, su outcome es el del parallel.
        return advance(tx, current, parent, parentNode, failed ? "error" : outcome, failed ? undefined : outputHash, error);
      }
      applyJoin(tx, current, parent, parentNode, plan ?? { kind: "wait" });
    });
  }

  /** Cierra `step` con el edge de su outcome y deja la corrida donde ese edge la lleve. */
  function advance(
    tx: Tx,
    run: RunRow,
    step: StepRow,
    node: Node,
    outcome: string,
    outputHash: ArtifactHash | undefined,
    error: string | undefined,
    reported?: Reported,
  ): void {
    const edge = edgeFor(node, outcome);
    const taken = edge === undefined ? undefined : takeEdge(edge, `${step.nodeId}.${outcome}`, run.rounds, run.params);
    const message = error ?? (taken ? undefined : `el nodo "${step.nodeId}" no tiene edge para el outcome "${outcome}"`);
    const cost = closeStep(tx, run, step, {
      status: taken ? "done" : "failed",
      outcome,
      outputHash,
      message,
      note: taken?.note,
      reported,
    });

    if (!taken) return parkForHuman(tx, run, step, node, message ?? "");
    follow(tx, run, step, taken, cost);
  }

  /** Lleva la corrida adonde va el edge tomado: a su fin, o a un paso nuevo en pending. `cost` es el del paso que se acaba de cerrar. */
  function follow(tx: Tx, run: RunRow, step: StepRow, taken: Taken, cost: number): void {
    const rounds = taken.counter ? { ...run.rounds, [taken.counter.key]: taken.counter.count } : run.rounds;
    // `stopBefore`: llegar al nodo donde el padre pidió cortar termina la corrida hija como `done`.
    const result = taken.to.startsWith("@") ? taken.to.slice(1) : taken.to === run.stopBefore ? "done" : undefined;
    if (result !== undefined) {
      const endedAt = now();
      tx.db
        .update(runs)
        .set({ rounds, status: result === "done" ? "done" : "failed", outcome: result, endedAt })
        .where(eq(runs.id, run.id))
        .run();
      recordRunMetrics(tx, run.id);
      subjects.ended(tx, run);
      tx.emit({
        type: "run.finished",
        origin: "core",
        ...scopeOf(run),
        payload: { outcome: result, costMicros: run.costMicros + cost, minutes: (endedAt - run.startedAt) / 60_000 },
      });
      return;
    }

    tx.db.update(runs).set({ rounds }).where(eq(runs.id, run.id)).run();
    insertStep(tx, run, taken.to, { visit: nextVisit(tx, run.id, taken.to), round: taken.round, prev: step.id });
  }

  /** Marca el paso como cerrado, escribe `step.finished` y suma su costo a la corrida. Devuelve el costo. */
  function closeStep(
    tx: Tx,
    run: RunRow,
    step: StepRow,
    closing: {
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
    },
  ): number {
    const cost = Number(
      tx.db.select({ total: sum(stepUsage.costMicros) }).from(stepUsage).where(eq(stepUsage.stepRunId, step.id)).get()?.total ?? 0,
    );
    const closed = tx.db
      .update(stepRuns)
      .set({
        status: closing.status,
        outcome: closing.outcome,
        outputHash: closing.outputHash,
        error: closing.message ?? null,
        costMicros: cost,
        owner: null,
        leaseUntil: null,
        notBefore: null,
      })
      .where(and(eq(stepRuns.id, step.id), eq(stepRuns.attempt, step.attempt), inArray(stepRuns.status, closing.from ?? ["leased", "running", "waiting"])))
      .returning({ id: stepRuns.id })
      .get();
    if (!closed) throw new StaleStepError(step.id);
    tx.emit({
      type: "step.finished",
      origin: "core",
      ...scopeOf(run, step.id),
      payload: {
        ...stepPayload(step),
        outcome: closing.outcome,
        outputHash: closing.outputHash ?? null,
        costMicros: cost,
        ...(closing.message === undefined ? {} : { error: closing.message }),
        ...(closing.note === undefined ? {} : { note: closing.note }),
      },
    });
    // Notas que no bloquean: la corrida sigue por su edge, no entran a la bandeja: se leen en la corrida y en su PR.
    const scope = scopeOf(run, step.id);
    if (closing.note !== undefined) openEdgeNote(tx, run, step, closing.outcome, closing.note);
    for (const note of closing.reported?.notes ?? []) openDecision(tx, { ...scope, kind: "review_note", ...note });
    // Un learning aplica a un proyecto: la corrida sin uno no tiene a quién proponérselo.
    const { projectId } = run;
    if (projectId) {
      const texts = (closing.reported?.learnings ?? []).map((raw) => raw.trim()).filter((text) => text !== "");
      for (const text of texts.slice(0, MAX_PROPOSED_PER_STEP)) {
        proposeLearning(tx, { projectId, text, source: "agent", sourceRunId: run.id, origin: "core" });
      }
      if (texts.length > MAX_PROPOSED_PER_STEP) {
        tx.emit({
          type: "error",
          origin: "core",
          ...scope,
          payload: { scope: "learnings", message: `El paso propuso ${texts.length} learnings: se guardaron ${MAX_PROPOSED_PER_STEP} y se descartaron ${texts.length - MAX_PROPOSED_PER_STEP} (máximo ${MAX_PROPOSED_PER_STEP} por paso).` },
        });
      }
    }
    if (cost > 0) {
      tx.db.update(runs).set({ costMicros: sql`${runs.costMicros} + ${cost}` }).where(eq(runs.id, run.id)).run();
    }
    return cost;
  }

  /** La decisión no bloqueante que deja el edge tomado al cerrar `step` con `outcome`. */
  function openEdgeNote(tx: Tx, run: RunRow, step: StepRow, outcome: string, note: string): void {
    const body = `Al cerrar el paso "${step.nodeId}" con el outcome "${outcome}".`;
    openDecision(tx, { ...scopeOf(run, step.id), kind: "review_note", title: note, body });
  }

  function nextVisit(tx: Tx, runId: RunId, nodeId: string): number {
    const last = tx.db
      .select({ visit: max(stepRuns.visit) })
      .from(stepRuns)
      .where(and(eq(stepRuns.runId, runId), eq(stepRuns.nodeId, nodeId)))
      .get();
    return (last?.visit ?? 0) + 1;
  }

  // --- wait ------------------------------------------------------------------------------------

  /**
   * Entra a un wait: si `probe` ya ve lo esperado termina de inmediato; si no, el paso queda
   * `waiting` con su clave y su plazo, y lo cierra `signal`, un sondeo o el vencimiento. Un evento
   * que llegue entre el `probe` y el guardado se pierde hasta el próximo sondeo.
   */
  async function enterWait(job: Job, event: string, input: unknown): Promise<Settled> {
    const { step, node } = job;
    const wait = waits.get(event);
    if (!wait) return permanent(`El wait "${event}" no está registrado.`);
    const args = wait.args.safeParse(input);
    if (!args.success) return permanent(`Los args de "${event}" no son válidos: ${issuesInline(args.error.issues)}`);

    const found = await wait.probe(args.data);
    if (found) return fromWaitResult(wait, found);

    const waitKey = wait.key(args.data);
    const deadline = node.timeoutSec === undefined ? null : now() + node.timeoutSec * 1000;
    store.tx((tx) => {
      const waiting = tx.db
        .update(stepRuns)
        .set({ status: "waiting", owner: null, leaseUntil: null, waitKey, deadline })
        .where(and(eq(stepRuns.id, step.id), eq(stepRuns.attempt, step.attempt), eq(stepRuns.status, "running")))
        .returning({ id: stepRuns.id })
        .get();
      if (!waiting) throw new StaleStepError(step.id);
      tx.emit({
        type: "step.waiting",
        origin: "core",
        ...scopeOf(job.run, step.id),
        payload: { ...stepPayload(step), waitKey, deadline },
      });
    });
    nextProbeAt.set(step.id, now() + probeEveryMs);
    return { kind: "waiting" };
  }

  function fromWaitResult(wait: WaitDef, result: WaitResult): Settled {
    if (!wait.outcomes.includes(result.outcome)) {
      return permanent(`El wait "${wait.name}" devolvió el outcome "${result.outcome}", que no declara (${wait.outcomes.join(", ")}).`);
    }
    return { kind: "outcome", outcome: result.outcome, output: result.output };
  }

  function signal(event: ExternalEvent): void {
    for (const waiting of waitingSteps()) {
      const input = waitInput(waiting);
      if (!input.ok) closeWaiting(waiting, permanent(input.error));
      else {
        let found: WaitResult | undefined;
        try {
          found = input.wait.match(event, input.args);
        } catch (error) {
          closeWaiting(waiting, permanent(`El match de "${input.wait.name}" falló: ${messageOf(error)}`));
          continue;
        }
        if (found) closeWaiting(waiting, fromWaitResult(input.wait, found));
      }
    }
    wake();
  }

  function waitKeys(): string[] {
    return store.db
      .select({ key: stepRuns.waitKey })
      .from(stepRuns)
      .innerJoin(runs, eq(stepRuns.runId, runs.id))
      .where(and(eq(stepRuns.status, "waiting"), isNotNull(stepRuns.waitKey), inArray(runs.status, ADVANCING_RUN_STATUSES)))
      .all()
      .flatMap(({ key }) => key ?? []);
  }

  /** Los waits que esperan en corridas que corren o están pausadas. */
  function waitingSteps(): Job[] {
    return store.db
      .select({ step: stepRuns, run: runs })
      .from(stepRuns)
      .innerJoin(runs, eq(stepRuns.runId, runs.id))
      .where(and(eq(stepRuns.status, "waiting"), isNotNull(stepRuns.waitKey), inArray(runs.status, ADVANCING_RUN_STATUSES)))
      .orderBy(asc(stepRuns.id))
      .all()
      .flatMap(({ step, run }) => loadJob(run, step) ?? []);
  }

  /** El wait y los args que el paso guardó al entrar. */
  function waitInput(job: Job): { ok: true; wait: WaitDef; args: unknown } | { ok: false; error: string } {
    if (job.node.type !== "wait") return { ok: false, error: `El paso ${job.step.id} espera y su nodo no es un wait.` };
    const wait = waits.get(job.node.event);
    if (!wait) return { ok: false, error: `El wait "${job.node.event}" no está registrado.` };
    let saved: unknown;
    try {
      saved = readArtifact(job.step.inputHash);
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
    const args = wait.args.safeParse(saved);
    if (!args.success) return { ok: false, error: `Los args de "${job.node.event}" no son válidos: ${issuesInline(args.error.issues)}` };
    return { ok: true, wait, args: args.data };
  }

  /** Cierra un wait desde fuera de su ejecución. Si otro camino lo cerró antes, no hace nada. */
  function closeWaiting(job: Job, settled: Settled): void {
    try {
      settle(job, settled);
      nextProbeAt.delete(job.step.id);
    } catch (error) {
      if (error instanceof StaleStepError) return;
      console.error(`No se pudo cerrar el wait ${job.step.id} (${job.step.nodeId}):`, error);
      parkAfterFailure(job, messageOf(error));
    }
  }

  /** El tick: vence los waits cuyo plazo pasó y sondea los que ya les toca. */
  function sweepWaits(): void {
    for (const job of waitingSteps()) {
      const { step, node } = job;
      if (step.deadline !== null && step.deadline <= now()) {
        const timeout = new StepTimeout(node.timeoutSec ?? 0, "El wait");
        closeWaiting(job, timedOut(timeout));
      } else if (!probing.has(step.id) && (nextProbeAt.get(step.id) ?? 0) <= now()) {
        probeWait(job);
      }
    }
  }

  function probeWait(job: Job): void {
    const input = waitInput(job);
    if (!input.ok) return closeWaiting(job, permanent(input.error));
    const { id } = job.step;
    probing.add(id);
    nextProbeAt.set(id, now() + probeEveryMs);
    const probe = (async () => {
      try {
        const found = await input.wait.probe(input.args);
        if (found) closeWaiting(job, fromWaitResult(input.wait, found));
        else noteProbeError(job, null);
      } catch (error) {
        noteProbeError(job, messageOf(error));
      } finally {
        probing.delete(id);
      }
      wake();
    })().finally(() => inFlight.delete(probe));
    inFlight.add(probe);
  }

  /** Un sondeo que lanza no cierra el wait: se anota en el paso y se vuelve a intentar en el próximo. */
  function noteProbeError(job: Job, error: string | null): void {
    try {
      store.tx((tx) =>
        tx.db
          .update(stepRuns)
          .set({ error })
          // Sin error que anotar solo se limpia uno anterior: un sondeo sin novedades no escribe.
          .where(and(eq(stepRuns.id, job.step.id), eq(stepRuns.status, "waiting"), error === null ? isNotNull(stepRuns.error) : undefined))
          .run(),
      );
    } catch (cause) {
      console.error(`No se pudo anotar el error del sondeo de ${job.step.id}:`, cause);
    }
  }

  // --- gate ------------------------------------------------------------------------------------

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

  // --- parallel --------------------------------------------------------------------------------

  /**
   * El parallel crea un paso por rama y queda waiting; el join lo evalúa la transacción que cierra
   * la última. Con `rerun: "not-ok"`, al reentrar solo corren las ramas que no dieron ok: las demás
   * aportan al join lo último que dejaron.
   */
  function openBranches(job: Job, node: ParallelNode): Settled {
    const { run, step } = job;
    let items: unknown[] | undefined;
    if (!Array.isArray(node.branches)) {
      const value = resolveRefs(node.branches.forEach, (ref) => resolveRef(run, step, ref));
      if (!Array.isArray(value)) {
        return permanent(`El forEach ${node.branches.forEach} del parallel "${step.nodeId}" no resolvió a una lista: ${JSON.stringify(value)}.`);
      }
      items = value;
    }
    const inputHash = artifacts.put(JSON.stringify(items ?? node.branches), "brief", { mime: "application/json" });
    artifacts.ref(inputHash, { type: "step_run", id: step.id, role: "input" });
    markRunning(job, inputHash);

    const toRun = branchIds(step.nodeId, node, items?.length).filter(
      (id) => node.rerun !== "not-ok" || !isOk(latestStep(run.id, id)),
    );
    const opened = { ...step, inputHash };
    // Sin ramas que correr (una lista vacía, o todas ya dieron ok) el join se evalúa de inmediato.
    const plan = toRun.length === 0 ? planJoin(job, opened, undefined) : undefined;

    store.tx((tx) => {
      const waiting = tx.db
        .update(stepRuns)
        .set({ status: "waiting", owner: null, leaseUntil: null })
        .where(and(eq(stepRuns.id, step.id), eq(stepRuns.attempt, step.attempt), eq(stepRuns.status, "running")))
        .returning()
        .get();
      if (!waiting) throw new StaleStepError(step.id);
      for (const id of toRun) {
        insertStep(tx, run, id, {
          visit: nextVisit(tx, run.id, id),
          round: step.round,
          prev: step.prevStepRunId ?? undefined,
        });
      }
      if (plan) applyJoin(tx, run, waiting, node, plan);
    });
    return { kind: "waiting" };
  }

  /** Lo que el join hace con el parallel `parent`, ya decidido por `planJoin`. */
  function applyJoin(tx: Tx, run: RunRow, parent: StepRow, node: ParallelNode, plan: JoinPlan): void {
    if (plan.kind === "wait") return;
    if (plan.kind === "done") return advance(tx, run, parent, node, plan.outcome, plan.outputHash, plan.error);
    insertStep(tx, run, joinStepId(parent.nodeId), {
      visit: nextVisit(tx, run.id, joinStepId(parent.nodeId)),
      round: parent.round,
      prev: parent.prevStepRunId ?? undefined,
    });
  }

  /**
   * Decide qué pasa con `parent` cuando `closing` cierra una de sus ramas (o ahora mismo, sin
   * `closing`). Corre antes de la transacción: el output del consolidador va a artifacts, que abren
   * la suya. No hay un await entre este plan y la transacción que lo aplica, así que ninguna otra
   * rama se cierra en medio.
   */
  function planJoin(job: Job, parent: StepRow, closing: Omit<BranchState, "key"> | undefined): JoinPlan {
    const node = parallelOf(job.flow, parent.nodeId);
    const states = branchStates(job.run.id, parent, node, closing);
    if (states.some((s) => ["pending", "leased", "running", "waiting"].includes(s.status))) return { kind: "wait" };

    const failed = states.filter((s) => s.status === "failed");
    const ran = states.filter((s) => s.status === "done" && s.outcome !== "skipped");
    // Con `ignore` el join sigue sin las ramas con error, salvo que ninguna haya salido bien.
    if (failed.length > 0 && (node.onBranchError !== "ignore" || ran.length === 0)) {
      const why = failed.map((s) => `${s.key}: ${s.error ?? s.outcome}`).join("; ");
      return { kind: "done", outcome: "error", error: `Fallaron ramas de "${parent.nodeId}" (${why}).` };
    }

    const join = node.join ?? "worst";
    if (typeof join === "object" && "role" in join) return { kind: "agent" };
    const name = typeof join === "string" ? join : join.fn;
    const consolidator = consolidators.get(name);
    if (!consolidator) return { kind: "done", outcome: "error", error: `El consolidador "${name}" no está registrado.` };
    try {
      const rawArgs = typeof join === "string" ? {} : resolveRefs(join.args ?? {}, (ref) => resolveRef(job.run, parent, ref));
      const args = consolidator.args ? consolidator.args.safeParse(rawArgs) : { success: true as const, data: rawArgs };
      if (!args.success) return { kind: "done", outcome: "error", error: `Los args de "${name}" no son válidos: ${issuesInline(args.error.issues)}` };
      const byBranch = Object.fromEntries(ran.map((s) => [s.key, { outcome: s.outcome ?? "", output: readArtifact(s.outputHash) }]));
      const result = consolidator.run(byBranch, args.data);
      if (result.outcome !== "error" && !consolidator.outcomes.includes(result.outcome)) {
        return { kind: "done", outcome: "error", error: `El consolidador "${name}" falló: devolvió el outcome "${result.outcome}", que no declara (${consolidator.outcomes.join(", ")})` };
      }
      const outputHash = artifacts.put(JSON.stringify(result.output), "report", { mime: "application/json" });
      artifacts.ref(outputHash, { type: "step_run", id: parent.id, role: "output" });
      return { kind: "done", outcome: result.outcome, outputHash };
    } catch (error) {
      return { kind: "done", outcome: "error", error: `El consolidador "${name}" falló: ${messageOf(error)}` };
    }
  }

  /** El último paso de cada rama del parallel, con el cierre de `closing` aplicado si aún no se guardó. */
  function branchStates(runId: RunId, parent: StepRow, node: ParallelNode, closing: Omit<BranchState, "key"> | undefined): BranchState[] {
    const fixed = Array.isArray(node.branches);
    return branchIds(parent.nodeId, node, fixed ? undefined : itemsOf(parent).length).flatMap((id, index) => {
      const last = latestStep(runId, id);
      if (!last) return [];
      const key = fixed ? id : String(index);
      if (closing?.stepId === last.id) return [{ key, ...closing }];
      return [{ key, stepId: last.id, status: last.status, outcome: last.outcome, outputHash: last.outputHash, error: last.error }];
    });
  }

  /** `{ rama: output }`: lo que recibe un rol consolidador. Sin las ramas con error ni las saltadas. */
  function branchOutputs(runId: RunId, parentId: string, flow: FlowDef): Record<string, unknown> {
    const parent = parallelStepOf(runId, parentId);
    const states = branchStates(runId, parent, parallelOf(flow, parentId), undefined);
    return Object.fromEntries(
      states.filter((s) => s.status === "done" && s.outcome !== "skipped").map((s) => [s.key, readArtifact(s.outputHash)]),
    );
  }

  /** Una rama que ya dio ok (o se saltó) no se relanza con `rerun: "not-ok"`. */
  const isOk = (step: StepRow | undefined) => step?.status === "done" && (step.outcome === "ok" || step.outcome === "skipped");

  // --- flow ------------------------------------------------------------------------------------

  /**
   * El nodo `flow` crea una corrida hija del subflujo que la corrida fijó al empezar y queda
   * waiting, como un parallel. Paso y corrida hija nacen en la misma transacción, así que un paso
   * `flow` reabierto tras un corte (leased o running) nunca tiene hija. La hija hereda sujeto, carril,
   * roles y, salvo que el nodo diga otro, el perfil; un padre `effects: "local"` no deja publicar a la hija.
   * Cuando la hija termina, `sweepChildren` cierra este paso con su outcome.
   */
  function openChild(job: Job, node: FlowNode): Settled {
    const { run, step } = job;
    const resolve = (ref: string) => resolveRef(run, step, ref);
    const params = resolveRefs(node.params, resolve);
    const profile = resolveRefs(node.profile ?? null, resolve);
    const inputHash = artifacts.put(JSON.stringify({ params, profile }), "brief", { mime: "application/json" });
    artifacts.ref(inputHash, { type: "step_run", id: step.id, role: "input" });
    markRunning(job, inputHash);

    const pin = run.subflows[node.flow];
    const def = pin && defs.get("flow", pin.id, pin.version);
    if (!def) return permanent(`La corrida no fijó el subflujo "${node.flow}".`);
    const flow = FlowDef.parse(def.body);
    if (node.stopBefore === flow.start) {
      return permanent(`stopBefore "${node.stopBefore}" es el nodo inicial de "${flow.id}": la corrida hija no tendría nada que ejecutar.`);
    }
    if (!isRecord(params)) {
      return permanent(`Los params del nodo "${step.nodeId}" no resolvieron a un objeto: ${JSON.stringify(params)}.`);
    }
    let childParams: Record<string, unknown>;
    try {
      childParams = paramsFor(flow, params);
    } catch (error) {
      return permanent(messageOf(error));
    }

    let profilePin: DefPin | undefined =
      run.profileDefId !== null && run.profileVersion !== null ? { id: run.profileDefId, version: run.profileVersion } : undefined;
    if (profile !== null) {
      const found = typeof profile === "string" ? defs.resolve("profile", profile) : undefined;
      if (!found) return permanent(`El perfil ${JSON.stringify(profile)} del nodo "${step.nodeId}" no existe.`);
      profilePin = { id: found.id, version: found.version };
    }

    store.tx((tx) => {
      const waiting = tx.db
        .update(stepRuns)
        .set({ status: "waiting", owner: null, leaseUntil: null })
        .where(and(eq(stepRuns.id, step.id), eq(stepRuns.attempt, step.attempt), eq(stepRuns.status, "running")))
        .returning({ id: stepRuns.id })
        .get();
      if (!waiting) throw new StaleStepError(step.id);
      insertRun(tx, {
        projectId: run.projectId,
        subject: { type: run.subjectType, id: run.subjectId },
        def: { id: def.id, slug: def.slug, version: def.version },
        flow,
        params: childParams,
        roles: run.roles,
        subflows: run.subflows,
        profile: profilePin,
        lane: run.lane,
        writes: run.writes && flow.effects !== "local",
        parent: { runId: run.id, stepRunId: step.id, stopBefore: node.stopBefore },
      });
    });
    return { kind: "waiting" };
  }

  /**
   * Cierra los pasos `flow` cuya corrida hija ya terminó: el outcome del paso es el `@end` de la
   * hija (`done`, `blocked` o `failed`; una hija cancelada cuenta como `failed`). Corre en cada
   * despertar del dispatcher, y por eso `recover()` cierra también lo que un corte dejó entre el
   * fin de la hija y el cierre del padre.
   */
  function sweepChildren(): void {
    const finished = store.db
      .select()
      .from(runs)
      .where(
        and(
          inArray(runs.status, ["done", "failed", "canceled"]),
          inArray(runs.parentStepRunId, store.db.select({ id: stepRuns.id }).from(stepRuns).where(eq(stepRuns.status, "waiting"))),
        ),
      )
      .orderBy(asc(runs.id))
      .all();
    for (const child of finished) {
      const step = child.parentStepRunId === null ? undefined : selectStep(child.parentStepRunId);
      const parent = child.parentRunId === null ? undefined : store.db.select().from(runs).where(eq(runs.id, child.parentRunId)).get();
      if (!step || !parent || !(ADVANCING_RUN_STATUSES as readonly string[]).includes(parent.status)) continue;
      const job = loadJob(parent, step);
      if (!job) continue;
      closeWaiting(
        job,
        child.status === "canceled"
          ? { kind: "outcome", outcome: "failed", error: `La corrida hija ${child.id} se canceló.` }
          : { kind: "outcome", outcome: child.outcome ?? "failed" },
      );
    }
  }

  // --- comandos de una persona ----------------------------------------------------------------

  function control(runId: RunId, cmd: "pause" | "resume" | "cancel", by: Origin, { now: immediately = false }: { now?: boolean } = {}): void {
    if (cmd === "cancel") abortInFlight(store.tx((tx) => cancelFamily(tx, runId, by)), new RunCanceled(runId));
    else if (cmd === "pause") pause(runId, by, immediately);
    else resume(runId, by);
    wake();
  }

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

  function stepCommand(stepId: StepRunId, cmd: { retry: true } | { steer: string } | { force: string }, by: Origin): RunId {
    const done = store.tx((tx) => {
      const step = tx.db.select().from(stepRuns).where(eq(stepRuns.id, stepId)).get();
      const run = step && tx.db.select().from(runs).where(eq(runs.id, step.runId)).get();
      if (!step || !run) throw new StepNotFoundError(stepId);
      if (run.status === "queued" || !LIVE_RUN_STATUSES.includes(run.status as (typeof LIVE_RUN_STATUSES)[number])) {
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

  /** Lo que `stepCommand` hace tras confirmar la transacción: qué pasos interrumpir y cuál es la corrida. */
  interface Commanded {
    runId: RunId;
    /** Pasos que una persona reemplazó o cerró: su cierre tardío se descarta. */
    superseded: StepRunId[];
    /** El paso en curso que recibe un mensaje: vuelve a pending y retoma su sesión. */
    interrupt?: Interruption;
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

  // --- lectura ---------------------------------------------------------------------------------

  async function close(opts?: { graceMs: number }): Promise<void> {
    closed = true;
    clearInterval(ticker);
    if (!opts) return void (await Promise.all(inFlight));
    const stopping = new Interruption("stop", now());
    for (const id of agentSteps) controllers.get(id)?.abort(stopping);
    const abortAll = () => {
      for (const controller of controllers.values()) controller.abort(stopping);
    };
    const grace = opts.graceMs > 0 ? setTimeout(abortAll, opts.graceMs) : undefined;
    if (!grace) abortAll();
    try {
      await Promise.all(inFlight);
    } finally {
      clearTimeout(grace);
    }
  }

  return { start, signal, waitKeys, resolveGate, control, stepCommand, getRun, listRuns, recover, wake, close };
}

class StepTimeout extends Error {
  constructor(
    readonly timeoutSec: number,
    subject = "El paso",
  ) {
    super(`${subject} superó su timeoutSec de ${timeoutSec} s.`);
  }
}

const timedOut = (timeout: StepTimeout): Settled => ({ kind: "outcome", outcome: "timeout", error: timeout.message });

/** Un error que reintentar no arregla (args inválidos, tope de turnos): el outcome `error` sin reintento. */
const permanent = (error: string): Settled => ({ kind: "outcome", outcome: "error", error });

const stepPayload = (step: StepRow) => ({
  stepId: step.id,
  nodeId: step.nodeId,
  round: step.round,
  attempt: step.attempt,
});

/** Una acción que ignora su `signal` no puede dejar al motor esperando: al abortarse, se la deja atrás. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  return Promise.race([work, aborted]);
}


