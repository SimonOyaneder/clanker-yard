import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effort, TRANSCRIPT_TEXT_MAX_CHARS, type RuntimeOptions, type TranscriptEntry } from "@clanker/api";
import type { Procs } from "../../procs/procs";
import { usdToMicros } from "../../store/conventions";
import { writeGitConfig } from "../agent-env";
import { transcriptFile } from "../claude/transcript";
import { createEventQueue } from "../event-queue";
import type { AgentEvent, AgentRun, AgentRuntime, ResumeSpec, RunResult, RunSpec, RunStatus, SessionRef, Usage } from "../runtime";
import { createOpencodeApi, type ModelRef, type OpencodeApi } from "./api";
import { createOpencodeCli, parseModels, versionProblem, type OpencodeCli } from "./cli";
import { configFor, inheritedEnv, OPENCODE_AGENT, parseModel, SERVE_ARGS, serverEnv } from "./config";
import { REPORT_PLUGIN_SOURCE } from "./report-plugin";
import { launchOpencodeServer, type LaunchServer } from "./server";
import { catalogPrices, type PriceOf } from "./prices";
import { createTranslator, statusOfError } from "./translate";

/** Cuántas veces dejar que opencode reintente un error que no es de cuota ni de login (un 5xx, un proveedor saturado). */
export const MAX_PROVIDER_RETRIES = 6;

/** Cada cuánto se lee la sesión por si se perdió el fin de la ejecución en los eventos (no se reconectan solos). */
export const STATUS_POLL_MS = 5_000;

/** Tras interrumpir, lo que se espera a que opencode lo confirme antes de cerrar el run igual. */
export const INTERRUPT_SETTLE_MS = 15_000;

/** Cuánto vale la lista de modelos de `opencode models` (es lo que tiene conectado la máquina: cambia poco). */
export const MODELS_TTL_MS = 5 * 60_000;

/**
 * Los modelos que se ofrecen primero, de menos a más potente (como haiku, sonnet y opus en Claude), si opencode los
 * tiene conectados. Los demás van después, en el orden de `opencode models`.
 */
export const RECOMMENDED_MODELS = [
  { id: "openai/gpt-6-luna", about: "Recomendado: el más liviano de los nuevos de OpenAI, para tareas simples y revisiones." },
  { id: "openai/gpt-6.1-terra", about: "Recomendado: equilibrado, el punto de partida." },
  { id: "openai/gpt-6.1-sol", about: "Recomendado: el más potente de los nuevos de OpenAI, para el trabajo difícil." },
] as const;

/** El modelo con que parte una entrada de perfil que se pasa a opencode, si está conectado. */
export const DEFAULT_OPENCODE_MODEL = "openai/gpt-6.1-terra";

export interface OpencodeRuntimeOptions {
  /** `CLANKER_HOME`: aquí quedan `transcripts/`, `agent-sessions/`, el entorno de los agentes y el plugin del reporte. */
  home: string;
  /** El entorno del core; de él solo se heredan PATH, HOME, USER, LANG, TMPDIR y las `XDG_*`. */
  baseEnv?: Record<string, string | undefined>;
  /** El precio de lista de un modelo; por defecto, el catálogo que opencode baja de models.dev. */
  priceOf?: PriceOf;
  /** El binario; por defecto `opencode` del PATH (el de la shell de login, que la app de escritorio ya copia). */
  executable?: string;
  /** Con `procs`, cada `opencode serve` y lo que lance el agente quedan registrados con el paso (`kind: "agent"`). */
  procs?: Procs;
  killAfterMs?: number;
  /** Los tests lo reemplazan para no lanzar opencode. */
  launch?: LaunchServer;
  /** Los tests lo reemplazan por un servidor falso. */
  api?: (server: { url: string; password: string }) => OpencodeApi;
  /** Los tests lo reemplazan para no correr `opencode --version` ni `opencode models`. */
  cli?: OpencodeCli;
  now?: () => number;
  /** Por defecto `STATUS_POLL_MS`. */
  pollMs?: number;
}

/** Lo que `resume` necesita y `ResumeSpec` no trae (modelo, prompt del rol, herramientas): se guarda al iniciar. */
interface StoredSession {
  spec: RunSpec;
}

type Stop = { status: Exclude<RunStatus, "success">; message: string; resetsAt?: number };

const emptyUsage = (): Usage => ({ turns: 0, tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0, costMicros: 0, costSource: "runtime" });

function clip(text: string): { text: string; truncated: boolean } {
  return text.length <= TRANSCRIPT_TEXT_MAX_CHARS ? { text, truncated: false } : { text: text.slice(0, TRANSCRIPT_TEXT_MAX_CHARS), truncated: true };
}

