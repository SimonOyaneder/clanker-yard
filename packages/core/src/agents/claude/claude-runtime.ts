import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
import { startRecording } from "./record";
import { skillDirs, watchDirs } from "./skills-watch";
import { transcriptFile } from "./transcript";

/** La herramienta con la que Claude Code entrega el reporte cuando se le pide `outputFormat`. */
const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

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
  /** El entorno del core; de él solo se heredan PATH, HOME, USER, LANG y CLAUDE_CONFIG_DIR. */
  baseEnv?: Record<string, string | undefined>;
  query?: QueryFn;
  /**
   * Con `procs`, cada proceso de Claude Code arranca en su propio grupo y queda registrado (`kind: "agent"`):
   * así el apagado del core y el arranque tras un crash lo matan con sus hijos. Sin él, lo lanza el SDK.
   */
  procs?: Procs;
  /** Cuánto tarda en caer con SIGKILL el grupo de un proceso que siguió vivo tras su SIGTERM (cancelar, pausar, interrumpir). Por defecto `KILL_GROUP_AFTER_MS`. */
  killAfterMs?: number;
  /**
   * `CLANKER_RECORD`: una carpeta donde dejar el guion del runtime fake de cada run (`record.ts`).
   * Sin ella no se graba nada.
   */
  record?: string;
}

