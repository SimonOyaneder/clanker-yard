import {
  FlowDef,
  type ArtifactHash,
  type Brief,
  type Node,
  type ProjectId,
  type RunId,
  type RunUsage,
  type RunWorkspace,
  type StepRunId,
  type SubjectRef,
} from "@clanker/api";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, max, ne, or, sql, sum } from "drizzle-orm";
import type { AgentResult, Agents } from "../agents/agents";
import type { Artifacts } from "../artifacts/artifacts";
import { openNote } from "../decisions/decisions";
import type { Defs } from "../defs/defs";
import { recordRunMetrics } from "../metrics/record";
import { newId } from "../store/conventions";
import { actionEffects, agentSessions, runs, stepRuns, stepUsage, type DefPin } from "../store/schema";
import type { Store, Tx } from "../store/store";
import { PermanentActionError, type ActionCtx, type ActionDef, type ConsolidatorDef, type ExternalEvent, type RetryPolicy, type WaitDef, type WaitResult } from "./catalog";
import { edgeFor, edgesOf, maxRoundsOf, takeEdge } from "./edges";
import {
  agentRolesOf,
  branchIds,
  joinStepId,
  parallelOf,
  parseInlineBranch,
  stepNode,
  type ParallelNode,
} from "./parallel";
import { readRunDetail } from "./run-detail";
import { isTruthy, navigate, refPath, resolveRefs } from "./refs";
import { calledFlows, LANE_BY_TRIGGER } from "./validate";

/** El lease de un paso: el core dueño lo renueva cada tercio mientras el paso vive. */
const STEP_LEASE_TTL_MS = 120_000;
/** Entre dos despertares del dispatcher, más que esto es que la máquina durmió: los timers no corrieron. */
const CLOCK_JUMP_MS = 30_000;
/** A la tercera vez que un corte interrumpe el mismo paso, el paso da error en vez de reabrirse. */
const MAX_CUTS = 3;
/** El `error` con que `recover` reabre un paso: lo que sigue en el paso hasta que se cierre o falle de nuevo. */
const RESUMED_AFTER_CUT = "La app se cerró con este paso en curso; se retoma.";
/** El `error` de una sesión de agente que un corte dejó sin cerrar: así `performAgent` la reconoce para retomarla. */
const SESSION_CUT = "La app se cerró con la sesión en curso.";
const CUT_NOTICE =
  "La app se reinició mientras trabajabas en esta tarea. Revisa el worktree: puede tener cambios a medias de antes del corte. Termina tu tarea.";
export const TICK_MS = 5000;
export const DEFAULT_MAX_AGENTS = 4;
/** Cada cuánto se sondea un wait mientras no exista Watch que avise con `signal`. */
export const DEFAULT_PROBE_EVERY_SEC = 60;
/** Un valor resuelto de más de esto no entra al brief: va a artifacts y el brief recibe `{ artifact, size }`. */
export const OUTPUT_INLINE_MAX_BYTES = 16 * 1024;
/** Cuánto se espera antes de reintentar un paso frenado por el entorno (login vencido, cuota agotada). */
const ENVIRONMENT_BACKOFF_MS = 60_000;

const DEFAULT_ACTION_RETRY: RetryPolicy = { max: 3, backoffSec: [10, 60, 300] };
const DEFAULT_AGENT_RETRY: RetryPolicy = { max: 1, backoffSec: [10] };

/** Los estados en que una corrida sigue viva: los mismos del índice parcial de `runs`. */
const LIVE_RUN_STATUSES = ["queued", "running", "waiting", "parked", "paused"] as const;

type RunRow = typeof runs.$inferSelect;
type StepRow = typeof stepRuns.$inferSelect;
type FlowNode = Extract<Node, { type: "flow" }>;

export interface StartOptions {
  projectId?: ProjectId;
  /** Para resolver el flujo y los roles con scope `repo`. */
  repoId?: string;
  /** Slug del perfil. Obligatorio si el flujo tiene pasos agent. */
  profile?: string;
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
  /** El brief del nodo con sus refs resueltas. */
  payload: unknown;
  /** La corrida y sus padres: el worktree y los reportes previos pueden ser de cualquiera. */
  lineage: RunId[];
}

