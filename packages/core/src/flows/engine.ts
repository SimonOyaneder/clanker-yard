import {
  FlowDef,
  type ArtifactHash,
  type Brief,
  type Node,
  type ProjectId,
  type RunId,
  type StepRunId,
  type SubjectRef,
} from "@clanker/api";
import { and, asc, desc, eq, inArray, isNull, lt, lte, max, or, sql, sum } from "drizzle-orm";
import type { AgentResult, Agents } from "../agents/agents";
import type { Artifacts } from "../artifacts/artifacts";
import type { Defs } from "../defs/defs";
import { newId } from "../store/conventions";
import { actionEffects, agentSessions, runs, stepRuns, type DefPin } from "../store/schema";
import type { Store, Tx } from "../store/store";
import type { ActionCtx, ActionDef, RetryPolicy } from "./catalog";
import { edgeFor, edgesOf, maxRoundsOf, takeEdge } from "./edges";
import { isTruthy, navigate, refPath, resolveRefs } from "./refs";
import { LANE_BY_TRIGGER } from "./validate";

/** El lease de un paso: el core dueño lo renueva cada tercio mientras el paso vive. */
const STEP_LEASE_TTL_MS = 120_000;
export const TICK_MS = 5000;
export const DEFAULT_MAX_AGENTS = 4;
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
  costMicros: number;
}

export interface RunView {
  id: RunId;
  flow: { slug: string; version: number };
  subject: SubjectRef;
  lane: RunRow["lane"];
  status: RunRow["status"];
  parkReason: RunRow["parkReason"];
  /** `done`, `blocked` o `failed` cuando la corrida terminó. */
  outcome: string | null;
  params: Record<string, unknown>;
  /** Contador → veces que se tomó. */
  rounds: Record<string, number>;
  costMicros: number;
  startedAt: number;
  endedAt: number | null;
  /** En el orden en que se crearon. */
  steps: StepView[];
}

export interface EngineDeps {
  store: Store;
  defs: Defs;
  agents: Agents;
  artifacts: Artifacts;
  actions: ReadonlyMap<string, ActionDef>;
  /** El worktree de la corrida (el que tiene tomado), donde corren sus agentes. */
  workspaceOf?: (runId: RunId) => { path: string; base: string } | undefined;
  /** Tope global de agentes a la vez. */
  maxAgents?: number;
  tickMs?: number;
  /** Identifica a este core como dueño de los leases. */
  bootId?: string;
  now?: () => number;
}

export interface Engine {
  /**
   * Lanza `flow` (slug) sobre `subject`. Idempotente: si ya hay una corrida viva de ese flujo sobre
   * ese sujeto devuelve su id sin mirar `params`. La corrida fija la versión del flujo, de sus roles
   * y del perfil. Falla, sin crear nada, si faltan params o los maxRounds apuntan a un valor inválido.
   */
  start(flow: string, subject: SubjectRef, params?: Record<string, unknown>, opts?: StartOptions): RunId;
  getRun(runId: RunId): RunView;
  /** Deja de despachar y espera a los pasos en curso. */
  close(): Promise<void>;
}

/** Un cierre con un attempt que ya no es el vigente: otro dueño tomó el paso y este resultado se descarta. */
class StaleStepError extends Error {}

/** Cómo terminó una ejecución, antes de decidir qué hace el motor con ella. */
type Settled =
  /** Un outcome del nodo, o `error`/`timeout`/`skipped`: sigue su edge. */
  | { kind: "outcome"; outcome: string; output?: unknown; error?: string }
  /** Una excepción: se reintenta según `retry`. */
  | { kind: "failed"; error: string }
  /** Falló el entorno, no el paso: vuelve a pending sin gastar intento. */
  | { kind: "deferred"; error: string; notBefore: number };

interface Job {
  run: RunRow;
  /** Con el attempt de este lease. */
  step: StepRow;
  flow: FlowDef;
  node: Node;
}

