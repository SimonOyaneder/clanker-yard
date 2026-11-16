import { open } from "node:fs/promises";
import {
  COMMAND_OUTPUT_MAX_CHARS,
  Report,
  type StepArtifact,
  type StepCommand,
  type StepDetail,
  type StepRunId,
  type StepSession,
} from "@clanker/api";
import { and, asc, eq, inArray, like, or } from "drizzle-orm";
import { agentSessions, artifactRefs, artifacts, defs, stepRuns, stepUsage } from "../store/schema";
import type { Store } from "../store/store";
import { stepLogPath } from "../workspaces/exec";
import { NotFoundError } from "../errors/domain";

/** Cuánto del final de un log se lee: un test que imprime megas no pasa por la memoria del core. */
const LOG_TAIL_BYTES = 4 * 1024 * 1024;

export class StepNotFoundError extends NotFoundError {
  constructor(stepId: StepRunId) {
    super(`No existe el paso ${stepId}.`);
  }
}

export interface StepDetails {
  /** Lo que el panel de un paso muestra y `getRun` no trae. Lanza `StepNotFoundError` si no existe. */
  get(stepId: StepRunId): Promise<StepDetail>;
}

export function createStepDetails({ store, logDir }: { store: Store; logDir: string }): StepDetails {
  const { db } = store;

  function sessionsOf(stepId: StepRunId): StepSession[] {
    // Un resume que reusa la sesión la deja con el paso original: sus pasos siguientes la ven por `step_usage`.
    const used = db.select({ id: stepUsage.sessionId }).from(stepUsage).where(eq(stepUsage.stepRunId, stepId));
    return db
      .select({ session: agentSessions, role: defs.slug })
      .from(agentSessions)
      .innerJoin(defs, eq(defs.id, agentSessions.roleDefId))
      .where(or(eq(agentSessions.stepRunId, stepId), inArray(agentSessions.id, used)))
      .orderBy(asc(agentSessions.startedAt), asc(agentSessions.id))
      .all()
      .map(({ session: s, role }) => ({
        id: s.id as StepSession["id"],
        runtime: s.runtime,
        sessionRef: s.sessionRef,
        role,
        model: s.model,
        effort: s.effort,
        status: s.status,
        error: s.error,
        turns: s.turns,
        usage: { input: s.tokensIn, output: s.tokensOut, cacheRead: s.tokensCacheRead, cacheWrite: s.tokensCacheWrite },
        costMicros: s.costMicros,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        report: s.report === null ? null : Report.parse(s.report),
      }));
  }

  /** Lo que el paso guardó él mismo y los archivos de su ronda que dejó el brief (`r<ronda>/…`, dueño: la corrida). */
  function artifactsOf(step: { id: StepRunId; runId: string; round: number }): StepArtifact[] {
    return db
      .select({ hash: artifacts.hash, name: artifactRefs.role, kind: artifacts.kind, mime: artifacts.mime, size: artifacts.size })
      .from(artifactRefs)
      .innerJoin(artifacts, eq(artifacts.hash, artifactRefs.hash))
      .where(
        or(
          and(eq(artifactRefs.ownerType, "step_run"), eq(artifactRefs.ownerId, step.id)),
          and(eq(artifactRefs.ownerType, "run"), eq(artifactRefs.ownerId, step.runId), like(artifactRefs.role, `r${step.round}/%`)),
        ),
      )
      .orderBy(asc(artifactRefs.role))
      .all();
  }

  return {
    async get(stepId) {
      const step = db.select({ id: stepRuns.id, runId: stepRuns.runId, round: stepRuns.round }).from(stepRuns).where(eq(stepRuns.id, stepId)).get();
      if (!step) throw new StepNotFoundError(stepId);
      return {
        id: stepId,
        sessions: sessionsOf(stepId),
        artifacts: artifactsOf(step),
        commands: await commandsOf(stepLogPath(logDir, step.runId, stepId)),
      };
    },
  };
}

async function commandsOf(path: string): Promise<StepCommand[]> {
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const { size } = await file.stat();
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    return parseCommandLog(buffer.toString("utf8"));
  } finally {
    await file.close();
  }
}

/** `$ comando`, su salida y el pie `[exit N]` o `[terminó por señal]`; sin pie, el comando sigue corriendo. */
const COMMAND_BLOCK = /^\$ (.*)\n([\s\S]*?)\[(?:exit (-?\d+)|terminó por ([^\]\n]+))\]\n\n/gm;
const RUNNING_BLOCK = /^\$ (.*)\n([\s\S]*)$/m;

export function parseCommandLog(log: string): StepCommand[] {
  const commands: StepCommand[] = [];
  let consumed = 0;
  for (const match of log.matchAll(COMMAND_BLOCK)) {
    const [whole, command, output, exit, killedBy] = match;
    commands.push({ command: command!, ...clipOutput(output!), exitCode: exit === undefined ? null : Number(exit), killedBy: killedBy ?? null });
    consumed = match.index + whole.length;
  }
  const running = RUNNING_BLOCK.exec(log.slice(consumed));
  if (running) commands.push({ command: running[1]!, ...clipOutput(running[2]!), exitCode: null, killedBy: null });
  return commands;
}

function clipOutput(output: string): { output: string; truncated: boolean } {
  const text = output.replace(/\n$/, "");
  return text.length <= COMMAND_OUTPUT_MAX_CHARS
    ? { output: text, truncated: false }
    : { output: text.slice(-COMMAND_OUTPUT_MAX_CHARS), truncated: true };
}
