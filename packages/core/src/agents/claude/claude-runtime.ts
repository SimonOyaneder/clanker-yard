import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  query as sdkQuery,
  type HookCallback,
  type ModelUsage,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Procs } from "../../procs/procs";
import { usdToMicros } from "../../store/conventions";
import type {
  AgentEvent,
  AgentRun,
  AgentRuntime,
  ResumeSpec,
  RunResult,
  RunSpec,
  SessionRef,
  Usage,
} from "../runtime";
import type { ClaudeCredentials } from "./credentials";
import { userConfigDir } from "../context";
import { createEventQueue } from "./event-queue";
import { agentEnv, toOptions } from "./options";
import { credentialMismatch, noteSignals, outcomeOf, type Signals } from "./outcome";
import { skillDirs, watchDirs } from "./skills-watch";
import { transcriptFile } from "./transcript";

/** Lo único que el adapter usa de `query`: los tests inyectan uno falso. Sin `reloadSkills` no se recargan skills a media sesión. */
export type QueryFn = (params: {
  prompt: string;
  options: Options;
}) => AsyncIterable<SDKMessage> & { reloadSkills?: () => Promise<unknown> };

export interface ClaudeRuntimeOptions {
  /**
   * Se pide al lanzar o retomar cada run, así un cambio de suscripción a API key (o al revés) vale
   * para el próximo run sin reiniciar el core.
   */
  credentials: () => Promise<ClaudeCredentials>;
  /** `CLANKER_HOME`: aquí quedan `transcripts/`, `agent-sessions/` y el entorno generado de los agentes. */
  home: string;
  /** `user.name` y `user.email` del git config que ven los agentes. */
  gitIdentity?: { name: string; email: string };
  /** El entorno del core; de él solo se heredan PATH, HOME, USER, LANG y CLAUDE_CONFIG_DIR. */
  baseEnv?: Record<string, string | undefined>;
  query?: QueryFn;
  /**
   * Con `procs`, cada proceso de Claude Code arranca en su propio grupo y queda registrado (`kind: "agent"`):
   * así el apagado del core y el arranque tras un crash lo matan con sus hijos. Sin él, lo lanza el SDK.
   */
  procs?: Procs;
}

const DEFAULT_GIT_IDENTITY = { name: "Clanker Yard", email: "clanker@localhost" };

/**
 * Lo que `resume` necesita y `ResumeSpec` no trae; se guarda al iniciar para sobrevivir a un reinicio del
 * core. Sin el contexto: cada lanzamiento lo vuelve a leer del original.
 */
interface StoredSession {
  spec: RunSpec;
}

/**
 * Runtime `claude-sdk`: lanza Claude Code con el Agent SDK, sin tocar credenciales
 * (`docs/claude-subscription.md`) y con un entorno sin tokens de GitHub ni Linear.
 *
 * `interrupt()` aborta el proceso de Claude: con prompt de texto el SDK no admite `Query.interrupt()`.
 * El transcript completo de cada sesión queda en `transcripts/<sessionId>.jsonl`; al retomar se
 * agrega al mismo archivo, y de su último `result` sale lo ya gastado para reportar solo lo de este run.
 */