export interface EngineDeps {
  store: Store;
  defs: Defs;
  agents: Agents;
  artifacts: Artifacts;
  actions: ReadonlyMap<string, ActionDef>;
  consolidators: ReadonlyMap<string, ConsolidatorDef>;
  waits: ReadonlyMap<string, WaitDef>;
  /** El worktree de la corrida (el que tiene tomado), donde corren sus agentes. */
  workspaceOf?: (runId: RunId) => { path: string; base: string } | undefined;
  /**
   * Arma el brief de un paso agent: deja en el worktree lo que el agente lee (`.clanker-run/`) y lo cita en
   * el brief. Sin esto el brief lleva solo el payload del nodo.
   */
  briefFor?: (request: StepBriefRequest) => Promise<Brief>;
  /** Tope global de agentes a la vez. */
  maxAgents?: number;
  tickMs?: number;
  /** Cada cuánto se sondea un wait con `probe`; por defecto `DEFAULT_PROBE_EVERY_SEC`. */
  probeEverySec?: number;
  /** Identifica a este core como dueño de los leases. */
  bootId?: string;
  /** Al despertar de un sleep, además de los leases de los pasos: extender los de lo que este core mantiene fuera del motor. */
  onClockJump?: () => void;
  now?: () => number;
}

export interface Engine {
  /**
   * Lanza `flow` (slug) sobre `subject`. Idempotente: si ya hay una corrida viva de ese flujo sobre
   * ese sujeto devuelve su id sin mirar `params`. La corrida fija la versión del flujo, de sus roles
   * y del perfil, y también los de los subflujos que llama (nodo `flow`). Falla, sin crear nada, si faltan
   * params, los maxRounds apuntan a un valor inválido o el flujo (o un subflujo) usa nodos que el motor no ejecuta.
   */
  start(flow: string, subject: SubjectRef, params?: Record<string, unknown>, opts?: StartOptions): RunId;
  /**
   * Entrega un hecho externo a los waits que esperan: cada uno cuyo `match` lo reconoce termina con
   * el outcome que devuelve. Los waits que no calzan siguen esperando.
   */
  signal(event: ExternalEvent): void;
  /**
   * Cancela la corrida y todas sus corridas hijas: los pasos pending, running y waiting quedan
   * `canceled`, los agentes en curso se interrumpen y las acciones reciben el abort de su `signal`.
   * Cada corrida emite `run.finished` con outcome `canceled`. No hace nada con una corrida que ya
   * terminó. Lanza `RunNotFoundError` si no existe. No libera el worktree.
   */
  cancel(runId: RunId): void;
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
   * pierde. Un gate no necesita nada: su corrida sigue parked. Devuelve cuántos pasos tocó.
   */
  recover(): number;
  /** Deja de despachar y espera a los pasos en curso. */
  close(): Promise<void>;
}

/** `start` rechazó el pedido (flujo o perfil que no existen, params inválidos): no se creó nada y el mensaje dice qué cambiar. */
export class RunStartError extends Error {}

/** La corrida pedida no existe. */
export class RunNotFoundError extends Error {
  constructor(runId: RunId) {
    super(`No existe la corrida ${runId}.`);
  }
}

/** El `reason` del abort de los pasos de una corrida cancelada. */
class RunCanceled extends Error {
  constructor(runId: RunId) {
    super(`La corrida ${runId} se canceló.`);
  }
}

/** Un cierre con un attempt que ya no es el vigente: otro dueño tomó el paso y este resultado se descarta. */
class StaleStepError extends Error {}

