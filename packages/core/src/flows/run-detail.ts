import type { RunId, RunUsage, RunWorkspace, StepRunId } from "@clanker/api";
import { eq, inArray } from "drizzle-orm";
import { agentSessions, repos, stepUsage, workspaces } from "../store/schema";
import type { Store } from "../store/store";

export interface StepTimes {
  startedAt: number | null;
  endedAt: number | null;
}

/**
 * Lo que `getRun` suma a las filas de la corrida y no está en ellas: cuándo arrancó y cerró cada paso
 * (de sus eventos, así que un reintento cuenta desde el primer arranque), los tokens de sus sesiones
 * de agente y el worktree que tomó.
 */
export function readRunDetail(store: Store, runId: RunId, stepIds: readonly StepRunId[]) {
  const times = new Map<StepRunId, StepTimes>();
  const events = store.events.since(0, { runId, types: ["step.started", "step.waiting", "step.finished", "lease.acquired"] });
  let workspaceId: string | undefined;
  for (const e of events) {
    if (e.type === "lease.acquired") {
      if (e.payload.resource === "workspace" && typeof e.payload.id === "string") workspaceId = e.payload.id;
      continue;
    }
    if (!e.stepRunId) continue;
    const t = times.get(e.stepRunId) ?? { startedAt: null, endedAt: null };
    if (e.type === "step.finished") t.endedAt = e.ts;
    else t.startedAt ??= e.ts;
    times.set(e.stepRunId, t);
  }

  return { times, usage: usageOf(store, stepIds), workspace: workspaceOf(store, workspaceId) };
}

function usageOf(store: Store, stepIds: readonly StepRunId[]): RunUsage {
  const total: RunUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  if (stepIds.length === 0) return total;
  // Un resume que reusa la sesión la comparte entre pasos: se suma una vez por sesión.
  const sessionIds = store.db.selectDistinct({ id: stepUsage.sessionId }).from(stepUsage).where(inArray(stepUsage.stepRunId, [...stepIds])).all();
  if (sessionIds.length === 0) return total;
  const sessions = store.db
    .select()
    .from(agentSessions)
    .where(inArray(agentSessions.id, sessionIds.map((s) => s.id)))
    .all();
  for (const s of sessions) {
    total.input += s.tokensIn;
    total.output += s.tokensOut;
    total.cacheRead += s.tokensCacheRead;
    total.cacheWrite += s.tokensCacheWrite;
  }
  return total;
}

function workspaceOf(store: Store, workspaceId: string | undefined): RunWorkspace | null {
  if (!workspaceId) return null;
  const row = store.db
    .select({ branch: workspaces.branch, base: workspaces.baseRef, repo: repos.name })
    .from(workspaces)
    .innerJoin(repos, eq(repos.id, workspaces.repoId))
    .where(eq(workspaces.id, workspaceId))
    .get();
  return row ?? null;
}