export function createClaudeRuntime(options: ClaudeRuntimeOptions): AgentRuntime {
  const { home } = options;
  const runQuery = options.query ?? sdkQuery;
  const baseEnv = options.baseEnv ?? process.env;
  const identity = options.gitIdentity ?? DEFAULT_GIT_IDENTITY;
  const paths = {
    ghConfigDir: join(home, "agent-env", "gh"),
    gitConfig: join(home, "agent-env", "gitconfig"),
    transcripts: join(home, "transcripts"),
    sessions: join(home, "agent-sessions"),
  };

  /** Lo que el SDK llama para lanzar `claude`: el mismo `spawn` de siempre, pero con grupo propio y en `procs`. */
  function spawnIn(procs: Procs, stepRunId: string | undefined): Options["spawnClaudeCodeProcess"] {
    return ({ command, args, cwd, env, signal }) => {
      // Sin `signal` en `spawn`: Node solo mataría al líder. Cuando el SDK se rinde con su cierre
      // ordenado, se baja el grupo completo (`bash` de las tools incluido).
      const child = spawn(command, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      procs.track(child, { kind: "agent", stepRunId });
      signal.addEventListener(
        "abort",
        () => {
          if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            // Terminó entre medio.
          }
        },
        { once: true },
      );
      return child;
    };
  }

  let prepared: Promise<void> | undefined;
  function prepare(): Promise<void> {
    prepared ??= (async () => {
      // Siempre vacía: lo que un agente haya dejado en una corrida anterior no cuenta como login de gh.
      await rm(paths.ghConfigDir, { recursive: true, force: true });
      await mkdir(paths.ghConfigDir, { recursive: true });
      await mkdir(paths.transcripts, { recursive: true });
      await mkdir(paths.sessions, { recursive: true });
      await writeFile(paths.gitConfig, gitConfigFor(identity));
    })().catch((error: unknown) => {
      prepared = undefined;
      throw error;
    });
    return prepared;
  }

  const transcriptOf = (sessionId: string) => transcriptFile(home, sessionId);
  const storedOf = (sessionId: string) => join(paths.sessions, `${sessionId}.json`);

  async function launch(spec: RunSpec, prompt: string, resumeId: string | undefined): Promise<AgentRun> {
    const credentials = await options.credentials();
    const previous = resumeId === undefined ? ZERO_TOTALS : await totalsAtEndOf(transcriptOf(resumeId));
    const abort = new AbortController();
    let stopReason: string | undefined;
    const stop = (reason: string) => {
      stopReason ??= reason;
      abort.abort();
    };

    const events = createEventQueue<AgentEvent>();
    const transcript = createTranscript(transcriptOf);
    let sessionId: string | undefined;
    let sessionReady!: (id: string) => void;
    let sessionFailed!: (error: unknown) => void;
    const session = new Promise<string>((resolve, reject) => {
      sessionReady = resolve;
      sessionFailed = reject;
    });

    const logCompaction: HookCallback = async (input) => {
      if (input.hook_event_name === "PreCompact") {
        events.push({ type: "compaction" });
        transcript.append(input.session_id, {
          type: "clanker",
          subtype: "pre_compact",
          trigger: input.trigger,
          session_id: input.session_id,
        });
      }
      return {};
    };

    const stream = runQuery({
      prompt,
      options: toOptions(spec, {
        env: agentEnv({
          baseEnv,
          ghConfigDir: paths.ghConfigDir,
          gitConfig: paths.gitConfig,
          cacheTtl: spec.cacheTtl,
          credentials,
        }),
        executable: credentials.executable,
        abort,
        resume: resumeId,
        logCompaction,
        spawn: options.procs && spawnIn(options.procs, spec.stepRunId),
      }),
    });

    // Una skill editada mientras el agente corre vale desde su siguiente uso: se recarga del disco.
    const stopWatching =
      stream.reloadSkills === undefined
        ? () => {}
        : watchDirs(
            skillDirs(spec.native, spec.cwd, userConfigDir(baseEnv)),
            () => {
              stream.reloadSkills?.().catch((error: unknown) => skillsFailed("recargar", error));
            },
            (error) => skillsFailed("observar", error),
          );
    function skillsFailed(action: string, error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      events.push({ type: "error", kind: "other", message: `No se pudieron ${action} las skills del rol "${spec.role}": ${reason}` });
    }

    const tally = emptyUsage(credentials);
    const signals: Signals = { loginFailed: false };
    const toolNames = new Map<string, string>();
    let turn: { id: string; model: string; usage: SDKUsage } | undefined;
    let firstToken = false;
    const counted = new Set<string>();
    let final: SDKResultMessage | undefined;

    // El uso de un mensaje en streaming no es final: se emite cuando llega otro id, con lo último visto.
    // El SDK parte un mensaje en un `assistant` por bloque, todos con el mismo id y el mismo uso; si el
    // de un subagente se intercala, el id reaparece después de emitido y no vuelve a contar.
    const flushTurn = () => {
      if (turn === undefined) return;
      const { id, model, usage: sdkUsage } = turn;
      turn = undefined;
      if (counted.has(id)) return;
      counted.add(id);
      const usage = turnUsage(sdkUsage, credentials);
      addUsage(tally, usage);
      events.push({
        type: "usage",
        turn: tally.turns,
        usage,
        model,
        cacheWrite1hTokens: sdkUsage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      });
    };

    const onMessage = (message: SDKMessage) => {
      noteSignals(message, signals);
      if (message.type === "system" && message.subtype === "init") {
        const mismatch = credentialMismatch(credentials.mode, message.apiKeySource);
        if (mismatch !== undefined) stop(mismatch);
        sessionId = message.session_id;
        sessionReady(sessionId);
      } else if (message.type === "assistant") {
        if (!firstToken) {
          firstToken = true;
          events.push({ type: "first_token" });
        }
        if (turn?.id !== message.message.id) flushTurn();
        turn = { id: message.message.id, model: message.message.model, usage: message.message.usage };
        for (const block of message.message.content) {
          if (block.type === "text" && block.text !== "") {
            events.push({ type: "text", text: block.text });
          } else if (block.type === "tool_use") {
            toolNames.set(block.id, block.name);
            const detail = detailOf(block.input);
            events.push({
              type: "tool_start",
              tool: block.name,
              ...(detail === undefined ? {} : { detail }),
            });
          }
        }
      } else if (message.type === "user") {
        const content = message.message.content;
        for (const block of Array.isArray(content) ? content : []) {
          if (block.type === "tool_result") {
            const tool = toolNames.get(block.tool_use_id);
            if (tool !== undefined) events.push({ type: "tool_end", tool });
          }
        }
      } else if (message.type === "result") {
        final = message;
      }
    };

    // Solo un fallo del runtime rechaza `result` (el proceso murió sin `result` ni aviso, no se pudo escribir el transcript).
    const finished = (async (): Promise<RunResult> => {
      let crash: unknown;
      try {
        for await (const message of stream) {
          const id = message.session_id ?? sessionId;
          if (id === undefined) throw new Error("Claude mandó un mensaje sin sesión antes de iniciarla.");
          transcript.append(id, message);
          onMessage(message);
        }
      } catch (error) {
        crash = error;
      }
      flushTurn();
      await transcript.flush();

      // Tras un `result` con error el SDK lanza "Claude Code returned an error result": el estado sale del `result`.
      const explained = final !== undefined || signals.loginFailed || signals.quota !== undefined;
      if (stopReason === undefined && crash !== undefined && !explained) throw crash;
      if (sessionId === undefined) throw new Error("Claude terminó sin iniciar la sesión.");

      if (stopReason !== undefined) {
        return { status: "error", text: "", usage: tally, message: stopReason };
      }
      const outcome = outcomeOf(final, signals, credentials.mode);
      return {
        status: outcome.status,
        text: final?.subtype === "success" ? final.result : "",
        ...(final?.subtype === "success" && final.structured_output !== undefined
          ? { structured: final.structured_output }
          : {}),
        usage: final === undefined ? tally : spentThisRun(final, previous, tally, credentials),
        ...(outcome.message === undefined ? {} : { message: outcome.message }),
        ...(outcome.resetsAt === undefined ? {} : { resetsAt: outcome.resetsAt }),
      };
    })().finally(() => {
      stopWatching();
      events.close();
    });
    finished.catch(sessionFailed);

    const startedId = await session;
    return {
      ref: { runtime: "claude-sdk", sessionId: startedId, cwd: spec.cwd },
      events,
      interrupt: async () => stop("El run fue interrumpido."),
      result: finished,
    };
  }

  return {
    id: "claude-sdk",
    capabilities: { structuredOutput: true, costPerTurn: false, resume: true, fork: false, steer: false },

    async start(spec) {
      await prepare();
      const run = await launch(spec, spec.prompt, undefined);
      const stored: StoredSession = { spec: { ...spec, native: undefined, references: [], stepRunId: undefined } };
      await writeFile(storedOf(run.ref.sessionId), JSON.stringify(stored));
      return run;
    },

    async resume(ref: SessionRef, message: string, resumeSpec: ResumeSpec) {
      await prepare();
      const stored = await readStored(storedOf(ref.sessionId), ref.sessionId);
      const spec: RunSpec = { ...stored.spec, ...resumeSpec, cwd: ref.cwd, prompt: message };
      return launch(spec, message, ref.sessionId);
    },
  };
}

