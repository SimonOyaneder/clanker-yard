import type { ArtifactHash, ProjectId, RepoId, RunId, StepRunId } from "@clanker/api";
import { FlowDef } from "@clanker/api";
import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import type { Artifacts } from "../artifacts/artifacts";
import { isRecord, type Defs } from "../defs/defs";
import { runs, stepRuns } from "../store/schema";
import type { Store } from "../store/store";
import type { EngineDeps, RunSummary, RunView } from "./engine";
import { parseInlineBranch } from "./parallel";
import { navigate, refPath } from "./refs";
import { readRunDetail } from "./run-detail";

// Lo que el motor lee de una corrida sin cambiarla: el flujo que fijó, su linaje de subflujos, los outputs de
// sus pasos, los refs (`$nodo`, `$prev`, `$item`...) y las vistas de `getRun` y `listRuns`. Nada de aquí toca
// el estado del dispatcher; `shrink` solo agrega un artefacto.

type RunRow = typeof runs.$inferSelect;
type StepRow = typeof stepRuns.$inferSelect;

/** Un valor resuelto de más de esto no entra al brief: va a artifacts y el brief recibe `{ artifact, size }`. */
export const OUTPUT_INLINE_MAX_BYTES = 16 * 1024;

/** La corrida pedida no existe. */
export class RunNotFoundError extends Error {
  constructor(runId: RunId) {
    super(`No existe la corrida ${runId}.`);
  }
}

export function createRunReads({ store, defs, artifacts, workspaceOf }: { store: Store; defs: Defs; artifacts: Artifacts; workspaceOf: EngineDeps["workspaceOf"] }) {
  const flowCache = new Map<string, FlowDef>();

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

  /** El worktree que tiene tomada la corrida o, si es un subflujo, el de quien la llamó. */
  function workspaceFor(run: RunRow): { path: string; base: string; repoId?: RepoId } | undefined {
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
        root = withLiveToken(run, outputOf(lastDoneInLineage(run, head)));
    }
    return shrink(step, navigate(root, path));
  }

  /** El output de `workspace.acquire` guarda el token con que se tomó el worktree: si un préstamo lo subió, el vigente es el que tiene la corrida. */
  function withLiveToken(run: RunRow, value: unknown): unknown {
    if (!isRecord(value) || typeof value.workspaceId !== "string" || typeof value.fencingToken !== "number") return value;
    for (const id of lineage(run)) {
      const held = workspaceOf?.(id);
      if (held?.workspaceId === value.workspaceId && held.fencingToken !== undefined) return { ...value, fencingToken: held.fencingToken };
    }
    return value;
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

  function latestStep(runId: RunId, nodeId: string): StepRow | undefined {
    return store.db
      .select()
      .from(stepRuns)
      .where(and(eq(stepRuns.runId, runId), eq(stepRuns.nodeId, nodeId)))
      .orderBy(desc(stepRuns.visit))
      .limit(1)
      .get();
  }

  function viewOf(run: RunRow): RunSummary {
    const flow = defs.get("flow", run.flowDefId, run.flowVersion);
    return {
      id: run.id,
      projectId: run.projectId,
      parentRunId: run.parentRunId,
      borrowedFromRunId: run.borrowedFromRunId,
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

  return { flowOf, workspaceFor, lastDoneInLineage, lineage, resolveRef, selectStep, lastDone, outputOf, readArtifact, shrink, parallelStepOf, itemsOf, latestStep, viewOf, getRun, listRuns };
}
