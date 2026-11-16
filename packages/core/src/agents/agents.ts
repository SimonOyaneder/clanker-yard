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
import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import * as z from "zod";
import type { Defs } from "../defs/defs";
import { git } from "../git/git";
import type { Packs } from "../packs/packs";
import { newId } from "../store/conventions";
import { agentSessions, agentTurns, stepUsage, type DefPin } from "../store/schema";
import type { GitIdentityOf } from "../git/identity";
import type { Store, Tx } from "../store/store";
import { LEARNING_PROMPT } from "../learnings/criteria";
import { claudeSchemaError } from "./claude/report-schema";
import { createContextResolver, type ContextResolver } from "./context";
import { estimateCostMicros, minUsefulBudgetMicros, PREFIX_TOKENS, type TurnTokens } from "./pricing";
import type { AgentEvent, AgentRun, AgentRuntime, ResumeSpec, RunResult, RunSpec, RunStatus, Usage } from "./runtime";
import { issuesInline, messageOf } from "../errors/format";

/** Una diferencia mayor a este porcentaje entre la suma de los turnos y el total del runtime queda como evento `error`. */
export const USAGE_MISMATCH_PERCENT = 2;

const WARNED_RUNS_KEPT = 200;

/** `agent.activity` sale como máximo una vez por este intervalo y por sesión. */
export const ACTIVITY_INTERVAL_MS = 2000;

/** `resume-if-warm` retoma solo si el contexto de la sesión pesa menos que esto. */
export const WARM_MAX_CONTEXT_TOKENS = 80_000;

/**
 * `resume-if-warm` retoma solo si la última respuesta fue hace menos que esto: el TTL de la caché menos
 * un minuto de margen, para que la petición llegue antes de que venza.
 */
export const WARM_WINDOW_MS = { "5m": 4 * 60_000, "1h": 59 * 60_000 } as const;

/**
 * Lo más que una sesión espera el primer token de otra con su mismo prefijo. Pasado esto parte igual: una
 * sesión colgada antes de responder no puede frenar a todas las del mismo rol.
 */
export const PREFIX_WAIT_MS = 60_000;

/** El handoff de una sesión nueva en vez de retomar pesa unos 15k tokens (≈4 caracteres por token). */
export const HANDOFF_MAX_CHARS = 60_000;

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
   * Una sesión anterior de la que partir. Que se retome o no lo decide `session` del modo: `new` la
   * ignora; `resume` la retoma; `resume-if-warm` la retoma si su caché sigue caliente (menos de 4 min
   * desde su última respuesta con TTL de 5 m, y menos de 80k de contexto). Una sesión compactada o fría
   * no se retoma: la nueva lleva un handoff con el reporte de la anterior y el `git diff --stat`.
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
  /** La identidad de git del repo, para los commits que hace el agente; sin ella el runtime no configura autor. */
  identityOf?: GitIdentityOf;
  /** Por defecto `PREFIX_WAIT_MS`; los tests lo acortan. */
  prefixWaitMs?: number;
}

/** El mismo esquema que valida el reporte, hecho JSON Schema; el outcome y el payload los pone el modo. */
const reportEnvelope = z.toJSONSchema(Report) as JsonSchema & { properties: Record<string, unknown> };

/**
 * Un rol se valida también contra lo que Claude Code acepta: el reporte de cada modo tiene que compilar como su
 * `--json-schema`, o la sesión sale antes del primer turno. Vale para todo rol que se guarda (pack, repo o usuario).
 */
const RoleForClaude = Role.superRefine((role, ctx) => {
  for (const [name, mode] of Object.entries(role.modes)) {
    const problem = claudeSchemaError(outputSchemaFor(mode, true));
    if (problem !== undefined) {
      ctx.addIssue({ code: "custom", path: ["modes", name, "report"], message: `Claude Code no puede compilar el reporte de este modo: ${problem}` });
    }
  }
});