async function readStored(file: string, sessionId: string): Promise<StoredSession> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as StoredSession;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error(
      `No hay registro de la sesión ${sessionId} en ${file}: el runtime claude-sdk solo retoma las sesiones que él inició.`,
    );
  }
}

function gitConfigFor({ name, email }: { name: string; email: string }): string {
  const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  return `[user]\n\tname = ${quote(name)}\n\temail = ${quote(email)}\n[credential]\n\thelper =\n`;
}

type SDKUsage = Extract<SDKMessage, { type: "assistant" }>["message"]["usage"];

function turnUsage(usage: SDKUsage, credentials: ClaudeCredentials): Usage {
  return {
    turns: 1,
    tokensIn: usage.input_tokens,
    tokensOut: usage.output_tokens,
    tokensCacheRead: usage.cache_read_input_tokens ?? 0,
    tokensCacheWrite: usage.cache_creation_input_tokens ?? 0,
    // Los eventos por turno llevan tokens; el USD de la corrida viene del `result` (`total_cost_usd`).
    costMicros: 0,
    costSource: costSourceOf(credentials),
  };
}

function costSourceOf(credentials: ClaudeCredentials): Usage["costSource"] {
  return credentials.mode === "subscription" ? "estimate" : "runtime";
}

function emptyUsage(credentials: ClaudeCredentials): Usage {
  return {
    turns: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    costMicros: 0,
    costSource: costSourceOf(credentials),
  };
}