export function createEngine(deps: EngineDeps): Engine {
  const { store, defs, agents, artifacts, actions, workspaceOf, now = Date.now } = deps;
  const maxAgents = deps.maxAgents ?? DEFAULT_MAX_AGENTS;
  const bootId = deps.bootId ?? newId("boot");
  const flowCache = new Map<string, FlowDef>();
  const inFlight = new Set<Promise<void>>();
  let activeAgents = 0;
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

  function nodeOf(flow: FlowDef, id: string): Node {
    const node = flow.nodes[id];
    if (!node) throw new Error(`El flujo "${flow.id}" no tiene el nodo "${id}".`);
    return node;
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
      if (!def) throw new Error(`No existe el flujo "${flowSlug}".`);
      const live = tx.db
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.flowDefId, def.id),
            eq(runs.subjectType, subject.type),
            eq(runs.subjectId, subject.id),
            inArray(runs.status, LIVE_RUN_STATUSES),
          ),
        )
        .get();
      if (live) return live.id;

      const flow = FlowDef.parse(def.body);
      const unsupported = Object.entries(flow.nodes).filter(([, n]) => n.type !== "agent" && n.type !== "action");
      if (unsupported.length > 0) {
        const list = unsupported.map(([nodeId, n]) => `${nodeId} (${n.type})`).join(", ");
        throw new Error(`El flujo "${flowSlug}" usa nodos que el motor todavía no ejecuta: ${list}. Solo agent y action.`);
      }
      const params = effectiveParams(flow, given);
      for (const node of Object.values(flow.nodes)) {
        for (const edge of edgesOf(node)) maxRoundsOf(edge, params);
      }

      const roles: Record<string, DefPin> = {};
      for (const node of Object.values(flow.nodes)) {
        if (node.type !== "agent" || roles[node.role]) continue;
        const role = defs.resolve("role", node.role, { repoId: opts.repoId });
        if (!role) throw new Error(`El flujo "${flowSlug}" usa el rol "${node.role}", que no existe.`);
        roles[node.role] = { id: role.id, version: role.version };
      }
      let profile: DefPin | undefined;
      if (opts.profile !== undefined) {
        const found = defs.resolve("profile", opts.profile, { repoId: opts.repoId });
        if (!found) throw new Error(`No existe el perfil "${opts.profile}".`);
        profile = { id: found.id, version: found.version };
      } else if (Object.keys(roles).length > 0) {
        throw new Error(`El flujo "${flowSlug}" tiene pasos agent: pasa el perfil con que corre.`);
      }

      const run = tx.db
        .insert(runs)
        .values({
          id: newId("run"),
          projectId: opts.projectId,
          subjectType: subject.type,
          subjectId: subject.id,
          flowDefId: def.id,
          flowVersion: def.version,
          profileDefId: profile?.id,
          profileVersion: profile?.version,
          roles,
          lane: flow.lane ?? LANE_BY_TRIGGER[flow.trigger.type] ?? "dev",
          status: "running",
          writes: flow.effects !== "local",
          params,
          rounds: {},
          startedAt: now(),
        })
        .returning()
        .get();
      insertStep(tx, run, flow.start, { visit: 1, round: 0 });
      tx.emit({
        type: "run.started",
        origin: "core",
        ...scopeOf(run),
        payload: { runId: run.id, flow: `${def.slug}@${def.version}`, subject, lane: run.lane },
      });
      return run.id;
    });
    wake();
    return id;
  }

  /** Los defaults del flujo pisados por lo que pasa quien lo lanza. Un param sin default es obligatorio. */
  function effectiveParams(flow: FlowDef, given: Record<string, unknown>): Record<string, unknown> {
    const declared = flow.params ?? {};
    const unknown = Object.keys(given).filter((name) => !Object.hasOwn(declared, name));
    if (unknown.length > 0) {
      throw new Error(`El flujo "${flow.id}" no declara los params: ${unknown.join(", ")}.`);
    }
    const params: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(declared)) {
      if (Object.hasOwn(given, name)) params[name] = given[name];
      else if (typeof spec === "object") params[name] = spec.default;
      else throw new Error(`Falta el param "${name}" del flujo "${flow.id}".`);
    }
    return params;
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

  /** Despierta al dispatcher: lo llaman cada transición y el tick de 5 s (backoff vencido). */
  function wake(): void {
    if (closed) return;
    ticker ??= setInterval(wake, deps.tickMs ?? TICK_MS).unref();
    try {
      dispatch();
    } catch (error) {
      // Un wake que lanza tumbaría a quien lo llamó (un `start`, el cierre de otro paso, un timer).
      console.error("El dispatcher de flujos falló:", error);
    }
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
      const flow = flowOf(run);
      const node = nodeOf(flow, step.nodeId);
      const isAgent = node.type === "agent";
      if (isAgent && activeAgents >= maxAgents) continue;
      const leased = lease(step);
      if (!leased) continue;
      if (isAgent) activeAgents++;
      const job = execute({ run, step: leased, flow, node }).finally(() => {
        if (isAgent) activeAgents--;
        inFlight.delete(job);
        wake();
      });
      inFlight.add(job);
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
    // Un timer no lanza: si el latido falla, se interrumpe el paso en vez de dejarlo corriendo sin lease.
    const renew = setInterval(() => {
      try {
        store.tx((tx) =>
          tx.db
            .update(stepRuns)
            .set({ leaseUntil: now() + STEP_LEASE_TTL_MS })
            .where(and(eq(stepRuns.id, job.step.id), eq(stepRuns.attempt, job.step.attempt)))
            .run(),
        );
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
      settle(job, settled);
    } catch (error) {
      if (error instanceof StaleStepError) return;
      console.error(`No se pudo cerrar el paso ${job.step.id} (${job.step.nodeId}):`, error);
      parkAfterFailure(job, describe(error));
    } finally {
      clearInterval(renew);
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

  // --- ejecución de un paso --------------------------------------------------------------------

  async function perform(job: Job, controller: AbortController): Promise<Settled> {
    const { run, step, node } = job;
    const resolve = (ref: string) => resolveRef(run, step, ref);
    if (node.when !== undefined && !isTruthy(resolveRefs(node.when, resolve))) {
      return { kind: "outcome", outcome: "skipped" };
    }
    const input = resolveRefs(node.type === "agent" ? node.brief : node.type === "action" ? node.args : null, resolve);
    const inputHash = artifacts.put(JSON.stringify(input), "brief", { mime: "application/json" });
    artifacts.ref(inputHash, { type: "step_run", id: step.id, role: "input" });
    markRunning(job, inputHash);

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
      return signal.reason instanceof StepTimeout ? timedOut(signal.reason) : { kind: "failed", error: describe(error) };
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
    const workspace = workspaceOf?.(run.id);
    if (!workspace) return permanent(`El paso "${step.nodeId}" es un agente y la corrida no tiene un workspace tomado.`);
    const roleDef = run.roles[node.role];
    const profileDef = run.profileDefId !== null && run.profileVersion !== null ? { id: run.profileDefId, version: run.profileVersion } : undefined;
    const profile = profileDef && defs.get("profile", profileDef.id, profileDef.version);
    if (!roleDef || !profile) return permanent(`La corrida no fijó el rol "${node.role}" o su perfil.`);

    const brief: Brief = {
      run: { id: run.id, subject: { type: run.subjectType, id: run.subjectId }, round: step.round, attempt: step.attempt },
      worktree: workspace.path,
      base: workspace.base,
      mode: node.mode,
      artifacts: {},
      payload,
    };
    const result = await agents.run({
      role: node.role,
      roleDef,
      profile: profile.slug,
      profileDef,
      mode: node.mode,
      brief,
      workspace: workspace.path,
      stepRunId: step.id,
      projectId: run.projectId ?? undefined,
      signal,
      resumeFrom: node.resumeFrom === undefined ? undefined : priorSession(run.id, node.resumeFrom),
    });
    if (signal.reason instanceof StepTimeout) return timedOut(signal.reason);
    return fromAgentResult(result);
  }

  function fromAgentResult(result: AgentResult): Settled {
    switch (result.status) {
      case "success":
        return { kind: "outcome", outcome: result.report.outcome, output: result.report.payload };
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

  /** La última sesión de un paso terminado de ese nodo, para que `resumeFrom` parta de ella. */
  function priorSession(runId: RunId, nodeId: string): string | undefined {
    return store.db
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .innerJoin(stepRuns, eq(agentSessions.stepRunId, stepRuns.id))
      .where(and(eq(stepRuns.runId, runId), eq(stepRuns.nodeId, nodeId), eq(stepRuns.status, "done")))
      .orderBy(desc(agentSessions.id))
      .limit(1)
      .get()?.id;
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
      case "self":
        root = outputOf(lastDone(run.id, step.nodeId, step.visit));
        break;
      default:
        root = outputOf(lastDone(run.id, head));
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
    if (!step?.outputHash) return undefined;
    const artifact = artifacts.get(step.outputHash);
    if (!artifact) throw new Error(`Falta el artefacto ${step.outputHash}, el output del paso ${step.id}.`);
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
        transition(job, settled.outcome, outputHash, settled.error);
        return;
      }
      case "failed": {
        const policy = retryOf(job.node);
        if (job.step.attempt > policy.max) return transition(job, "error", undefined, settled.error);
        const wait = policy.backoffSec[Math.min(job.step.attempt, policy.backoffSec.length) - 1] ?? 0;
        return requeue(job, settled.error, now() + wait * 1000, job.step.attempt);
      }
      case "deferred":
        return requeue(job, settled.error, settled.notBefore, job.step.attempt - 1);
    }
  }

  function retryOf(node: Node): RetryPolicy {
    if (node.retry) return node.retry;
    if (node.type === "action") return actions.get(node.action)?.retry ?? DEFAULT_ACTION_RETRY;
    return DEFAULT_AGENT_RETRY;
  }

  /** El paso vuelve a pending con su backoff; `attempt` es lo que queda gastado. */
  function requeue(job: Job, error: string, notBefore: number, attempt: number): void {
    store.tx((tx) => {
      const requeued = tx.db
        .update(stepRuns)
        .set({ status: "pending", notBefore, attempt, error, owner: null, leaseUntil: null })
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
   */
  function transition(job: Job, outcome: string, outputHash: ArtifactHash | undefined, error: string | undefined): void {
    const { step, node } = job;
    store.tx((tx) => {
      const run = tx.db.select().from(runs).where(eq(runs.id, step.runId)).get();
      if (!run) throw new Error(`Desapareció la corrida ${step.runId}.`);
      const cost = Number(
        tx.db.select({ total: sum(agentSessions.costMicros) }).from(agentSessions).where(eq(agentSessions.stepRunId, step.id)).get()?.total ?? 0,
      );
      const edge = edgeFor(node, outcome);
      const taken = edge === undefined ? undefined : takeEdge(edge, `${step.nodeId}.${outcome}`, run.rounds, run.params);
      const message = error ?? (taken ? undefined : `el nodo "${step.nodeId}" no tiene edge para el outcome "${outcome}"`);

      const closed = tx.db
        .update(stepRuns)
        .set({
          status: taken ? "done" : "failed",
          outcome,
          outputHash,
          error: message ?? null,
          costMicros: cost,
          owner: null,
          leaseUntil: null,
          notBefore: null,
        })
        .where(and(eq(stepRuns.id, step.id), eq(stepRuns.attempt, step.attempt), inArray(stepRuns.status, ["leased", "running"])))
        .returning({ id: stepRuns.id })
        .get();
      if (!closed) throw new StaleStepError(step.id);
      tx.emit({
        type: "step.finished",
        origin: "core",
        ...scopeOf(run, step.id),
        payload: {
          ...stepPayload(step),
          outcome,
          outputHash: outputHash ?? null,
          costMicros: cost,
          ...(message === undefined ? {} : { error: message }),
          ...(taken?.note === undefined ? {} : { note: taken.note }),
        },
      });

      const totals = { costMicros: run.costMicros + cost };
      if (!taken) {
        tx.db.update(runs).set({ ...totals, status: "parked", parkReason: "needs_human" }).where(eq(runs.id, run.id)).run();
        tx.emit({ type: "run.parked", origin: "core", ...scopeOf(run, step.id), payload: { reason: "needs_human" } });
        return;
      }

      const rounds = taken.counter ? { ...run.rounds, [taken.counter.key]: taken.counter.count } : run.rounds;
      if (taken.to.startsWith("@")) {
        const endedAt = now();
        const result = taken.to.slice(1);
        tx.db
          .update(runs)
          .set({ ...totals, rounds, status: result === "done" ? "done" : "failed", outcome: result, endedAt })
          .where(eq(runs.id, run.id))
          .run();
        tx.emit({
          type: "run.finished",
          origin: "core",
          ...scopeOf(run),
          payload: { outcome: result, costMicros: totals.costMicros, minutes: (endedAt - run.startedAt) / 60_000 },
        });
        return;
      }

      tx.db.update(runs).set({ ...totals, rounds }).where(eq(runs.id, run.id)).run();
      const last = tx.db
        .select({ visit: max(stepRuns.visit) })
        .from(stepRuns)
        .where(and(eq(stepRuns.runId, run.id), eq(stepRuns.nodeId, taken.to)))
        .get();
      insertStep(tx, run, taken.to, { visit: (last?.visit ?? 0) + 1, round: taken.round, prev: step.id });
    });
  }

  // --- lectura ---------------------------------------------------------------------------------

  function getRun(runId: RunId): RunView {
    const run = store.db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!run) throw new Error(`No existe la corrida ${runId}.`);
    const flow = defs.get("flow", run.flowDefId, run.flowVersion);
    const steps = store.db.select().from(stepRuns).where(eq(stepRuns.runId, runId)).orderBy(asc(stepRuns.id)).all();
    return {
      id: run.id,
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
      steps: steps.map(({ id, nodeId, visit, round, attempt, status, outcome, outputHash, error, notBefore, costMicros }) => ({
        id, nodeId, visit, round, attempt, status, outcome, outputHash, error, notBefore, costMicros,
      })),
    };
  }

  async function close(): Promise<void> {
    closed = true;
    clearInterval(ticker);
    await Promise.all(inFlight);
  }

  return { start, getRun, close };
}

class StepTimeout extends Error {
  constructor(readonly timeoutSec: number) {
    super(`El paso superó su timeoutSec de ${timeoutSec} s.`);
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((i) => `${i.path.length === 0 ? "(raíz)" : i.path.map(String).join(".")}: ${i.message}`).join("; ");
}