export function createAgents({ store, defs, runtime, now = Date.now, packs, remoteOf, userDir, identityOf, prefixWaitMs = PREFIX_WAIT_MS }: AgentsOptions): Agents {
  defs.register("role", RoleForClaude);
  defs.register("profile", Profile);
  const context: ContextResolver = createContextResolver({ defs, packs, remoteOf, userDir });

  const lastActivity = new Map<string, number>();
  /** Los avisos de contexto ya emitidos por corrida; se guardan las últimas `WARNED_RUNS_KEPT`. */
  const warnedContext = new Map<string, Set<string>>();

  /** Todo lo que se necesita para llevar una sesión desde que parte hasta que entrega su reporte. */
  interface Conversation {
    roleDefId: string;
    roleVersion: number;
    roleSlug: string;
    model: string;
    effort: string | undefined;
    cwd: string;
    mode: RoleMode;
    /** `mode.learnings`: solo entonces el reporte y el prompt traen learnings. */
    proposes: boolean;
    /** Topes y TTL de caché que salen del modo y del perfil. */
    settings: Pick<ResumeSpec, "maxBudgetUsd" | "maxTurns" | "cacheTtl">;
    /** Lo resuelto al lanzar: el reintento por un reporte inválido lo reusa en vez de releerlo. */
    context: Pick<ResumeSpec, "native" | "references">;
    placement: Placement;
    runId: Brief["run"]["id"];
    /** Avisa que el prefijo de esta sesión ya está en la caché; es idempotente. */
    prefixWarmed: () => void;
  }

  type SessionRow = typeof agentSessions.$inferSelect;

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
          `El payload del brief no cumple el esquema del modo "${modeName}" del rol "${roleSlug}":\n${issuesInline(parsed.error.issues)}`,
        );
      }
    }
    return mode;
  }

  /** El perfil pisa al modo campo por campo en los topes. */
  function settingsOf(
    mode: RoleMode,
    profileRole: { budget?: { maxTurns?: number; maxUsd?: number }; cacheTtl?: "5m" | "1h" },
  ) {
    const { maxTurns, maxUsd } = { ...mode.budget, ...profileRole.budget };
    return { maxTurns, maxBudgetUsd: maxUsd, cacheTtl: profileRole.cacheTtl };
  }

  function sessionOf(sessionId: string): SessionRow {
    const session = store.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get();
    if (!session) throw new Error(`No existe la sesión ${sessionId}.`);
    return session;
  }

  /**
   * Por qué una sesión no se retoma, o `undefined` si se puede. Una compactada ya no es el historial
   * completo, así que ninguna política la retoma. `resume-if-warm` además pide la caché caliente:
   * retomar en frío reescribe todo el contexto, y un handoff escribe mucho menos.
   */
  function whyCold(session: SessionRow, policy: RoleMode["session"], cacheTtl: "5m" | "1h"): string | undefined {
    if (session.compactions > 0) return "se compactó";
    if (policy !== "resume-if-warm") return undefined;
    const last = store.db
      .select()
      .from(agentTurns)
      .where(eq(agentTurns.sessionId, session.id))
      .orderBy(desc(agentTurns.seq))
      .limit(1)
      .get();
    if (!last) return "no registró ningún turno, así que no se sabe si su caché sigue caliente";
    const idleMs = now() - last.ts;
    if (idleMs >= WARM_WINDOW_MS[cacheTtl]) {
      return `respondió por última vez hace ${Math.round(idleMs / 60_000)} min y su caché (TTL ${cacheTtl}) ya está fría`;
    }
    const context = last.tokensIn + last.tokensCacheRead + last.tokensCacheWrite;
    if (context >= WARM_MAX_CONTEXT_TOKENS) {
      return `su contexto pesa ${Math.round(context / 1000)}k tokens (el tope para retomar es ${WARM_MAX_CONTEXT_TOKENS / 1000}k)`;
    }
    return undefined;
  }

  /**
   * Lo que una sesión nueva necesita saber de la anterior: su reporte y los cambios que dejó en el worktree.
   * El plan y las instrucciones de la ronda ya vienen en el brief. Si git falla, el handoff lo dice y la
   * corrida lo avisa: el agente igual puede revisar el worktree por su cuenta.
   */
  async function handoffFor(prior: SessionRow, reason: string, req: RunRequest): Promise<string> {
    const base = req.brief.base;
    let stat: string;
    try {
      stat = (await git(req.workspace, ["diff", "--stat", base])).trim() || "(sin cambios contra la base)";
    } catch (error) {
      const message = messageOf(error);
      store.tx((tx) =>
        tx.emit({
          type: "error",
          origin: "core",
          ...scope({ placement: req, runId: req.brief.run.id }),
          payload: { scope: "agent.handoff", message: `No se pudo calcular el diff --stat del handoff: ${message}` },
        }),
      );
      stat = `(no se pudo calcular: ${message})`;
    }
    const report = Report.safeParse(prior.report);
    const done = report.success
      ? `Reporte (${report.data.outcome}): ${report.data.summary}\n\n${clip(JSON.stringify(report.data.payload, null, 2), HANDOFF_MAX_CHARS / 2)}`
      : "La sesión anterior no entregó un reporte válido.";
    return [
      `Handoff: la sesión anterior de esta tarea ${reason}, así que esta parte de cero en vez de retomarla. Esto es lo que dejó.`,
      done,
      `Cambios contra ${base} (git diff --stat):\n${clip(stat, HANDOFF_MAX_CHARS / 2)}`,
      "Las instrucciones de esta ronda van abajo; relee del repo solo lo que vayas a tocar.",
    ].join("\n\n");
  }

  /**
   * Un prefijo (herramientas y prompt del rol, con el modelo) que alguna sesión está escribiendo a la caché.
   * Quien llega con el mismo prefijo espera su primer token (hasta `prefixWaitMs`) y recién ahí lanza, para
   * leerlo en vez de escribirlo otra vez (las ramas de un parallel con el mismo rol, o runs de issues distintas).
   */
  const writingPrefix = new Map<string, Promise<void>>();

  /** Devuelve qué llamar cuando el prefijo ya quedó escrito (o la sesión terminó sin escribirlo). */
  async function gitIdentityFor(repoId: string | undefined) {
    return repoId === undefined ? undefined : identityOf?.(repoId);
  }

  async function claimPrefix(spec: RunSpec, signal: AbortSignal | undefined): Promise<() => void> {
    const key = createHash("sha256")
      .update(JSON.stringify([spec.model, spec.cacheTtl ?? "5m", spec.tools, spec.native, spec.systemPrompt]))
      .digest("hex");
    const writing = writingPrefix.get(key);
    if (writing) {
      await untilOrAborted(writing, signal, prefixWaitMs);
      return () => {};
    }
    let warmed!: () => void;
    const promise = new Promise<void>((resolve) => (warmed = resolve));
    writingPrefix.set(key, promise);
    return () => {
      if (writingPrefix.get(key) === promise) writingPrefix.delete(key);
      warmed();
    };
  }

  /**
   * Lo que falta de las fuentes de contexto avisa en la corrida y no detiene al agente. Cada aviso
   * (rol y fuente) sale una vez por corrida: cada paso lo repetiría.
   */
  async function resolveContext(req: RunRequest | ResumeRequest, roleSlug: string, role: Role, cwd: string) {
    const resolved = await context.resolve({ role: roleSlug, sources: role.context, cwd, repoId: req.repoId });
    const runId = req.brief.run.id;
    const seen = warnedContext.get(runId) ?? new Set<string>();
    // Reinsertar deja a la corrida activa al final: se descartan las más viejas.
    warnedContext.delete(runId);
    warnedContext.set(runId, seen);
    if (warnedContext.size > WARNED_RUNS_KEPT) warnedContext.delete(warnedContext.keys().next().value!);
    const fresh = resolved.warnings.filter((message) => !seen.has(message));
    if (fresh.length > 0) {
      for (const message of fresh) seen.add(message);
      store.tx((tx) => {
        for (const message of fresh) {
          tx.emit({
            type: "error",
            origin: "core",
            ...scope({ placement: req, runId }),
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
    const proposes = mode.learnings === true;
    const profileRole = resolveProfileRole(req, req.profileRole ?? req.role);
    const settings = settingsOf(mode, profileRole);

    let notice = req.notice;
    if (req.resumeFrom !== undefined && mode.session !== "new") {
      const prior = sessionOf(req.resumeFrom);
      const reason = whyCold(prior, mode.session, profileRole.cacheTtl ?? "5m");
      if (reason === undefined) return resume({ ...req, sessionId: prior.id });
      const handoff = await handoffFor(prior, reason, req);
      notice = notice === undefined ? handoff : `${notice}\n\n${handoff}`;
    }
    const resolved = await resolveContext(req, req.role, role, req.workspace);

    const spec: RunSpec = {
      role: req.role,
      cwd: req.workspace,
      systemPrompt: role.prompt,
      prompt: promptFor(mode, req.brief, proposes, notice),
      model: profileRole.model,
      effort: profileRole.effort,
      ...resolved,
      hooks: role.hooks ?? false,
      tools: role.tools ?? "all",
      outputSchema: outputSchemaFor(mode, proposes),
      ...settings,
      stepRunId: req.stepRunId,
      gitIdentity: await gitIdentityFor(req.repoId),
    };
    const prefixWarmed = await claimPrefix(spec, req.signal);
    try {
      const agentRun = await runtime.start(spec);
      interruptOnAbort(req.signal, agentRun);
      return await converse(
        {
          roleDefId: roleDef.id,
          roleVersion: roleDef.version,
          roleSlug: req.role,
          model: spec.model,
          effort: spec.effort,
          cwd: spec.cwd,
          mode,
          proposes,
          settings,
          context: resolved,
          placement: req,
          runId: req.brief.run.id,
          prefixWarmed,
        },
        agentRun,
        undefined,
      );
    } finally {
      prefixWarmed();
    }
  }

  async function resume(req: ResumeRequest): Promise<AgentResult> {
    const session = sessionOf(req.sessionId);
    if (session.runtime !== runtime.id) {
      throw new Error(
        `La sesión ${req.sessionId} es del runtime "${session.runtime}" y el core corre con "${runtime.id}" (CORE_RUNTIME): abre una sesión nueva.`,
      );
    }
    const roleDef = defs.get("role", session.roleDefId, session.roleVersion);
    if (!roleDef) throw new Error(`La sesión ${req.sessionId} apunta a un rol que ya no existe.`);
    const role = Role.parse(roleDef.body);
    const mode = pickMode(role, roleDef.slug, req.mode, req.brief);
    const proposes = mode.learnings === true;
    const settings = settingsOf(mode, resolveProfileRole(req, roleDef.slug));
    const resolved = await resolveContext(req, roleDef.slug, role, session.cwd);

    const agentRun = await runtime.resume(
      { runtime: runtime.id, sessionId: session.sessionRef, cwd: session.cwd },
      promptFor(mode, req.brief, proposes, req.notice),
      { outputSchema: outputSchemaFor(mode, proposes), ...settings, ...resolved, stepRunId: req.stepRunId, gitIdentity: await gitIdentityFor(req.repoId) },
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
        proposes,
        settings,
        context: resolved,
        placement: req,
        runId: req.brief.run.id,
        prefixWarmed: () => {},
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
        outputSchema: outputSchemaFor(conversation.mode, conversation.proposes),
        ...conversation.settings,
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
        message: `El runtime falló: ${messageOf(reason)}`,
      };
    }
    lastActivity.delete(sessionId);

    // Un tope de gasto que cae justo después de entregar el reporte no lo invalida: si cumple el esquema, se usa.
    const capped = result.status === "error_max_budget_usd" ? validateReport(c.mode, result.structured) : undefined;
    if (result.status !== "success" && !capped?.ok) {
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

    const checked = capped ?? validateReport(c.mode, result.structured);
    if (!checked.ok) {
      end(c, sessionId, "report_invalid", result.usage, turns, { error: checked.problem });
      return { kind: "invalid", sessionId, problem: checked.problem };
    }
    if (capped) {
      store.tx((tx) =>
        tx.emit({
          type: "error",
          origin: "core",
          ...scope(c),
          payload: {
            scope: "agent.budget",
            message: `La sesión ${sessionId} cruzó el tope de USD ${c.settings.maxBudgetUsd} del rol "${c.roleSlug}" después de entregar su reporte: se usó el reporte. Sube el tope si pasa seguido.`,
          },
        }),
      );
    }
    // El esquema del modo no los pide, pero un modelo puede mandarlos igual: sin `learnings: true` no cuentan.
    const report = c.proposes ? checked.report : { ...checked.report, learnings: undefined };
    end(c, sessionId, "success", result.usage, turns, { report });
    return { kind: "done", result: { status: "success", sessionId, report } };
  }

  /**
   * Un tope por rol menor que lo que cuesta escribir el prefijo en la caché corta a la sesión antes de
   * que responda: se avisa al lanzarla (una vez, no en cada retoma) para que el perfil lo suba.
   */
  function warnIfBudgetBelowFloor(tx: Tx, c: Conversation): void {
    const cap = c.settings.maxBudgetUsd;
    if (cap === undefined) return;
    const floorMicros = minUsefulBudgetMicros(tx.db, c.model, now(), c.settings.cacheTtl ?? "5m");
    if (floorMicros === undefined || cap * 1_000_000 >= floorMicros) return;
    tx.emit({
      type: "error",
      origin: "core",
      ...scope(c),
      payload: {
        scope: "agent.budget",
        message: `El tope de USD ${cap} del rol "${c.roleSlug}" (modelo ${c.model}) es menor que el mínimo útil de USD ${(floorMicros / 1_000_000).toFixed(2)}: escribir el prefijo en la caché (${PREFIX_TOKENS / 1000}k tokens) ya lo gasta y la sesión corta sin reporte. Súbelo en el perfil.`,
      },
    });
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
      if (resumedFrom === undefined) warnIfBudgetBelowFloor(tx, c);
      return id;
    });
  }

  /** `turns` acumula lo que ya se registró turno a turno; `end` lo reconcilia con el total del runtime. */
  async function observe(c: Conversation, sessionId: string, agentRun: AgentRun, turns: Usage): Promise<void> {
    for await (const event of agentRun.events) {
      // Cualquier señal de vida vale: el modelo ya respondió, así que el prefijo está en la caché.
      c.prefixWarmed();
      if (event.type === "compaction") {
        store.tx((tx) =>
          tx.db
            .update(agentSessions)
            .set({ compactions: sql`${agentSessions.compactions} + 1` })
            .where(eq(agentSessions.id, sessionId))
            .run(),
        );
        continue;
      }
      if (event.type === "usage") {
        store.tx((tx) => recordTurn(tx, c, sessionId, event, turns));
        continue;
      }
      if (event.type === "usage_remainder") {
        store.tx((tx) => recordRemainder(tx, c, sessionId, event, turns));
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

    const costMicros = runtime.capabilities.costPerTurn ? usage.costMicros : estimateOrWarn(tx, c, sessionId, model, seq, ts, tokens);

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

  /** El USD de un turno con `model_prices`; sin precio para el modelo avisa y lo deja en 0. */
  function estimateOrWarn(
    tx: Tx,
    c: Conversation,
    sessionId: string,
    model: string,
    seq: number,
    ts: number,
    tokens: TurnTokens,
  ): number {
    const estimated = estimateCostMicros(tx.db, model, ts, tokens);
    if (estimated !== undefined) return estimated;
    tx.emit({
      type: "error",
      origin: "core",
      ...scope(c),
      payload: {
        scope: "agent.usage",
        message: `No hay precio en model_prices para el modelo "${model}": el turno ${seq} de la sesión ${sessionId} quedó con costo 0.`,
      },
    });
    return 0;
  }

  /**
   * Suma lo que el total del runtime cuenta de más (la salida que el uso de un turno en streaming aún
   * no trae, subagentes, llamadas internas) al último turno de ese modelo, o a un turno nuevo si la
   * sesión no tiene ninguno: así los turnos suman lo que cobró el runtime. No cuenta como turno en `turns`.
   */
  function recordRemainder(
    tx: Tx,
    c: Conversation,
    sessionId: string,
    event: Extract<AgentEvent, { type: "usage_remainder" }>,
    turns: Usage,
  ): void {
    const session = tx.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get();
    if (!session) throw new Error(`Desapareció la sesión ${sessionId}.`);
    const { model, tokens: rest } = event;
    const last = tx.db
      .select()
      .from(agentTurns)
      .where(and(eq(agentTurns.sessionId, sessionId), eq(agentTurns.model, model)))
      .orderBy(desc(agentTurns.seq))
      .limit(1)
      .get();
    const seq = last?.seq ?? session.turns + 1;
    const ts = last?.ts ?? now();
    const tokens = {
      tokensIn: (last?.tokensIn ?? 0) + rest.tokensIn,
      tokensOut: (last?.tokensOut ?? 0) + rest.tokensOut,
      tokensCacheRead: (last?.tokensCacheRead ?? 0) + rest.tokensCacheRead,
      tokensCacheWrite: (last?.tokensCacheWrite ?? 0) + rest.tokensCacheWrite,
      tokensCacheWrite1h: (last?.tokensCacheWrite1h ?? 0) + event.cacheWrite1hTokens,
    };
    const costMicros = estimateOrWarn(tx, c, sessionId, model, seq, ts, tokens);
    const costDelta = costMicros - (last?.costMicros ?? 0);

    tx.db
      .insert(agentTurns)
      .values({ sessionId, seq, ts, model, ...tokens, costMicros })
      .onConflictDoUpdate({
        target: [agentTurns.sessionId, agentTurns.seq],
        set: { ...tokens, costMicros },
      })
      .run();
    addStepUsage(tx, c, sessionId, rest.tokensIn + rest.tokensOut + rest.tokensCacheRead + rest.tokensCacheWrite, costDelta);
    tx.db
      .update(agentSessions)
      .set({
        turns: Math.max(session.turns, seq),
        tokensIn: session.tokensIn + rest.tokensIn,
        tokensOut: session.tokensOut + rest.tokensOut,
        tokensCacheRead: session.tokensCacheRead + rest.tokensCacheRead,
        tokensCacheWrite: session.tokensCacheWrite + rest.tokensCacheWrite,
        costMicros: session.costMicros + costDelta,
      })
      .where(eq(agentSessions.id, sessionId))
      .run();
    turns.tokensIn += rest.tokensIn;
    turns.tokensOut += rest.tokensOut;
    turns.tokensCacheRead += rest.tokensCacheRead;
    turns.tokensCacheWrite += rest.tokensCacheWrite;
    turns.costMicros += costDelta;
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

/** Espera a `promise`, a que `signal` aborte (un paso cancelado no se queda esperando a otra sesión) o `maxMs`. */
function untilOrAborted(promise: Promise<void>, signal: AbortSignal | undefined, maxMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => done(), maxMs);
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    if (signal?.aborted) return done();
    signal?.addEventListener("abort", done, { once: true });
    void promise.then(done);
  });
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (truncado: ${text.length - max} caracteres más)`;
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
function promptFor(mode: RoleMode, brief: Brief, proposes: boolean, notice?: string): string {
  const instructions = proposes ? `${mode.instructions}\n\n${LEARNING_PROMPT}` : mode.instructions;
  const message = `${instructions}\n\n${JSON.stringify(brief, null, 2)}`;
  return notice === undefined ? message : `${notice}\n\n${message}`;
}

/**
 * El esquema de salida de un modo: el sobre de `Report` con su `outcome` y su `payload`. Sin `proposes`
 * no lleva `learnings`: el agente no los propone.
 */
export function outputSchemaFor(mode: RoleMode, proposes = false): JsonSchema {
  const properties = { ...reportEnvelope.properties };
  if (!proposes) delete properties.learnings;
  return {
    ...reportEnvelope,
    properties: {
      ...properties,
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
    : { ok: false, problem: issuesInline(parsed.error.issues) };
}


