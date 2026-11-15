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
import { and, eq, sql } from "drizzle-orm";
import * as z from "zod";
import type { Defs } from "../defs/defs";
import type { Packs } from "../packs/packs";
import { newId } from "../store/conventions";
import { agentSessions, agentTurns, stepUsage, type DefPin } from "../store/schema";
import type { Store, Tx } from "../store/store";
import { createContextResolver, type ContextResolver } from "./context";
import { estimateCostMicros } from "./pricing";
import type { AgentEvent, AgentRun, AgentRuntime, ResumeSpec, RunResult, RunSpec, RunStatus, Usage } from "./runtime";

/** Una diferencia mayor a este porcentaje entre la suma de los turnos y el total del runtime queda como evento `error`. */
export const USAGE_MISMATCH_PERCENT = 2;

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
  /** Un aviso del core que va antes de las instrucciones del modo (p. ej. que la app se reinició). */
  notice?: string;
}

export interface RunRequest extends Placement {
  /** Slug de la def `role`. */
  role: string;
  /** La versión del rol que fijó la corrida; sin ella rige la vigente. */
  roleDef?: DefPin;
  /** La entrada del perfil que pone modelo, effort y topes; por defecto la del rol (un flujo puede pedir otra, la de escalada). */
  profileRole?: string;
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
  /** Para `conventions.context` del pack de la org del repo; sin él no hay convenciones. */
  packs?: Packs;
  /** El `owner/name` de GitHub de un repo; su org elige el pack. */
  remoteOf?: (repoId: string) => string | null | undefined;
  /** Dónde se buscan `skill:` y `rule:`; por defecto el `~/.claude` del usuario. */
  userDir?: string;
}

/** El mismo esquema que valida el reporte, hecho JSON Schema; el outcome y el payload los pone el modo. */
const reportEnvelope = z.toJSONSchema(Report) as JsonSchema & { properties: Record<string, unknown> };

