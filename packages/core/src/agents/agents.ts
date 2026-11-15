import {
  Brief,
  compileJsonSchema,
  Profile,
  type ProjectId,
  Report,
  Role,
  type JsonSchema,
  type RoleMode,
  type StepRunId,
} from "@clanker/api";
import { and, eq } from "drizzle-orm";
import * as z from "zod";
import type { Defs } from "../defs/defs";
import { newId } from "../store/conventions";
import { agentSessions, type DefPin } from "../store/schema";
import type { Store } from "../store/store";
import type { AgentRun, AgentRuntime, ResumeSpec, RunResult, RunSpec, RunStatus, Usage } from "./runtime";

/** `agent.activity` sale como máximo una vez por este intervalo y por sesión. */
export const ACTIVITY_INTERVAL_MS = 2000;

/** Dónde corre y a quién le cuenta lo que pasa. */
interface Placement {
  /** Slug de la def `profile` que pone modelo, effort y topes. */
  profile: string;
  /** La versión del perfil que fijó la corrida; sin ella rige la vigente. */
  profileDef?: DefPin;
  /** Para resolver defs con scope `repo`. */
  repoId?: string;
  stepRunId?: StepRunId;
  projectId?: ProjectId;
  /** Al abortarse, la sesión se interrumpe y el resultado llega como el de un runtime que terminó mal. */
  signal?: AbortSignal;
}

export interface RunRequest extends Placement {
  /** Slug de la def `role`. */
  role: string;
  /** La versión del rol que fijó la corrida; sin ella rige la vigente. */
  roleDef?: DefPin;
  mode: string;
  brief: Brief;
  /** El directorio donde corre el agente. */
  workspace: string;
  /**
   * Una sesión anterior de la que partir. Que se retome o no lo decide el modo: con `session: "new"`
   * se ignora y la sesión es nueva.
   */
  resumeFrom?: string;
}

export interface ResumeRequest extends Placement {
  sessionId: string;
  /** El modo del mensaje: define las instrucciones y el esquema del reporte. */
  mode: string;
  brief: Brief;
}

export type AgentResult =
  | { status: "success"; sessionId: string; report: Report }
  | {
      /** `report_invalid`: ni el reintento entregó un reporte que cumpla el esquema del modo. */
      status: Exclude<RunStatus, "success"> | "report_invalid";
      sessionId: string;
      message: string;
      resetsAt?: number;
    };

export interface Agents {
  /** Lanza una sesión nueva. Termina cuando el agente terminó y su reporte quedó validado y guardado. */
  run(request: RunRequest): Promise<AgentResult>;
  /**
   * Retoma una sesión con las instrucciones y el brief de `mode`. El modelo y el effort son los
   * de la sesión: cambiarlos invalida la caché.
   */
  resume(request: ResumeRequest): Promise<AgentResult>;
}

export interface AgentsOptions {
  store: Store;
  defs: Defs;
  runtime: AgentRuntime;
  now?: () => number;
}

/** El mismo esquema que valida el reporte, hecho JSON Schema; el outcome y el payload los pone el modo. */
const reportEnvelope = z.toJSONSchema(Report) as JsonSchema & { properties: Record<string, unknown> };