function addUsage(into: Usage, usage: Usage): void {
  into.turns += usage.turns;
  into.tokensIn += usage.tokensIn;
  into.tokensOut += usage.tokensOut;
  into.tokensCacheRead += usage.tokensCacheRead;
  into.tokensCacheWrite += usage.tokensCacheWrite;
  into.costMicros += usage.costMicros;
}

/** Acumulado de una sesión según un `result`: el SDK lo arrastra al retomar. */
interface Totals {
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
}

const ZERO_TOTALS: Totals = { costUsd: 0, tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0 };

function totalsOf(result: SDKResultMessage): Totals {
  const totals = { ...ZERO_TOTALS, costUsd: result.total_cost_usd };
  for (const m of Object.values<ModelUsage>(result.modelUsage)) {
    totals.tokensIn += m.inputTokens;
    totals.tokensOut += m.outputTokens;
    totals.tokensCacheRead += m.cacheReadInputTokens;
    totals.tokensCacheWrite += m.cacheCreationInputTokens;
  }
  return totals;
}

/**
 * Lo gastado por este run: el total del `result` menos lo que ya traía la sesión. Un `result` de
 * arranque fallido puede venir en cero y un `/clear` reinicia el total: si el total quedó bajo el
 * previo, el previo ya no cuenta.
 */
function spentThisRun(
  result: SDKResultMessage,
  previous: Totals,
  tally: Usage,
  credentials: ClaudeCredentials,
): Usage {
  const now = totalsOf(result);
  const before = now.costUsd >= previous.costUsd ? previous : ZERO_TOTALS;
  return {
    turns: tally.turns,
    tokensIn: now.tokensIn - before.tokensIn,
    tokensOut: now.tokensOut - before.tokensOut,
    tokensCacheRead: now.tokensCacheRead - before.tokensCacheRead,
    tokensCacheWrite: now.tokensCacheWrite - before.tokensCacheWrite,
    costMicros: usdToMicros(now.costUsd - before.costUsd),
    costSource: costSourceOf(credentials),
  };
}

/** Lo ya gastado por la sesión: el último `result` de su transcript (o cero si no tiene). */
async function totalsAtEndOf(transcript: string): Promise<Totals> {
  let text: string;
  try {
    text = await readFile(transcript, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ZERO_TOTALS;
    throw error;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined || !line.includes('"type":"result"')) continue;
    const record = JSON.parse(line) as SDKMessage;
    if (record.type === "result") return totalsOf(record);
  }
  return ZERO_TOTALS;
}

/** Lo más útil para mostrar en la UI de lo que recibió la herramienta. */
function detailOf(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  for (const key of ["file_path", "path", "command", "pattern", "url"]) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function createTranscript(fileOf: (sessionId: string) => string) {
  let chain: Promise<void> = Promise.resolve();
  let failure: unknown;
  return {
    append(sessionId: string, record: unknown) {
      const line = `${JSON.stringify(record)}\n`;
      chain = chain
        .then(() => appendFile(fileOf(sessionId), line))
        .catch((error: unknown) => {
          failure ??= error;
        });
    },
    async flush() {
      await chain;
      if (failure !== undefined) throw failure;
    },
  };
}
