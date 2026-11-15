import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  query as sdkQuery,
  type HookCallback,
  type ModelUsage,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
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
import { createEventQueue } from "./event-queue";
import { agentEnv, toOptions } from "./options";
import { outcomeOf, type Signals } from "./outcome";

/** Lo único que el adapter usa de `query`: los tests inyectan uno falso. */
export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

export interface ClaudeRuntimeOptions {
  credentials: ClaudeCredentials;
  /** `CLANKER_HOME`: aquí quedan `transcripts/`, `agent-sessions/` y el entorno generado de los agentes. */
  home: string;
  /** `user.name` y `user.email` del git config que ven los agentes. */
  gitIdentity?: { name: string; email: string };
  /** El entorno del core; de él solo se heredan PATH, HOME, USER, LANG y CLAUDE_CONFIG_DIR. */
  baseEnv?: Record<string, string | undefined>;
  query?: QueryFn;
}

const DEFAULT_GIT_IDENTITY = { name: "Clanker Yard", email: "clanker@localhost" };

/** Lo que `resume` necesita y `ResumeSpec` no trae; se guarda al iniciar para sobrevivir a un reinicio del core. */
interface StoredSession {
  spec: RunSpec;
  repoContext: string;
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
  const { credentials, home } = options;
  const runQuery = options.query ?? sdkQuery;
  const baseEnv = options.baseEnv ?? process.env;
  const identity = options.gitIdentity ?? DEFAULT_GIT_IDENTITY;
  const paths = {
    ghConfigDir: join(home, "agent-env", "gh"),
    gitConfig: join(home, "agent-env", "gitconfig"),
    transcripts: join(home, "transcripts"),
    sessions: join(home, "agent-sessions"),
  };

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

  const transcriptOf = (sessionId: string) => join(paths.transcripts, `${sessionId}.jsonl`);
  const storedOf = (sessionId: string) => join(paths.sessions, `${sessionId}.json`);

  async function launch(
    spec: RunSpec,
    repoContext: string,
    prompt: string,
    resumeId: string | undefined,
  ): Promise<AgentRun> {
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
        repoContext,
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
      }),
    });

    const tally = emptyUsage(credentials);
    const signals: Signals = { loginFailed: false };
    const toolNames = new Map<string, string>();
    let turn: { id: string; usage: SDKUsage } | undefined;
    let final: SDKResultMessage | undefined;

    // El uso de un mensaje en streaming no es final: se emite cuando llega otro id, con lo último visto.
    const flushTurn = () => {
      if (turn === undefined) return;
      const usage = turnUsage(turn.usage, credentials);
      addUsage(tally, usage);
      events.push({ type: "usage", turn: tally.turns, usage });
      turn = undefined;
    };

    const onMessage = (message: SDKMessage) => {
      if (message.type === "system" && message.subtype === "init") {
        const usesApiKey = message.apiKeySource !== "none";
        if (credentials.mode === "subscription" && usesApiKey) {
          stop(
            `Claude iba a gastar una API key (${message.apiKeySource}) en vez de la suscripción: revisa que el entorno del agente no la traiga.`,
          );
        } else if (credentials.mode === "api-key" && !usesApiKey) {
          stop("Claude no está usando la API key configurada: revisa ANTHROPIC_API_KEY.");
        }
        sessionId = message.session_id;
        sessionReady(sessionId);
      } else if (message.type === "assistant") {
        if (message.error === "authentication_failed") signals.loginFailed = true;
        if (message.error === "rate_limit" || message.error === "billing_error") {
          signals.quota ??= { creditsRequired: false };
        }
        if (turn?.id !== message.message.id) flushTurn();
        turn = { id: message.message.id, usage: message.message.usage };
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
      } else if (message.type === "rate_limit_event") {
        const info = message.rate_limit_info;
        if (info.status === "rejected") {
          signals.quota = {
            creditsRequired: info.errorCode === "credits_required",
            ...(info.resetsAt === undefined ? {} : { resetsAt: info.resetsAt * 1000 }),
          };
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
      const outcome = outcomeOf(final, signals);
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
    })().finally(events.close);
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
      const repoContext = await resolveRepoContext(spec);
      const run = await launch(spec, repoContext, spec.prompt, undefined);
      const stored: StoredSession = { spec, repoContext };
      await writeFile(storedOf(run.ref.sessionId), JSON.stringify(stored));
      return run;
    },

    async resume(ref: SessionRef, message: string, resumeSpec: ResumeSpec) {
      await prepare();
      const stored = await readStored(storedOf(ref.sessionId), ref.sessionId);
      const spec: RunSpec = { ...stored.spec, ...resumeSpec, cwd: ref.cwd, prompt: message };
      return launch(spec, stored.repoContext, message, ref.sessionId);
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

/** Las fuentes `native` las carga Claude con `settingSources`; las `repo` y `file` van al prompt de sistema. */
async function resolveRepoContext(spec: RunSpec): Promise<string> {
  const sections: string[] = [];
  for (const source of spec.context) {
    if (source.kind === "pack") {
      throw new Error(
        `El rol "${spec.role}" usa el pack "${source.id}", y el runtime claude-sdk todavía no resuelve packs.`,
      );
    }
    const files = source.kind === "repo" ? source.files : source.kind === "file" ? [source.path] : [];
    for (const file of files) {
      const path = resolve(spec.cwd, file);
      let content: string;
      try {
        content = await readFile(path, "utf8");
      } catch (error) {
        throw new Error(
          `El rol "${spec.role}" pide el contexto "${file}" y no se pudo leer (${path}): ${(error as Error).message}`,
        );
      }
      sections.push(`# ${file}\n\n${content}`);
    }
  }
  return sections.join("\n\n");
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