export function createAgents({ store, defs, runtime, now = Date.now }: AgentsOptions): Agents {
  defs.register("role", Role);
  defs.register("profile", Profile);

  const lastActivity = new Map<string, number>();

  /** Todo lo que se necesita para llevar una sesión desde que parte hasta que entrega su reporte. */
  interface Conversation {
    roleDefId: string;
    roleVersion: number;
    roleSlug: string;
    model: string;
    effort: string | undefined;
    cwd: string;
    mode: RoleMode;
    budget: Pick<ResumeSpec, "maxBudgetUsd" | "maxTurns">;
    placement: Placement;
    runId: Brief["run"]["id"];
  }

  function resolveProfileRole(placement: Placement, roleSlug: string) {
    const def = placement.profileDef
      ? defs.get("profile", placement.profileDef.id, placement.profileDef.version)
      : defs.resolve("profile", placement.profile, { repoId: placement.repoId });
    if (!def) throw new Error(`No existe el perfil "${placement.profile}".`);
    const profileRole = Profile.parse(def.body).roles[roleSlug];
    if (!profileRole) {
      throw new Error(
        `El perfil "${placement.profile}" no define modelo para el rol "${roleSlug}": agrégalo en roles.`,
      );
    }
    return profileRole;
  }

  function pickMode(role: Role, roleSlug: string, modeName: string, brief: Brief): RoleMode {
    const mode = role.modes[modeName];
    if (!mode) {
      throw new Error(
        `El rol "${roleSlug}" no tiene el modo "${modeName}" (tiene: ${Object.keys(role.modes).join(", ")}).`,
      );
    }
    if (brief.mode !== modeName) {
      throw new Error(`El brief es del modo "${brief.mode}" pero se pidió el modo "${modeName}".`);
    }
    if (mode.payload) {
      const parsed = compileJsonSchema(mode.payload).safeParse(brief.payload);
      if (!parsed.success) {
        throw new Error(
          `El payload del brief no cumple el esquema del modo "${modeName}" del rol "${roleSlug}":\n${formatIssues(parsed.error)}`,
        );
      }
    }
    return mode;
  }

  /** El perfil pisa al modo campo por campo. */
  function budgetOf(mode: RoleMode, profileBudget: { maxTurns?: number; maxUsd?: number } = {}) {
    const { maxTurns, maxUsd } = { ...mode.budget, ...profileBudget };
    return { maxTurns, maxBudgetUsd: maxUsd };
  }

  async function run(req: RunRequest): Promise<AgentResult> {
    const roleDef = req.roleDef
      ? defs.get("role", req.roleDef.id, req.roleDef.version)
      : defs.resolve("role", req.role, { repoId: req.repoId });
    if (!roleDef) throw new Error(`No existe el rol "${req.role}".`);
    const role = Role.parse(roleDef.body);
    const mode = pickMode(role, req.role, req.mode, req.brief);
    if (req.resumeFrom !== undefined && mode.session !== "new") {
      return resume({ ...req, sessionId: req.resumeFrom });
    }
    const profileRole = resolveProfileRole(req, req.role);
    const budget = budgetOf(mode, profileRole.budget);

    const spec: RunSpec = {
      role: req.role,
      cwd: req.workspace,
      systemPrompt: role.prompt,
      prompt: promptFor(mode, req.brief),
      model: profileRole.model,
      effort: profileRole.effort,
      cacheTtl: profileRole.cacheTtl,
      context: role.context,
      hooks: role.hooks ?? false,
      tools: role.tools ?? "all",
      outputSchema: outputSchemaFor(mode),
      ...budget,
    };
    const agentRun = await runtime.start(spec);
    interruptOnAbort(req.signal, agentRun);
    return converse(
      {
        roleDefId: roleDef.id,
        roleVersion: roleDef.version,
        roleSlug: req.role,
        model: spec.model,
        effort: spec.effort,
        cwd: spec.cwd,
        mode,
        budget,
        placement: req,
        runId: req.brief.run.id,
      },
      agentRun,
      undefined,
    );
  }

  async function resume(req: ResumeRequest): Promise<AgentResult> {
    const session = store.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, req.sessionId))
      .get();
    if (!session) throw new Error(`No existe la sesión ${req.sessionId}.`);
    if (session.runtime !== runtime.id) {
      throw new Error(
        `La sesión ${req.sessionId} es del runtime "${session.runtime}" y el core corre con "${runtime.id}" (CORE_RUNTIME): abre una sesión nueva.`,
      );
    }
    const roleDef = defs.get("role", session.roleDefId, session.roleVersion);
    if (!roleDef) throw new Error(`La sesión ${req.sessionId} apunta a un rol que ya no existe.`);
    const role = Role.parse(roleDef.body);
    const mode = pickMode(role, roleDef.slug, req.mode, req.brief);
    const budget = budgetOf(mode, resolveProfileRole(req, roleDef.slug).budget);

    const agentRun = await runtime.resume(
      { runtime: runtime.id, sessionId: session.sessionRef, cwd: session.cwd },
      promptFor(mode, req.brief),
      { outputSchema: outputSchemaFor(mode), ...budget },
    );
    interruptOnAbort(req.signal, agentRun);
    return converse(
      {
        roleDefId: session.roleDefId,
        roleVersion: session.roleVersion,
        roleSlug: roleDef.slug,
        model: session.model,
        effort: session.effort ?? undefined,
        cwd: session.cwd,
        mode,
        budget,
        placement: req,
        runId: req.brief.run.id,
      },
      agentRun,
      session.id,
    );
  }

  /** Un reporte que no valida se reintenta una sola vez, retomando la misma sesión con el error. */
  async function converse(
    conversation: Conversation,
    first: AgentRun,
    resumedFrom: string | undefined,
  ): Promise<AgentResult> {
    const attempt = await settle(conversation, first, resumedFrom);
    if (attempt.kind !== "invalid") return attempt.result;

    const retry = await runtime.resume(
      first.ref,
      `tu reporte no cumple el esquema: ${attempt.problem}`,
      { outputSchema: outputSchemaFor(conversation.mode), ...conversation.budget },
    );
    const second = await settle(conversation, retry, attempt.sessionId);
    return second.kind === "invalid"
      ? {
          status: "report_invalid",
          sessionId: second.sessionId,
          message: `El reporte no cumple el esquema tras un reintento: ${second.problem}`,
        }
      : second.result;
  }

  type Settled =
    | { kind: "done"; result: AgentResult }
    | { kind: "invalid"; sessionId: string; problem: string };

  /** Deja una sesión registrada de principio a fin: fila, eventos, reporte validado. */
  async function settle(
    c: Conversation,
    agentRun: AgentRun,
    resumedFrom: string | undefined,
  ): Promise<Settled> {
    const sessionId = begin(c, agentRun, resumedFrom);

    let result: RunResult;
    try {
      const [, finished] = await Promise.all([
        observe(c, sessionId, agentRun),
        agentRun.result,
      ]);
      result = finished;
    } catch (error) {
      result = {
        status: "error",
        text: "",
        usage: ZERO_USAGE,
        message: `El runtime falló: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    lastActivity.delete(sessionId);

    if (result.status !== "success") {
      const message = result.message ?? `El runtime terminó con ${result.status}.`;
      end(c, sessionId, result.status, result.usage, { error: message });
      return {
        kind: "done",
        result: {
          status: result.status,
          sessionId,
          message,
          ...(result.resetsAt === undefined ? {} : { resetsAt: result.resetsAt }),
        },
      };
    }

    const checked = validateReport(c.mode, result.structured);
    if (!checked.ok) {
      end(c, sessionId, "report_invalid", result.usage, { error: checked.problem });
      return { kind: "invalid", sessionId, problem: checked.problem };
    }
    end(c, sessionId, "success", result.usage, { report: checked.report });
    return { kind: "done", result: { status: "success", sessionId, report: checked.report } };
  }

  /** Crea la fila (o reabre la existente si el runtime retoma con el mismo id) y emite `agent.started`. */
  function begin(c: Conversation, agentRun: AgentRun, resumedFrom: string | undefined): string {
    const { runtime: runtimeId, sessionId: sessionRef } = agentRun.ref;
    return store.tx((tx) => {
      const existing = tx.db
        .select()
        .from(agentSessions)
        .where(and(eq(agentSessions.runtime, runtimeId), eq(agentSessions.sessionRef, sessionRef)))
        .get();
      let id: string;
      if (existing) {
        id = existing.id;
        tx.db
          .update(agentSessions)
          .set({ status: "running", endedAt: null })
          .where(eq(agentSessions.id, id))
          .run();
      } else {
        id = newId("ses");
        tx.db
          .insert(agentSessions)
          .values({
            id,
            stepRunId: c.placement.stepRunId,
            roleDefId: c.roleDefId,
            roleVersion: c.roleVersion,
            runtime: runtimeId,
            sessionRef,
            resumedFrom,
            cwd: c.cwd,
            model: c.model,
            effort: c.effort,
            status: "running",
            startedAt: now(),
          })
          .run();
      }
      tx.emit({
        type: "agent.started",
        origin: "core",
        ...scope(c),
        payload: { sessionId: id, role: c.roleSlug, model: c.model },
      });
      return id;
    });
  }

  async function observe(c: Conversation, sessionId: string, agentRun: AgentRun): Promise<void> {
    for await (const event of agentRun.events) {
      if (event.type !== "tool_start") continue;
      const t = now();
      const last = lastActivity.get(sessionId);
      if (last !== undefined && t - last < ACTIVITY_INTERVAL_MS) continue;
      lastActivity.set(sessionId, t);
      store.tx((tx) =>
        tx.emit({
          type: "agent.activity",
          origin: "core",
          ...scope(c),
          payload: { sessionId, tool: event.tool, detail: event.detail },
        }),
      );
    }
  }

  /** Suma el uso de este run al de la fila: si el runtime retomó con el mismo id, es la misma fila. */
  function end(
    c: Conversation,
    sessionId: string,
    status: (typeof agentSessions.$inferSelect)["status"],
    usage: Usage,
    outcome: { report?: Report; error?: string },
  ): void {
    store.tx((tx) => {
      const row = tx.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get();
      if (!row) throw new Error(`Desapareció la sesión ${sessionId}.`);
      tx.db
        .update(agentSessions)
        .set({
          status,
          report: outcome.report ?? null,
          error: outcome.error ?? null,
          turns: row.turns + usage.turns,
          tokensIn: row.tokensIn + usage.tokensIn,
          tokensOut: row.tokensOut + usage.tokensOut,
          tokensCacheRead: row.tokensCacheRead + usage.tokensCacheRead,
          tokensCacheWrite: row.tokensCacheWrite + usage.tokensCacheWrite,
          costMicros: row.costMicros + usage.costMicros,
          costSource: usage.costSource,
          endedAt: now(),
        })
        .where(eq(agentSessions.id, sessionId))
        .run();
      tx.emit({
        type: "agent.ended",
        origin: "core",
        ...scope(c),
        payload: { sessionId, status },
      });
    });
  }

  return { run, resume };
}

/** Interrumpir es la forma de cancelar: el runtime resuelve `result` con lo que alcanzó a hacer. */
function interruptOnAbort(signal: AbortSignal | undefined, agentRun: AgentRun): void {
  if (!signal) return;
  const interrupt = () =>
    agentRun.interrupt().catch((error: unknown) => {
      console.error(`No se pudo interrumpir la sesión ${agentRun.ref.sessionId}:`, error);
    });
  if (signal.aborted) interrupt();
  else signal.addEventListener("abort", interrupt, { once: true });
}

const ZERO_USAGE: Usage = {
  turns: 0,
  tokensIn: 0,
  tokensOut: 0,
  tokensCacheRead: 0,
  tokensCacheWrite: 0,
  costMicros: 0,
  costSource: "runtime",
};

function scope(c: { placement: Placement; runId: Brief["run"]["id"] }) {
  return { projectId: c.placement.projectId, runId: c.runId, stepRunId: c.placement.stepRunId };
}

/** Las instrucciones del modo y el brief van en el mensaje: el prompt de sistema queda fijo. */
function promptFor(mode: RoleMode, brief: Brief): string {
  return `${mode.instructions}\n\n${JSON.stringify(brief, null, 2)}`;
}

function outputSchemaFor(mode: RoleMode): JsonSchema {
  return {
    ...reportEnvelope,
    properties: {
      ...reportEnvelope.properties,
      outcome: { type: "string", enum: mode.outcomes },
      payload: mode.report,
    },
  };
}

type Checked = { ok: true; report: Report } | { ok: false; problem: string };

function validateReport(mode: RoleMode, structured: unknown): Checked {
  if (structured === undefined || structured === null) {
    return { ok: false, problem: "el agente terminó sin devolver un reporte estructurado" };
  }
  const schema = Report.extend({
    outcome: z.enum(mode.outcomes as [string, ...string[]]),
    payload: compileJsonSchema(mode.report),
  });
  const parsed = schema.safeParse(structured);
  return parsed.success
    ? { ok: true, report: parsed.data }
    : { ok: false, problem: formatIssues(parsed.error) };
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.length === 0 ? "(raíz)" : i.path.map(String).join(".")}: ${i.message}`)
    .join("; ");
}