/** Tras bajar el grupo de un agente con SIGTERM, lo que siga vivo a los 10 s cae con SIGKILL (`docs/design.html#d-flows`, "Cancelar"). */
export const KILL_GROUP_AFTER_MS = 10_000;

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
  const paths = {
    ghConfigDir: join(home, "agent-env", "gh"),
    gitConfigs: join(home, "agent-env", "gitconfig"),
    transcripts: join(home, "transcripts"),
    sessions: join(home, "agent-sessions"),
  };

  /** Lo que el SDK llama para lanzar `claude`: el mismo `spawn` de siempre, pero con grupo propio y en `procs`. */
  function spawnIn(procs: Procs, stepRunId: string | undefined, stderr: StderrTail): Options["spawnClaudeCodeProcess"] {
    return ({ command, args, cwd, env, signal }) => {
      // Sin `signal` en `spawn`: Node solo mataría al líder. Cuando el SDK se rinde con su cierre
      // ordenado, se baja el grupo completo (`bash` de las tools incluido) y, si no cierra, a los 10 s con SIGKILL.
      const child = spawn(command, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
      procs.track(child, { kind: "agent", stepRunId });
      signal.addEventListener(
        "abort",
        () => {
          if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
          const pid = child.pid;
          try {
            process.kill(-pid, "SIGTERM");
          } catch {
            // Terminó entre medio.
            return;
          }
          const hardKill = setTimeout(() => {
            try {
              process.kill(-pid, "SIGKILL");
            } catch {
              // Terminó entre medio.
            }
          }, options.killAfterMs ?? KILL_GROUP_AFTER_MS);
          hardKill.unref();
          child.once("close", () => clearTimeout(hardKill));
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
      await mkdir(paths.gitConfigs, { recursive: true });
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
    const gitConfig = await writeGitConfig(paths.gitConfigs, spec.gitIdentity);
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

    const recording =
      options.record === undefined
        ? undefined
        : await startRecording({
            dir: options.record,
            spec,
            prompt,
            home,
            secrets: Object.values(credentials.env()),
          });
    const emitUsage = (event: Extract<AgentEvent, { type: "usage" | "usage_remainder" }>) => {
      events.push(event);
      recording?.usage(event);
    };

    const stderr = createStderrTail();
    const stream = runQuery({
      prompt,
      options: toOptions(spec, {
        env: agentEnv({
          baseEnv,
          ghConfigDir: paths.ghConfigDir,
          gitConfig,
          cacheTtl: spec.cacheTtl,
          credentials,
        }),
        executable: credentials.executable,
        abort,
        resume: resumeId,
        logCompaction,
        spawn: options.procs && spawnIn(options.procs, spec.stepRunId, stderr),
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
    // El último reporte que el agente intentó entregar: si el tope de gasto cae justo después, el `result` no lo trae.
    let deliveredReport: unknown;
    let turn: { id: string; model: string; usage: SDKUsage } | undefined;
    let firstToken = false;
    const counted = new Set<string>();
    const emitted = new Map<string, TokenCounts>();
    let emittedWrite1h = 0;
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
      emitted.set(model, sumTokens([emitted.get(model) ?? NO_TOKENS, usage]));
      const cacheWrite1hTokens = sdkUsage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
      emittedWrite1h += cacheWrite1hTokens;
      emitUsage({ type: "usage", turn: tally.turns, usage, model, cacheWrite1hTokens });
    };

    // El uso de cada `assistant` no es final (su salida llega recién en el total) y el total también
    // cubre subagentes y llamadas internas: lo que el `result` cuenta de más por modelo se manda como resto.
    const flushRemainders = (result: SDKResultMessage) => {
      const now = totalsOf(result);
      const before = priorTo(now, previous).byModel;
      const oneHourShare = tally.tokensCacheWrite === 0 ? 0 : emittedWrite1h / tally.tokensCacheWrite;
      for (const [model, total] of now.byModel) {
        const rest = subtractTokens(subtractTokens(total, before.get(model)), emitted.get(model));
        const remainder: TokenCounts = {
          tokensIn: Math.max(0, rest.tokensIn),
          tokensOut: Math.max(0, rest.tokensOut),
          tokensCacheRead: Math.max(0, rest.tokensCacheRead),
          tokensCacheWrite: Math.max(0, rest.tokensCacheWrite),
        };
        if (Object.values(remainder).every((n) => n === 0)) continue;
        emitUsage({
          type: "usage_remainder",
          model,
          tokens: remainder,
          cacheWrite1hTokens: Math.round(remainder.tokensCacheWrite * oneHourShare),
        });
      }
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
            if (block.name === STRUCTURED_OUTPUT_TOOL) deliveredReport = block.input;
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
          recording?.message(message);
          onMessage(message);
        }
      } catch (error) {
        crash = error;
      }
      flushTurn();
      if (final !== undefined) flushRemainders(final);
      await transcript.flush();

      const conclude = (): RunResult => {
        // Tras un `result` con error el SDK lanza "Claude Code returned an error result": el estado sale del `result`.
        const explained = final !== undefined || signals.loginFailed || signals.quota !== undefined;
        if (stopReason === undefined && crash !== undefined && !explained) throw withStderr(crash, stderr.text());
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
            : outcome.status === "error_max_budget_usd" && deliveredReport !== undefined
              ? { structured: deliveredReport }
              : {}),
          usage: final === undefined ? tally : spentThisRun(final, previous, tally, credentials),
          ...(outcome.message === undefined ? {} : { message: outcome.message }),
          ...(outcome.resetsAt === undefined ? {} : { resetsAt: outcome.resetsAt }),
        };
      };
      let settled: { result: RunResult } | { crash: unknown };
      try {
        settled = { result: conclude() };
      } catch (error) {
        settled = { crash: error };
      }
      // Una grabación que falla no pierde el run (ya gastó): se avisa como evento.
      await recording?.finish(settled).catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        events.push({ type: "error", kind: "other", message: `No se pudo grabar el guion del rol "${spec.role}": ${reason}` });
      });
      if ("crash" in settled) throw settled.crash;
      return settled.result;
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

/** Lo último que `claude` escribió en stderr: el SDK solo dice "exited with code 1", y la causa está ahí. */
interface StderrTail {
  push(chunk: string): void;
  text(): string;
}

const STDERR_TAIL_CHARS = 2000;

function createStderrTail(): StderrTail {
  let tail = "";
  return {
    push: (chunk) => {
      tail = (tail + chunk).slice(-STDERR_TAIL_CHARS);
    },
    text: () => tail.trim(),
  };
}

function withStderr(error: unknown, stderr: string): unknown {
  if (stderr === "" || !(error instanceof Error)) return error;
  return new Error(`${error.message}\nstderr de claude: ${stderr}`, { cause: error });
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

/**
 * El `GIT_CONFIG_GLOBAL` del agente: la identidad del usuario en el repo y ningún credential helper. Un archivo por
 * identidad (y no uno compartido) porque runs de repos distintos corren a la vez. Sin identidad no hay `[user]`.
 */
async function writeGitConfig(dir: string, identity: RunSpec["gitIdentity"]): Promise<string> {
  const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  const user = identity ? `[user]\n\tname = ${quote(identity.name)}\n\temail = ${quote(identity.email)}\n` : "";
  const content = `${user}[credential]\n\thelper =\n`;
  const file = join(dir, createHash("sha256").update(content).digest("hex").slice(0, 16));
  await writeFile(file, content);
  return file;
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

type TokenCounts = Pick<Usage, "tokensIn" | "tokensOut" | "tokensCacheRead" | "tokensCacheWrite">;

const NO_TOKENS: TokenCounts = { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0 };

/** Acumulado de una sesión según un `result`, por modelo: el SDK lo arrastra al retomar. */
interface Totals {
  costUsd: number;
  byModel: ReadonlyMap<string, TokenCounts>;
}

const ZERO_TOTALS: Totals = { costUsd: 0, byModel: new Map() };

function totalsOf(result: SDKResultMessage): Totals {
  const byModel = new Map<string, TokenCounts>();
  for (const [model, m] of Object.entries<ModelUsage>(result.modelUsage)) {
    byModel.set(model, {
      tokensIn: m.inputTokens,
      tokensOut: m.outputTokens,
      tokensCacheRead: m.cacheReadInputTokens,
      tokensCacheWrite: m.cacheCreationInputTokens,
    });
  }
  return { costUsd: result.total_cost_usd, byModel };
}

function subtractTokens(a: TokenCounts, b: TokenCounts = NO_TOKENS): TokenCounts {
  return {
    tokensIn: a.tokensIn - b.tokensIn,
    tokensOut: a.tokensOut - b.tokensOut,
    tokensCacheRead: a.tokensCacheRead - b.tokensCacheRead,
    tokensCacheWrite: a.tokensCacheWrite - b.tokensCacheWrite,
  };
}

function sumTokens(counts: Iterable<TokenCounts>): TokenCounts {
  const sum = { ...NO_TOKENS };
  for (const c of counts) {
    sum.tokensIn += c.tokensIn;
    sum.tokensOut += c.tokensOut;
    sum.tokensCacheRead += c.tokensCacheRead;
    sum.tokensCacheWrite += c.tokensCacheWrite;
  }
  return sum;
}

/**
 * Lo que ya traía la sesión antes de este run. Un `result` de arranque fallido puede venir en cero y
 * un `/clear` reinicia el total: si el total quedó bajo el previo, el previo ya no cuenta.
 */
function priorTo(now: Totals, previous: Totals): Totals {
  return now.costUsd >= previous.costUsd ? previous : ZERO_TOTALS;
}

/** Lo gastado por este run: el total del `result` menos lo que ya traía la sesión. */
function spentThisRun(
  result: SDKResultMessage,
  previous: Totals,
  tally: Usage,
  credentials: ClaudeCredentials,
): Usage {
  const now = totalsOf(result);
  const before = priorTo(now, previous);
  return {
    turns: tally.turns,
    ...subtractTokens(sumTokens(now.byModel.values()), sumTokens(before.byModel.values())),
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