/** El transcript normalizado de una sesión, una entrada por línea (`entriesOf` las lee), escrito en orden. */
function createTranscriptWriter(file: string) {
  let chain: Promise<void> = Promise.resolve();
  let failure: unknown;
  return {
    append(entry: TranscriptEntry) {
      const line = `${JSON.stringify({ type: "clanker", subtype: "entry", entry })}\n`;
      chain = chain.then(() => appendFile(file, line)).catch((error: unknown) => void (failure ??= error));
    },
    async flush() {
      await chain;
      if (failure !== undefined) throw failure;
    },
  };
}

/**
 * Runtime `opencode` (opencode 2): cada run levanta su propio `opencode serve` (en el worktree, con el entorno sin
 * credenciales del agente, una contraseña de un uso y la config del run en `OPENCODE_CONFIG_CONTENT`), abre o retoma
 * una sesión con el agente `clanker` y le manda el brief. Un servidor por run porque su entorno y su config son los del
 * agente (prompt del rol, permisos, esquema del reporte) y porque bajar el grupo del paso baja todo lo que lanzó.
 *
 * opencode 2 no tiene salida estructurada: el reporte es la entrada de la herramienta `clanker_report` que registra el
 * plugin del core, con el esquema del modo. El modelo del perfil es `proveedor/modelo` de lo que opencode tenga
 * conectado; el effort va como variante solo si el modelo la tiene (una que no existe hace fallar la ejecución).
 * opencode reporta el costo de cada paso (`costPerTurn`). `maxTurns` y `maxBudgetUsd` los cuenta el adapter y
 * interrumpe; un error de cuota o de login se corta en el primer reintento.
 */