export function createAgents({ store, defs, runtime, now = Date.now, packs, remoteOf, userDir }: AgentsOptions): Agents {
  defs.register("role", Role);
  defs.register("profile", Profile);
  const context: ContextResolver = createContextResolver({ defs, packs, remoteOf, userDir });

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
    /** Lo resuelto al lanzar: el reintento por un reporte inválido lo reusa en vez de releerlo. */
    context: Pick<ResumeSpec, "native" | "references">;
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

  /** Lo que falta de las fuentes de contexto avisa en la corrida y no detiene al agente. */
  async function resolveContext(req: RunRequest | ResumeRequest, roleSlug: string, role: Role, cwd: string) {
    const resolved = await context.resolve({ role: roleSlug, sources: role.context, cwd, repoId: req.repoId });
    if (resolved.warnings.length > 0) {
      store.tx((tx) => {
        for (const message of resolved.warnings) {
          tx.emit({
            type: "error",
            origin: "core",
            ...scope({ placement: req, runId: req.brief.run.id }),
            payload: { scope: "agent.context", message },
          });
        }
      });
    }
    return { native: resolved.native, references: resolved.references };
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
    const profileRole = resolveProfileRole(req, req.profileRole ?? req.role);
    const budget = budgetOf(mode, profileRole.budget);
    const resolved = await resolveContext(req, req.role, role, req.workspace);

    const spec: RunSpec = {
      role: req.role,
      cwd: req.workspace,
      systemPrompt: role.prompt,
      prompt: promptFor(mode, req.brief, req.notice),
      model: profileRole.model,
      effort: profileRole.effort,
      cacheTtl: profileRole.cacheTtl,
      ...resolved,
      hooks: role.hooks ?? false,
      tools: role.tools ?? "all",
      outputSchema: outputSchemaFor(mode),
      ...budget,
      stepRunId: req.stepRunId,
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
        context: resolved,
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
    const resolved = await resolveContext(req, roleDef.slug, role, session.cwd);

    const agentRun = await runtime.resume(
      { runtime: runtime.id, sessionId: session.sessionRef, cwd: session.cwd },
      promptFor(mode, req.brief, req.notice),
      { outputSchema: outputSchemaFor(mode), ...budget, ...resolved, stepRunId: req.stepRunId },
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
        context: resolved,
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
      {
        outputSchema: outputSchemaFor(conversation.mode),
        ...conversation.budget,
        ...conversation.context,
        stepRunId: conversation.placement.stepRunId,
      },
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
    const turns = emptyUsage();

    // Esperar a `observe` también con `result` rechazado: un turno que llega después de `end` no se cuenta.
    const [observed, finished] = await Promise.allSettled([
      observe(c, sessionId, agentRun, turns),
      agentRun.result,
    ]);
    let result: RunResult;
    if (observed.status === "fulfilled" && finished.status === "fulfilled") {
      result = finished.value;
    } else {
      const reason: unknown =
        finished.status === "rejected" ? finished.reason : observed.status === "rejected" ? observed.reason : undefined;
      result = {
        status: "error",
        text: "",
        usage: emptyUsage(),
        message: `El runtime falló: ${reason instanceof Error ? reason.message : String(reason)}`,
      };
    }
    lastActivity.delete(sessionId);

    if (result.status !== "success") {
      const message = result.message ?? `El runtime terminó con ${result.status}.`;
      end(c, sessionId, result.status, result.usage, turns, { error: message });
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
      end(c, sessionId, "report_invalid", result.usage, turns, { error: checked.problem });
      return { kind: "invalid", sessionId, problem: checked.problem };
    }
    end(c, sessionId, "success", result.usage, turns, { report: checked.report });
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

  /** `turns` acumula lo que ya se registró turno a turno; `end` lo reconcilia con el total del runtime. */
  async function observe(c: Conversation, sessionId: string, agentRun: AgentRun, turns: Usage): Promise<void> {
    for await (const event of agentRun.events) {
      if (event.type === "usage") {
        store.tx((tx) => recordTurn(tx, c, sessionId, event, turns));
        continue;
      }
      if (event.type === "error") {
        // `login_expired` y `quota_exhausted` también llegan en el resultado, que es lo que decide el paso.
        if (event.kind === "other") {
          store.tx((tx) =>
            tx.emit({ type: "error", origin: "core", ...scope(c), payload: { scope: "agent.runtime", message: event.message } }),
          );
        }
        continue;
      }
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

  /**
   * Guarda el turno y lo suma a los totales de la sesión en la misma tx. Con `costPerTurn` el USD es
   * el del runtime; si no, sale de `model_prices` y la sesión queda `estimate` hasta que `end` reciba el total.
   */
  function recordTurn(
    tx: Tx,
    c: Conversation,
    sessionId: string,
    event: Extract<AgentEvent, { type: "usage" }>,
    turns: Usage,
  ): void {
    const { usage } = event;
    const ts = now();
    const session = tx.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get();
    if (!session) throw new Error(`Desapareció la sesión ${sessionId}.`);
    const model = event.model ?? session.model;
    const tokens = {
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      tokensCacheRead: usage.tokensCacheRead,
      tokensCacheWrite: usage.tokensCacheWrite,
      tokensCacheWrite1h: event.cacheWrite1hTokens ?? 0,
    };
    // Un resume que reusa la sesión sigue la cuenta: la fila ya cuenta los turnos de antes.
    const seq = session.turns + 1;

    let costMicros = usage.costMicros;
    if (!runtime.capabilities.costPerTurn) {
      const estimated = estimateCostMicros(tx.db, model, ts, tokens);
      if (estimated === undefined) {
        tx.emit({
          type: "error",
          origin: "core",
          ...scope(c),
          payload: {
            scope: "agent.usage",
            message: `No hay precio en model_prices para el modelo "${model}": el turno ${seq} de la sesión ${sessionId} quedó con costo 0.`,
          },
        });
      }
      costMicros = estimated ?? 0;
    }

    tx.db.insert(agentTurns).values({ sessionId, seq, ts, model, ...tokens, costMicros }).run();
    addStepUsage(tx, c, sessionId, tokens.tokensIn + tokens.tokensOut + tokens.tokensCacheRead + tokens.tokensCacheWrite, costMicros);
    tx.db
      .update(agentSessions)
      .set({
        turns: seq,
        tokensIn: session.tokensIn + tokens.tokensIn,
        tokensOut: session.tokensOut + tokens.tokensOut,
        tokensCacheRead: session.tokensCacheRead + tokens.tokensCacheRead,
        tokensCacheWrite: session.tokensCacheWrite + tokens.tokensCacheWrite,
        costMicros: session.costMicros + costMicros,
        costSource: runtime.capabilities.costPerTurn ? usage.costSource : "estimate",
      })
      .where(eq(agentSessions.id, sessionId))
      .run();
    tx.emit({
      type: "agent.usage",
      origin: "core",
      ...scope(c),
      payload: {
        sessionId,
        turn: seq,
        tokens: {
          in: tokens.tokensIn,
          out: tokens.tokensOut,
          cacheRead: tokens.tokensCacheRead,
          cacheWrite: tokens.tokensCacheWrite,
        },
        costMicros,
      },
    });
    turns.turns += 1;
    turns.tokensIn += tokens.tokensIn;
    turns.tokensOut += tokens.tokensOut;
    turns.tokensCacheRead += tokens.tokensCacheRead;
    turns.tokensCacheWrite += tokens.tokensCacheWrite;
    turns.costMicros += costMicros;
  }

  /** Suma lo consumido al paso que corría; un resume con el mismo id de sesión lo cuenta en el paso que lo pidió. */
  function addStepUsage(tx: Tx, c: Conversation, sessionId: string, tokens: number, costMicros: number): void {
    const { stepRunId } = c.placement;
    if (stepRunId === undefined) return;
    tx.db
      .insert(stepUsage)
      .values({ stepRunId, sessionId, tokens, costMicros })
      .onConflictDoUpdate({
        target: [stepUsage.stepRunId, stepUsage.sessionId],
        set: { tokens: sql`${stepUsage.tokens} + ${tokens}`, costMicros: sql`${stepUsage.costMicros} + ${costMicros}` },
      })
      .run();
  }

  /**
   * Cierra la sesión. El total del runtime (`total_cost_usd` menos lo que la sesión ya traía) manda
   * sobre las estimaciones por turno: se suma solo la diferencia con lo que `recordTurn` ya sumó. Si el
   * runtime no lo sabe (el run se cortó antes de su `result`) quedan las estimaciones.
   */
  function end(
    c: Conversation,
    sessionId: string,
    status: (typeof agentSessions.$inferSelect)["status"],
    reported: Usage,
    turns: Usage,
    outcome: { report?: Report; error?: string },
  ): void {
    const runtimeKnowsTotal = reported.costMicros > 0;
    const spent = runtimeKnowsTotal ? reported : turns;
    store.tx((tx) => {
      const row = tx.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get();
      if (!row) throw new Error(`Desapareció la sesión ${sessionId}.`);
      tx.db
        .update(agentSessions)
        .set({
          status,
          report: outcome.report ?? null,
          error: outcome.error ?? null,
          turns: row.turns + spent.turns - turns.turns,
          tokensIn: row.tokensIn + spent.tokensIn - turns.tokensIn,
          tokensOut: row.tokensOut + spent.tokensOut - turns.tokensOut,
          tokensCacheRead: row.tokensCacheRead + spent.tokensCacheRead - turns.tokensCacheRead,
          tokensCacheWrite: row.tokensCacheWrite + spent.tokensCacheWrite - turns.tokensCacheWrite,
          costMicros: row.costMicros + spent.costMicros - turns.costMicros,
          costSource: runtimeKnowsTotal ? reported.costSource : row.costSource,
          endedAt: now(),
        })
        .where(eq(agentSessions.id, sessionId))
        .run();
      const tokensOf = (u: Usage) => u.tokensIn + u.tokensOut + u.tokensCacheRead + u.tokensCacheWrite;
      addStepUsage(tx, c, sessionId, tokensOf(spent) - tokensOf(turns), spent.costMicros - turns.costMicros);
      if (runtimeKnowsTotal && turns.turns > 0) {
        const gap = Math.abs(reported.costMicros - turns.costMicros);
        if (gap * 100 > reported.costMicros * USAGE_MISMATCH_PERCENT) {
          tx.emit({
            type: "error",
            origin: "core",
            ...scope(c),
            payload: {
              scope: "agent.usage",
              message: `La suma de los turnos de la sesión ${sessionId} (${turns.costMicros} micros) difiere más de ${USAGE_MISMATCH_PERCENT}% del total del runtime (${reported.costMicros} micros).`,
            },
          });
        }
      }
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

function emptyUsage(): Usage {
  return {
    turns: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    costMicros: 0,
    costSource: "runtime",
  };
}

function scope(c: { placement: Placement; runId: Brief["run"]["id"] }) {
  return { projectId: c.placement.projectId, runId: c.runId, stepRunId: c.placement.stepRunId };
}

/** Las instrucciones del modo y el brief van en el mensaje: el prompt de sistema queda fijo. */
function promptFor(mode: RoleMode, brief: Brief, notice?: string): string {
  const message = `${mode.instructions}\n\n${JSON.stringify(brief, null, 2)}`;
  return notice === undefined ? message : `${notice}\n\n${message}`;
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