/** Cómo terminó una ejecución, antes de decidir qué hace el motor con ella. */
type Settled =
  /** Un outcome del nodo, o `error`/`timeout`/`skipped`: sigue su edge. `notes` son las `decisions` del reporte del agente. */
  | { kind: "outcome"; outcome: string; output?: unknown; error?: string; notes?: Note[] }
  /** Una excepción: se reintenta según `retry`. */
  | { kind: "failed"; error: string }
  /** Falló el entorno, no el paso: vuelve a pending sin gastar intento. */
  | { kind: "deferred"; error: string; notBefore: number }
  /** Un parallel que abrió sus ramas: el padre espera y lo cierra la transacción de la última rama. */
  | { kind: "waiting" };

/** Una nota que el agente dejó en su reporte (`Report.decisions`). */
interface Note {
  title: string;
  body: string;
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

export function createEngine(deps: EngineDeps): Engine {
  const { store, defs, agents, artifacts, actions, consolidators, waits, workspaceOf, briefFor, now = Date.now } = deps;
  const maxAgents = deps.maxAgents ?? DEFAULT_MAX_AGENTS;
  const probeEveryMs = (deps.probeEverySec ?? DEFAULT_PROBE_EVERY_SEC) * 1000;
  const bootId = deps.bootId ?? newId("boot");
  const flowCache = new Map<string, FlowDef>();
  const inFlight = new Set<Promise<void>>();
  /** Cuándo toca el próximo sondeo de cada wait de este proceso. Sin entrada (tras un reinicio), toca ya. */
  const nextProbeAt = new Map<StepRunId, number>();
  /** El abort de cada paso que este proceso ejecuta, para que `cancel` lo interrumpa. */
  const controllers = new Map<StepRunId, AbortController>();
  const probing = new Set<StepRunId>();
  let activeAgents = 0;
  let lastWakeAt = now();
  let ticker: NodeJS.Timeout | undefined;
  let closed = false;

  function flowOf(run: RunRow): FlowDef {
    const key = `${run.flowDefId}@${run.flowVersion}`;
    let flow = flowCache.get(key);
    if (!flow) {
      const def = defs.get("flow", run.flowDefId, run.flowVersion);
      if (!def) throw new Error(`La corrida ${run.id} apunta a un flujo que ya no existe (${key}).`);
      flow = FlowDef.parse(def.body);
      flowCache.set(key, flow);
    }
    return flow;
  }

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
      const unsupported = flows.flatMap((f) =>
        Object.entries(f.nodes).flatMap(([nodeId, n]) => {
          const types: [string, string][] = [[nodeId, n.type]];
          if (n.type === "parallel" && !Array.isArray(n.branches)) types.push([`${nodeId}.branch`, n.branches.branch.type]);
          return types.filter(([, type]) => type === "gate").map(([id, type]) => `${f === flow ? "" : `${f.id}.`}${id} (${type})`);
        }),
      );
      if (unsupported.length > 0) {
        throw new RunStartError(
          `El flujo "${flowSlug}" usa nodos que el motor todavía no ejecuta: ${unsupported.join(", ")}. Solo agent, action, wait, parallel y flow.`,
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
      throw new RunStartError(describe(error), { cause: error });
    }
    return params;
  }

  /**
   * El flujo y los subflujos que llama, también los de sus subflujos: lo que la corrida fija al
   * empezar. Así una corrida hija parte de las versiones del padre aunque el flujo cambie después.
   */
  function pinCalls(root: FlowDef, repoId: string | undefined): { flows: FlowDef[]; subflows: Record<string, DefPin> } {
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

  /** Crea la corrida con su primer paso en pending y emite `run.started`. */
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
    },
  ): RunRow {
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
        status: "running",
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
      origin: "core",
      ...scopeOf(run),
      payload: {
        runId: run.id,
        flow: `${n.def.slug}@${n.def.version}`,
        subject: n.subject,
        lane: run.lane,
        ...(n.parent && { parentRunId: n.parent.runId }),
      },
    });
    return run;
  }

  function insertStep(
    tx: Tx,
    run: RunRow,
    nodeId: string,
    at: { visit: number; round: number; prev?: StepRunId },
  ): void {
    tx.db
      .insert(stepRuns)
      .values({
        id: newId("stp"),
        runId: run.id,
        nodeId,
        visit: at.visit,
        round: at.round,
        status: "pending",
        prevStepRunId: at.prev,
      })
      .run();
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
      parkUnloadable(run, step, describe(error));
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
      sweepChildren();
      dispatch();
    } catch (error) {
      // Un wake que lanza tumbaría a quien lo llamó (un `start`, el cierre de otro paso, un timer).
      console.error("El dispatcher de flujos falló:", error);
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
      const isAgent = planned.node.type === "agent";
      if (isAgent && activeAgents >= maxAgents) continue;
      const leased = lease(step);
      if (!leased) continue;
      if (isAgent) activeAgents++;
      const job = execute({ ...planned, step: leased }).finally(() => {
        if (isAgent) activeAgents--;
        inFlight.delete(job);
        wake();
      });
      inFlight.add(job);
    }
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
        tx.db.update(runs).set({ status: "parked", parkReason: "needs_human" }).where(eq(runs.id, run.id)).run();
        tx.emit({ type: "run.parked", origin: "core", ...scopeOf(run, step.id), payload: { reason: "needs_human" } });
      });
    } catch (cause) {
      console.error(`No se pudo estacionar la corrida ${run.id}, que no se puede cargar (${error}):`, cause);
    }
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

  async function execute(job: Job): Promise<void> {
    const controller = new AbortController();
    controllers.set(job.step.id, controller);
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
        settled = await perform(job, controller);
      } catch (error) {
        if (error instanceof StaleStepError) throw error;
        settled = { kind: "failed", error: describe(error) };
      }
      if (settled.kind !== "waiting") settle(job, settled);
    } catch (error) {
      if (error instanceof StaleStepError) return;
      console.error(`No se pudo cerrar el paso ${job.step.id} (${job.step.nodeId}):`, error);
      parkAfterFailure(job, describe(error));
    } finally {
      clearInterval(renew);
      controllers.delete(job.step.id);
    }
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
        parkUnloadable(run, step, describe(error));
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

  async function perform(job: Job, controller: AbortController): Promise<Settled> {
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
        : resolveRefs(node.type === "agent" ? node.brief : node.type === "action" || node.type === "wait" ? node.args : null, resolve);
    const inputHash = artifacts.put(JSON.stringify(input), "brief", { mime: "application/json" });
    artifacts.ref(inputHash, { type: "step_run", id: step.id, role: "input" });
    markRunning(job, inputHash);
    // En un wait `timeoutSec` es el plazo de la espera (`deadline`), no un límite a esta ejecución.
    if (node.type === "wait") return enterWait(job, node.event, input);

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
    if (!args.success) return permanent(`Los args de "${node.action}" no son válidos: ${formatIssues(args.error)}`);

    const key = `${run.id}:${step.nodeId}:${step.visit}`;
    const ctx: ActionCtx = { runId: run.id, stepId: step.id, key, signal, once: (stage, fn) => once(key, stage, fn) };
    let result;
    try {
      result = await raceAbort(action.run(args.data, ctx), signal);
    } catch (error) {
      if (signal.reason instanceof StepTimeout) return timedOut(signal.reason);
      return error instanceof PermanentActionError ? permanent(error.message) : { kind: "failed", error: describe(error) };
    }
    if (!action.outcomes.includes(result.outcome)) {
      return permanent(`La acción "${node.action}" devolvió el outcome "${result.outcome}", que no declara (${action.outcomes.join(", ")}).`);
    }
    const output = action.output?.safeParse(result.output);
    if (output && !output.success) {
      return permanent(`El output de "${node.action}" no cumple su esquema: ${formatIssues(output.error)}`);
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

    const briefRun: Brief["run"] = { id: run.id, subject: { type: run.subjectType, id: run.subjectId }, round: step.round, attempt: step.attempt };
    const brief: Brief = briefFor
      ? await briefFor({ run: briefRun, nodeId: step.nodeId, visit: step.visit, mode: node.mode, payload, lineage: lineage(run) })
      : { run: briefRun, worktree: workspace.path, base: workspace.base, mode: node.mode, artifacts: {}, payload };
    const placement = {
      profile: profile.slug,
      profileDef,
      stepRunId: step.id,
      projectId: run.projectId ?? undefined,
      signal,
      notice: step.error === RESUMED_AFTER_CUT ? CUT_NOTICE : undefined,
    };
    // Una sesión que el corte dejó `running` se retoma; sin ella (el corte llegó antes de que el runtime
    // le diera id) empieza una nueva con el mismo brief.
    const cutSession = placement.notice === undefined ? undefined : unfinishedSession(step.id);
    const result = cutSession
      ? await agents.resume({ ...placement, sessionId: cutSession, mode: node.mode, brief })
      : await agents.run({
          ...placement,
          role: node.role,
          roleDef,
          mode: node.mode,
          brief,
          workspace: workspace.path,
          resumeFrom: node.resumeFrom === undefined ? undefined : priorSession(run, node.resumeFrom),
        });
    if (signal.reason instanceof StepTimeout) return timedOut(signal.reason);
    return fromAgentResult(result);
  }

  function fromAgentResult(result: AgentResult): Settled {
    switch (result.status) {
      case "success":
        return { kind: "outcome", outcome: result.report.outcome, output: result.report.payload, notes: result.report.decisions };
      case "error":
        return { kind: "failed", error: result.message };
      case "login_expired":
      case "quota_exhausted":
        return { kind: "deferred", error: result.message, notBefore: result.resetsAt ?? now() + ENVIRONMENT_BACKOFF_MS };
      case "error_max_turns":
      case "error_max_budget_usd":
      case "report_invalid":
        return permanent(result.message);
    }
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

  /** El worktree que tiene tomada la corrida o, si es un subflujo, el de quien la llamó. */
  function workspaceFor(run: RunRow): { path: string; base: string } | undefined {
    for (const id of lineage(run)) {
      const held = workspaceOf?.(id);
      if (held) return held;
    }
    return undefined;
  }

  function lastDoneInLineage(run: RunRow, nodeId: string): StepRow | undefined {
    for (const id of lineage(run)) {
      const found = lastDone(id, nodeId);
      if (found) return found;
    }
    return undefined;
  }

  /** La corrida y sus padres hasta la raíz: lo que un subflujo comparte con quien lo llamó (workspace, nodos, sesiones). */
  function lineage(run: RunRow): RunId[] {
    const ids = [run.id];
    for (let parent = run.parentRunId; parent !== null; ) {
      ids.push(parent);
      parent = store.db.select({ parent: runs.parentRunId }).from(runs).where(eq(runs.id, parent)).get()?.parent ?? null;
    }
    return ids;
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

  function resolveRef(run: RunRow, step: StepRow, ref: string): unknown {
    const [head = "", ...path] = refPath(ref);
    let root: unknown;
    switch (head) {
      case "run":
        root = { id: run.id, subject: { type: run.subjectType, id: run.subjectId }, params: run.params };
        break;
      case "prev":
        root = step.prevStepRunId === null ? null : outputOf(selectStep(step.prevStepRunId));
        break;
      case "item": {
        const inline = parseInlineBranch(step.nodeId);
        root = inline && itemsOf(parallelStepOf(run.id, inline.parent))[inline.index];
        break;
      }
      case "self":
        root = outputOf(lastDone(run.id, step.nodeId, step.visit));
        break;
      default:
        // "En la corrida o en sus padres": un subflujo ve los nodos de quien lo llamó.
        root = outputOf(lastDoneInLineage(run, head));
    }
    return shrink(step, navigate(root, path));
  }

  function selectStep(id: StepRunId): StepRow | undefined {
    return store.db.select().from(stepRuns).where(eq(stepRuns.id, id)).get();
  }

  /** `$nodo` es el output del último paso terminado de ese nodo; con `beforeVisit`, el de una visita anterior. */
  function lastDone(runId: RunId, nodeId: string, beforeVisit?: number): StepRow | undefined {
    return store.db
      .select()
      .from(stepRuns)
      .where(
        and(
          eq(stepRuns.runId, runId),
          eq(stepRuns.nodeId, nodeId),
          eq(stepRuns.status, "done"),
          beforeVisit === undefined ? undefined : lt(stepRuns.visit, beforeVisit),
        ),
      )
      .orderBy(desc(stepRuns.visit))
      .limit(1)
      .get();
  }

  function outputOf(step: StepRow | undefined): unknown {
    return readArtifact(step?.outputHash);
  }

  function readArtifact(hash: ArtifactHash | null | undefined): unknown {
    if (!hash) return undefined;
    const artifact = artifacts.get(hash);
    if (!artifact) throw new Error(`Falta el artefacto ${hash}.`);
    return JSON.parse(new TextDecoder().decode(artifact.content));
  }

  /** Un valor grande no viaja en el brief: se guarda como artefacto y el brief recibe su referencia. */
  function shrink(step: StepRow, value: unknown): unknown {
    const json = JSON.stringify(value);
    if (json === undefined) return value;
    const size = Buffer.byteLength(json);
    if (size <= OUTPUT_INLINE_MAX_BYTES) return value;
    const hash = artifacts.put(json, "report", { mime: "application/json" });
    artifacts.ref(hash, { type: "step_run", id: step.id, role: "input" });
    return { artifact: hash, size };
  }

  // --- cierre de un paso -----------------------------------------------------------------------

  function settle(job: Job, settled: Settled): void {
    switch (settled.kind) {
      case "outcome": {
        const outputHash =
          settled.output === undefined
            ? undefined
            : artifacts.put(JSON.stringify(settled.output), "report", { mime: "application/json" });
        if (outputHash) artifacts.ref(outputHash, { type: "step_run", id: job.step.id, role: "output" });
        transition(job, settled.outcome, outputHash, settled.error, settled.notes);
        return;
      }
      case "failed": {
        const policy = retryOf(job.node);
        // Ni un corte ni una espera del entorno gastan intento.
        const spent = job.step.attempt - job.step.recoveries - job.step.deferrals;
        if (spent > policy.max) return transition(job, "error", undefined, settled.error);
        const wait = policy.backoffSec[Math.min(spent, policy.backoffSec.length) - 1] ?? 0;
        return requeue(job, settled.error, now() + wait * 1000, false);
      }
      case "deferred":
        return requeue(job, settled.error, settled.notBefore, true);
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
    notes?: Note[],
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
      if (!parallel || !parent) return advance(tx, run, step, node, outcome, outputHash, error, notes);

      closeStep(tx, run, step, { status: failed ? "failed" : "done", outcome, outputHash, message: error, notes });
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
    notes?: Note[],
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
      notes,
    });

    if (!taken) {
      tx.db.update(runs).set({ status: "parked", parkReason: "needs_human" }).where(eq(runs.id, run.id)).run();
      tx.emit({ type: "run.parked", origin: "core", ...scopeOf(run, step.id), payload: { reason: "needs_human" } });
      return;
    }

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
      /** Las notas del reporte del agente. */
      notes?: Note[];
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
      .where(and(eq(stepRuns.id, step.id), eq(stepRuns.attempt, step.attempt), inArray(stepRuns.status, ["leased", "running", "waiting"])))
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
    // Notas que no bloquean: la corrida sigue por su edge, el humano las ve en la bandeja.
    const scope = scopeOf(run, step.id);
    if (closing.note !== undefined) {
      const body = `Al cerrar el paso "${step.nodeId}" con el outcome "${closing.outcome}".`;
      openNote(tx, { ...scope, kind: "review_note", title: closing.note, body });
    }
    for (const note of closing.notes ?? []) openNote(tx, { ...scope, kind: "review_note", ...note });
    if (cost > 0) {
      tx.db.update(runs).set({ costMicros: sql`${runs.costMicros} + ${cost}` }).where(eq(runs.id, run.id)).run();
    }
    return cost;
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
    if (!args.success) return permanent(`Los args de "${event}" no son válidos: ${formatIssues(args.error)}`);

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
          closeWaiting(waiting, permanent(`El match de "${input.wait.name}" falló: ${describe(error)}`));
          continue;
        }
        if (found) closeWaiting(waiting, fromWaitResult(input.wait, found));
      }
    }
    wake();
  }

  /** Los waits que esperan en corridas activas. */
  function waitingSteps(): Job[] {
    return store.db
      .select({ step: stepRuns, run: runs })
      .from(stepRuns)
      .innerJoin(runs, eq(stepRuns.runId, runs.id))
      .where(and(eq(stepRuns.status, "waiting"), isNotNull(stepRuns.waitKey), eq(runs.status, "running")))
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
      return { ok: false, error: describe(error) };
    }
    const args = wait.args.safeParse(saved);
    if (!args.success) return { ok: false, error: `Los args de "${job.node.event}" no son válidos: ${formatIssues(args.error)}` };
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
      parkAfterFailure(job, describe(error));
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
        noteProbeError(job, describe(error));
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
      if (!args.success) return { kind: "done", outcome: "error", error: `Los args de "${name}" no son válidos: ${formatIssues(args.error)}` };
      const byBranch = Object.fromEntries(ran.map((s) => [s.key, { outcome: s.outcome ?? "", output: readArtifact(s.outputHash) }]));
      const result = consolidator.run(byBranch, args.data);
      if (result.outcome !== "error" && !consolidator.outcomes.includes(result.outcome)) {
        throw new Error(`devolvió el outcome "${result.outcome}", que no declara (${consolidator.outcomes.join(", ")})`);
      }
      const outputHash = artifacts.put(JSON.stringify(result.output), "report", { mime: "application/json" });
      artifacts.ref(outputHash, { type: "step_run", id: parent.id, role: "output" });
      return { kind: "done", outcome: result.outcome, outputHash };
    } catch (error) {
      return { kind: "done", outcome: "error", error: `El consolidador "${name}" falló: ${describe(error)}` };
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

  /** La visita del parallel que espera a sus ramas. */
  function parallelStepOf(runId: RunId, nodeId: string): StepRow {
    const step = store.db
      .select()
      .from(stepRuns)
      .where(and(eq(stepRuns.runId, runId), eq(stepRuns.nodeId, nodeId), eq(stepRuns.status, "waiting")))
      .orderBy(desc(stepRuns.visit))
      .limit(1)
      .get();
    if (!step) throw new Error(`El parallel "${nodeId}" de la corrida ${runId} no está esperando a sus ramas.`);
    return step;
  }

  /** La lista que resolvió el forEach del parallel, guardada como su input. */
  function itemsOf(parent: StepRow): unknown[] {
    const list = readArtifact(parent.inputHash);
    if (!Array.isArray(list)) throw new Error(`El parallel ${parent.id} no guardó la lista de su forEach.`);
    return list;
  }

  /** Una rama que ya dio ok (o se saltó) no se relanza con `rerun: "not-ok"`. */
  const isOk = (step: StepRow | undefined) => step?.status === "done" && (step.outcome === "ok" || step.outcome === "skipped");

  function latestStep(runId: RunId, nodeId: string): StepRow | undefined {
    return store.db
      .select()
      .from(stepRuns)
      .where(and(eq(stepRuns.runId, runId), eq(stepRuns.nodeId, nodeId)))
      .orderBy(desc(stepRuns.visit))
      .limit(1)
      .get();
  }

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
      return permanent(describe(error));
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
      if (!step || !parent || parent.status !== "running") continue;
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

  /**
   * En una sola transacción cancela la corrida y sus descendientes vivos, y después aborta lo que
   * este proceso tiene en vuelo: un cierre de esos pasos ya no calza con su attempt y se descarta.
   */
  function cancel(runId: RunId): void {
    const stepIds = store.tx((tx) => {
      if (!tx.db.select({ id: runs.id }).from(runs).where(eq(runs.id, runId)).get()) throw new RunNotFoundError(runId);
      const family = [runId];
      for (const id of family) {
        family.push(...tx.db.select({ id: runs.id }).from(runs).where(eq(runs.parentRunId, id)).all().map((r) => r.id));
      }
      const canceled: StepRunId[] = [];
      for (const run of tx.db.select().from(runs).where(and(inArray(runs.id, family), inArray(runs.status, LIVE_RUN_STATUSES))).all()) {
        const steps = tx.db
          .update(stepRuns)
          .set({ status: "canceled", error: `La corrida ${runId} se canceló.`, owner: null, leaseUntil: null, notBefore: null })
          .where(and(eq(stepRuns.runId, run.id), inArray(stepRuns.status, ["pending", "leased", "running", "waiting"])))
          .returning({ id: stepRuns.id })
          .all();
        canceled.push(...steps.map((s) => s.id));
        const endedAt = now();
        tx.db.update(runs).set({ status: "canceled", parkReason: null, endedAt }).where(eq(runs.id, run.id)).run();
        recordRunMetrics(tx, run.id);
        tx.emit({
          type: "run.finished",
          origin: "core",
          ...scopeOf(run),
          payload: { outcome: "canceled", costMicros: run.costMicros, minutes: (endedAt - run.startedAt) / 60_000 },
        });
      }
      return canceled;
    });
    for (const id of stepIds) {
      nextProbeAt.delete(id);
      controllers.get(id)?.abort(new RunCanceled(runId));
    }
    wake();
  }

  // --- lectura ---------------------------------------------------------------------------------

  function viewOf(run: RunRow): RunSummary {
    const flow = defs.get("flow", run.flowDefId, run.flowVersion);
    return {
      id: run.id,
      projectId: run.projectId,
      parentRunId: run.parentRunId,
      flow: { slug: flow?.slug ?? run.flowDefId, version: run.flowVersion },
      subject: { type: run.subjectType, id: run.subjectId },
      lane: run.lane,
      status: run.status,
      parkReason: run.parkReason,
      outcome: run.outcome,
      params: run.params,
      rounds: run.rounds,
      costMicros: run.costMicros,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
    };
  }

  function getRun(runId: RunId): RunView {
    const run = store.db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!run) throw new RunNotFoundError(runId);
    const steps = store.db.select().from(stepRuns).where(eq(stepRuns.runId, runId)).orderBy(asc(stepRuns.id)).all();
    const { times, usage, workspace } = readRunDetail(store, runId, steps.map((s) => s.id));
    return {
      ...viewOf(run),
      steps: steps.map(({ id, nodeId, visit, round, attempt, status, outcome, outputHash, error, notBefore, waitKey, deadline, costMicros }) => ({
        id, nodeId, visit, round, attempt, status, outcome, outputHash, error, notBefore, waitKey, deadline, costMicros,
        startedAt: times.get(id)?.startedAt ?? null,
        endedAt: times.get(id)?.endedAt ?? null,
      })),
      flowDef: flowOf(run),
      workspace,
      usage,
    };
  }

  function listRuns({ projectId, status }: { projectId?: ProjectId; status?: readonly RunRow["status"][] } = {}) {
    return store.db
      .select()
      .from(runs)
      .where(
        and(
          projectId === undefined ? undefined : eq(runs.projectId, projectId),
          status === undefined ? undefined : inArray(runs.status, [...status]),
        ),
      )
      .orderBy(desc(runs.id))
      .all()
      .map(viewOf);
  }

  async function close(): Promise<void> {
    closed = true;
    clearInterval(ticker);
    await Promise.all(inFlight);
  }

  return { start, signal, cancel, getRun, listRuns, recover, close };
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((i) => `${i.path.length === 0 ? "(raíz)" : i.path.map(String).join(".")}: ${i.message}`).join("; ");
}