export function createOpencodeRuntime(options: OpencodeRuntimeOptions): AgentRuntime {
  const { home } = options;
  const baseEnv = options.baseEnv ?? process.env;
  const executable = options.executable ?? "opencode";
  const launchServer = options.launch ?? launchOpencodeServer;
  const apiFor = options.api ?? createOpencodeApi;
  const cli = options.cli ?? createOpencodeCli(executable, inheritedEnv(baseEnv));
  const now = options.now ?? Date.now;
  // El precio de lista de cada modelo, para estimar lo que cuesta un proveedor que reporta 0 (una suscripción).
  const priceOf: PriceOf = options.priceOf ?? catalogPrices(baseEnv);
  const pollMs = options.pollMs ?? STATUS_POLL_MS;
  const paths = {
    ghConfigDir: join(home, "agent-env", "opencode", "gh"),
    gitConfigs: join(home, "agent-env", "opencode", "gitconfig"),
    reportPlugin: join(home, "agent-env", "opencode", "report-plugin"),
    transcripts: join(home, "transcripts"),
    sessions: join(home, "agent-sessions"),
  };

  let prepared: Promise<void> | undefined;
  function prepare(): Promise<void> {
    prepared ??= (async () => {
      // Siempre vacía: lo que un agente haya dejado en una corrida anterior no cuenta como login de gh.
      await rm(paths.ghConfigDir, { recursive: true, force: true });
      await mkdir(paths.ghConfigDir, { recursive: true });
      await mkdir(paths.reportPlugin, { recursive: true });
      await mkdir(paths.transcripts, { recursive: true });
      await mkdir(paths.sessions, { recursive: true });
      await mkdir(paths.gitConfigs, { recursive: true });
      await writeFile(join(paths.reportPlugin, "index.js"), REPORT_PLUGIN_SOURCE);
    })().catch((error: unknown) => {
      prepared = undefined;
      throw error;
    });
    return prepared;
  }

  const storedOf = (sessionId: string) => join(paths.sessions, `${sessionId}.json`);

  async function launch(spec: RunSpec, prompt: string, resumeId: string | undefined): Promise<AgentRun> {
    const model = parseModel(spec.model);
    const password = randomBytes(24).toString("base64url");
    // La identidad de git del usuario en el repo del run (`RunSpec.gitIdentity`), como en el runtime de Claude.
    const gitConfig = await writeGitConfig(paths.gitConfigs, spec.gitIdentity);
    const server = await launchServer({
      executable,
      args: SERVE_ARGS,
      env: serverEnv({ baseEnv, ghConfigDir: paths.ghConfigDir, gitConfig, password, config: configFor(spec, paths.reportPlugin) }),
      cwd: spec.cwd,
      procs: options.procs,
      stepRunId: spec.stepRunId,
      killAfterMs: options.killAfterMs,
    });
    const api = apiFor({ url: server.url, password });
    const directory = spec.cwd;
    const events = createEventQueue<AgentEvent>();

    let sessionID: string;
    try {
      if (resumeId !== undefined) {
        sessionID = resumeId;
      } else {
        const variant = await variantFor(api, directory, model, spec.effort, events);
        sessionID = (await api.createSession({ directory, agent: OPENCODE_AGENT, model: { ...model, ...(variant === undefined ? {} : { variant }) }, title: spec.role })).id;
      }
    } catch (error) {
      server.close();
      events.close();
      throw error;
    }

    const transcript = createTranscriptWriter(transcriptFile(home, sessionID));
    transcript.append({ kind: "prompt", ...clip(prompt) });
    const translator = createTranslator(sessionID, priceOf);
    const tally = emptyUsage();
    const stopListening = new AbortController();

    /** Por qué el adapter cortó la sesión (tope, interrupción, cuota): manda sobre cómo diga opencode que terminó. */
    let stopped: Stop | undefined;
    let report: unknown;
    let lastText = "";
    let steps = 0;
    let prompted = 0;
    let end: { outcome: "succeeded" } | { outcome: "failed"; error: Stop } | { outcome: "interrupted"; reason: string } | undefined;
    let finish!: () => void;
    const ended = new Promise<void>((resolve) => (finish = resolve));

    const stop = (reason: Stop) => {
      if (stopped || end) return;
      stopped = reason;
      void api.interrupt(sessionID).catch(() => {});
      // Si opencode no confirma la interrupción, el run se cierra igual.
      setTimeout(finish, INTERRUPT_SETTLE_MS).unref();
    };

    const onEvent = (event: Parameters<ReturnType<typeof createTranslator>["handle"]>[0]) => {
      const t = translator.handle(event);
      for (const e of t.events) {
        events.push(e);
        if (e.type === "text") lastText = e.text;
        if (e.type !== "usage") continue;
        tally.turns += 1;
        tally.tokensIn += e.usage.tokensIn;
        tally.tokensOut += e.usage.tokensOut;
        tally.tokensCacheRead += e.usage.tokensCacheRead;
        tally.tokensCacheWrite += e.usage.tokensCacheWrite;
        tally.costMicros += e.usage.costMicros;
        // Con un paso estimado, el total también lo es.
        if (e.usage.costSource === "estimate") tally.costSource = "estimate";
      }
      for (const entry of t.transcript) transcript.append(entry);
      if (t.report !== undefined) report = t.report;
      if (t.step) {
        steps += 1;
        if (spec.maxTurns !== undefined && steps >= spec.maxTurns && t.step.finish === "tool-calls" && report === undefined) {
          stop({ status: "error_max_turns", message: `El agente llegó al tope de ${spec.maxTurns} turnos sin entregar su reporte.` });
        }
      }
      if (spec.maxBudgetUsd !== undefined && tally.costMicros > usdToMicros(spec.maxBudgetUsd)) {
        stop({ status: "error_max_budget_usd", message: `El agente gastó USD ${(tally.costMicros / 1_000_000).toFixed(2)}, más que el tope de USD ${spec.maxBudgetUsd}.` });
      }
      if (t.retry) {
        const cause = statusOfError(t.retry.error, now());
        if (cause.status !== "error") stop(cause);
        else if (t.retry.attempt > MAX_PROVIDER_RETRIES) stop({ status: "error", message: `opencode reintentó ${t.retry.attempt} veces sin éxito: ${t.retry.error.message}` });
      }
      if (t.blocked) stop({ status: "error", message: t.blocked });
      if (t.end && !end) {
        end = t.end.outcome === "failed" ? { outcome: "failed", error: statusOfError(t.end.error, now()) } : t.end;
        finish();
      }
    };

    const listening = (async () => {
      try {
        for await (const event of api.events(stopListening.signal)) onEvent(event);
      } catch (error) {
        if (stopListening.signal.aborted) return;
        // Los eventos no se reconectan: sin ellos no hay actividad en vivo, pero el sondeo sigue sabiendo cuándo terminó.
        events.push({ type: "error", kind: "other", message: `Se cortaron los eventos de opencode: ${error instanceof Error ? error.message : String(error)}` });
      }
    })();

    // Por si se pierde el fin de la ejecución en los eventos: la sesión dice cómo terminó su última ejecución.
    const poll = setInterval(() => {
      if (prompted === 0) return;
      // Un callback de timer nunca lanza: tumbaría el core.
      void api
        .session(sessionID)
        .then((info) => {
          if (end || info.time.idle === undefined || info.time.idle < prompted || info.outcome === undefined) return;
          end =
            info.outcome === "failed"
              ? { outcome: "failed", error: { status: "error", message: "opencode terminó con error (el detalle se perdió con los eventos)." } }
              : info.outcome === "interrupted"
                ? { outcome: "interrupted", reason: "user" }
                : { outcome: "succeeded" };
          finish();
        })
        .catch(() => {});
    }, pollMs);
    poll.unref();

    try {
      prompted = now();
      await api.prompt({ sessionID, text: prompt });
    } catch (error) {
      clearInterval(poll);
      stopListening.abort();
      server.close();
      events.close();
      throw error;
    }

    const finished = (async (): Promise<RunResult> => {
      const crash = await Promise.race([ended.then(() => undefined), server.exited]);
      clearInterval(poll);
      stopListening.abort();
      await listening;
      server.close();
      if (crash !== undefined && !stopped) throw new Error(crash);

      const result = conclude();
      transcript.append({
        kind: "result",
        subtype: result.status,
        isError: result.status !== "success",
        turns: steps,
        costUsd: tally.costMicros / 1_000_000,
        text: result.message ?? (lastText || null),
      });
      await transcript.flush();
      return result;
    })().finally(() => events.close());
    // Quien recibe el run espera `result` recién cuando `start` vuelve; si el servidor muere antes, no es un rechazo perdido.
    finished.catch(() => {});

    function conclude(): RunResult {
      const base = { text: lastText, usage: tally };
      if (stopped) {
        return {
          ...base,
          ...stopped,
          // Un tope que cae después de entregar el reporte no lo pierde: el core lo valida y lo usa.
          ...(stopped.status === "error_max_budget_usd" && report !== undefined ? { structured: report } : {}),
        };
      }
      if (end?.outcome === "failed") return { ...base, ...end.error };
      if (end?.outcome === "interrupted") return { ...base, status: "error", message: `opencode interrumpió la ejecución (${end.reason}) sin que el core lo pidiera.` };
      // Sin reporte el core lo trata como inválido y retoma la sesión pidiéndolo.
      return { ...base, status: "success", ...(report === undefined ? {} : { structured: report }) };
    }

    return {
      ref: { runtime: "opencode", sessionId: sessionID, cwd: directory },
      events,
      interrupt: async () => stop({ status: "error", message: "El run fue interrumpido." }),
      result: finished,
    };
  }

  /**
   * El effort como variante del modelo, solo si el modelo la tiene: una variante que no existe hace fallar la ejecución
   * entera (`provider.no-route`). Si no la tiene corre con la suya y queda un aviso.
   */
  async function variantFor(api: OpencodeApi, directory: string, model: Omit<ModelRef, "variant">, effort: RunSpec["effort"], events: { push(e: AgentEvent): void }) {
    if (effort === undefined) return undefined;
    const info = (await api.models(directory)).find((m) => m.providerID === model.providerID && (m.id === model.id || m.modelID === model.id));
    if (info?.variants?.some((v) => v.id === effort)) return effort;
    events.push({
      type: "error",
      kind: "other",
      message: `El modelo ${model.providerID}/${model.id} no tiene la variante "${effort}" en opencode: corre con la suya. Cambia el esfuerzo en el perfil para no ver este aviso.`,
    });
    return undefined;
  }

  let models: { at: number; list: string[] } | undefined;
  async function modelList(): Promise<string[]> {
    if (models && now() - models.at < MODELS_TTL_MS) return models.list;
    const list = parseModels(await cli(["models", "--standalone"]));
    models = { at: now(), list };
    return list;
  }

  async function probe(): Promise<string | undefined> {
    try {
      return versionProblem(await cli(["--version"]));
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  return {
    id: "opencode",
    capabilities: { structuredOutput: true, costPerTurn: true, resume: true, fork: false, steer: false },
    probe,

    async describe(): Promise<RuntimeOptions> {
      const base = {
        id: "opencode" as const,
        label: "opencode",
        about: "opencode 2 con los proveedores que tengas conectados (opencode auth login). El modelo va como proveedor/modelo.",
        efforts: Effort.options.map((id) => ({ id, about: "Va como variante del modelo; si el modelo no la tiene, corre con la suya." })),
      };
      const problem = await probe();
      if (problem !== undefined) return { ...base, available: false, message: problem, models: [] };
      try {
        const list = await modelList();
        const recommended = RECOMMENDED_MODELS.filter((m) => list.includes(m.id));
        const rest = list.filter((id) => !recommended.some((m) => m.id === id));
        return {
          ...base,
          available: true,
          ...(list.length === 0 ? { message: "opencode no tiene modelos: conecta un proveedor con opencode auth login." } : {}),
          models: [
            ...recommended.map(({ id, about }) => ({ id, label: id, about })),
            ...rest.map((id) => ({ id, label: id, about: `De ${id.slice(0, id.indexOf("/"))}, conectado en opencode.` })),
          ],
          ...(list.includes(DEFAULT_OPENCODE_MODEL) ? { defaultModel: DEFAULT_OPENCODE_MODEL } : {}),
        };
      } catch (error) {
        return { ...base, available: true, message: `No pude listar los modelos (opencode models): ${error instanceof Error ? error.message : String(error)}`, models: [] };
      }
    },

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
    throw new Error(`No hay registro de la sesión ${sessionId} en ${file}: el runtime opencode solo retoma las sesiones que él inició.`);
  }
}
