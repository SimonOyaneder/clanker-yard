import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { compileJsonSchema, Effort, type RuntimeOptions, type TranscriptEntry } from "@clanker/api";
import { messageOf } from "../../errors/format";
import type { Procs } from "../../procs/procs";
import type { Store } from "../../store/store";
import { agentDirsPreparer, createSessionStore, writeGitConfig } from "../agent-env";
import { createEventQueue } from "../event-queue";
import { estimateCostMicros } from "../pricing";
import { addUsage, emptyUsage, type AgentEvent, type AgentRun, type AgentRuntime, type RunResult, type RunSpec, type RunStatus } from "../runtime";
import { clip, createTranscriptAppender, entryRecord, transcriptFile } from "../transcripts";
import type { CodexMethods, JsonValue, ReasoningEffort } from "./api";
import { launchCodexAppServer, type CodexAppServer } from "./app-server";
import { codexEnv, threadOptions } from "./config";
import { codexReportSchema, normalizeCodexReport } from "./report-schema";
import { createCodexTranslator, statusOfCodexError } from "./translate";

const exec = promisify(execFile);
export const MIN_CODEX_VERSION = "0.169.1";
export const INTERRUPT_SETTLE_MS = 15_000;
export const MAX_PROVIDER_RETRIES = 6;
export const RECOMMENDED_CODEX_MODELS = ["gpt-6-luna", "gpt-6.1-terra", "gpt-6.1-sol"] as const;

type Model = CodexMethods["model/list"]["result"]["data"][number];
type Stop = { status: Exclude<RunStatus, "success">; message: string; resetsAt?: number };

function quotaResetAt(limits: CodexMethods["account/rateLimits/read"]["result"]): number | undefined {
  const snapshots = limits.rateLimitsByLimitId === null ? [limits.rateLimits] : Object.values(limits.rateLimitsByLimitId);
  const exhausted = snapshots.filter((snapshot) => [snapshot.primary, snapshot.secondary].some((window) => window !== null && window.usedPercent >= 100));
  if (exhausted.length !== 1 || exhausted[0]!.limitId === null) return undefined;
  const windows = [exhausted[0]!.primary, exhausted[0]!.secondary].flatMap((window) => window !== null && window.usedPercent >= 100 ? [window] : []);
  if (windows.some((window) => window.resetsAt === null)) return undefined;
  return Math.max(...windows.map((window) => window.resetsAt!)) * 1000;
}

export interface CodexRuntimeOptions {
  home: string;
  store: Pick<Store, "db">;
  baseEnv?: Record<string, string | undefined>;
  executable?: string;
  args?: string[];
  procs?: Procs;
  killAfterMs?: number;
  interruptSettleMs?: number;
}

export function createCodexRuntime(options: CodexRuntimeOptions): AgentRuntime {
  const { home, store } = options;
  const baseEnv = options.baseEnv ?? process.env;
  const executable = options.executable ?? "codex";
  const ghConfigDir = join(home, "agent-env", "codex", "gh");
  const gitConfigs = join(home, "agent-env", "codex", "gitconfig");
  const sessionDir = join(home, "agent-sessions");
  const sessions = createSessionStore(sessionDir, "codex");
  const prepare = agentDirsPreparer({ ghConfigDir, dirs: [gitConfigs, sessionDir, join(home, "transcripts")] });

  async function versionProblem(): Promise<string | undefined> {
    try {
      const { stdout } = await exec(executable, [...(options.args ?? []), "--version"], { env: codexEnv(baseEnv), timeout: 20_000 });
      const version = /(\d+)\.(\d+)\.(\d+)/.exec(stdout)?.slice(1).map(Number);
      if (!version) return `No pude leer la versión de Codex: ${stdout.trim()}.`;
      const minimum = MIN_CODEX_VERSION.split(".").map(Number);
      for (let i = 0; i < minimum.length; i++) {
        if (version[i]! > minimum[i]!) return undefined;
        if (version[i]! < minimum[i]!) return `Codex ${version.join(".")} es muy viejo: instala ${MIN_CODEX_VERSION} o más nuevo.`;
      }
      return undefined;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? `No encuentro "${executable}" en el PATH del core: instala Codex.`
        : messageOf(error);
    }
  }

  async function probe(): Promise<string | undefined> {
    const problem = await versionProblem();
    if (problem) return problem;
    await prepare();
    let server: CodexAppServer | undefined;
    try {
      server = await launchCodexAppServer({ cwd: home, executable, args: options.args, baseEnv, procs: options.procs, killAfterMs: options.killAfterMs });
      const account = await server.request("account/read", { refreshToken: false });
      if (account.requiresOpenaiAuth && account.account === null) return "Codex no tiene sesión: vuelve a iniciar sesión con `codex login`.";
      const limits = await server.request("account/rateLimits/read", { excludeResetCreditDetails: true });
      if (limits.ordinaryUsageAllowed === false) return "Codex no permite uso ordinario: espera a que se restablezca la cuota.";
      return undefined;
    } catch (error) {
      return messageOf(error);
    } finally {
      await server?.close();
    }
  }

  async function models(server: CodexAppServer): Promise<Model[]> {
    const list: Model[] = [];
    let cursor: string | null = null;
    do {
      const page: CodexMethods["model/list"]["result"] = await server.request("model/list", { cursor });
      list.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return list;
  }

  async function launch(spec: RunSpec, resumeId?: string): Promise<AgentRun> {
    const params = threadOptions(spec);
    const schema = codexReportSchema(spec.outputSchema);
    const validateReport = compileJsonSchema(spec.outputSchema);
    const gitConfig = await writeGitConfig(gitConfigs, spec.gitIdentity);
    const server = await launchCodexAppServer({
      cwd: spec.cwd, executable, args: options.args, baseEnv, git: { ghConfigDir, gitConfig },
      procs: options.procs, stepRunId: spec.stepRunId, killAfterMs: options.killAfterMs,
    });
    const events = createEventQueue<AgentEvent>();
    let threadId: string;
    let effort: ReasoningEffort | undefined;
    let account: CodexMethods["account/read"]["result"];
    let limits: CodexMethods["account/rateLimits/read"]["result"] | undefined;
    try {
      effort = spec.effort === "max" ? "xhigh" : spec.effort;
      if (spec.effort !== undefined) {
        const info = (await models(server)).find((model) => model.model === spec.model);
        if (info && !info.supportedReasoningEfforts.some((item) => item.reasoningEffort === effort)) {
          events.push({ type: "error", kind: "other", message: `Codex: ${spec.model} no admite el esfuerzo ${spec.effort}; corre con ${info.defaultReasoningEffort}.` });
          effort = info.defaultReasoningEffort;
        }
      }
      const response = resumeId === undefined
        ? await server.request("thread/start", params)
        : await server.request("thread/resume", { ...params, threadId: resumeId });
      threadId = response.thread.id;
      await sessions.save(threadId, spec);
      account = await server.request("account/read", { refreshToken: false });
      if (!account.requiresOpenaiAuth || account.account !== null) {
        limits = await server.request("account/rateLimits/read", { excludeResetCreditDetails: true }).catch(() => undefined);
      }
    } catch (error) {
      await server.close();
      events.close();
      throw error;
    }

    const translator = createCodexTranslator(threadId);
    const transcript = createTranscriptAppender();
    const record = (entry: TranscriptEntry) => transcript.append(transcriptFile(home, threadId), entryRecord(entry));
    record({ kind: "prompt", ...clip(spec.prompt) });
    const tally = emptyUsage("estimate");
    let estimatedCost = 0;
    let text = "";
    let report: unknown;
    let turnId: string | undefined;
    let stopped: Stop | undefined;
    let ended = false;
    let retries = 0;
    let confirmEnd!: () => void;
    const turnEnded = new Promise<void>((resolve) => { confirmEnd = resolve; });
    let interrupting: Promise<void> | undefined;

    const interrupt = (reason: Stop): Promise<void> => {
      if (ended) return Promise.resolve();
      if (interrupting) return interrupting;
      stopped = reason;
      interrupting = (async () => {
        if (turnId) {
          const timer = setTimeout(confirmEnd, options.interruptSettleMs ?? INTERRUPT_SETTLE_MS);
          try {
            void server.request("turn/interrupt", { threadId, turnId }).catch(() => {});
            await turnEnded;
          } finally {
            clearTimeout(timer);
          }
        }
        await server.close();
      })();
      return interrupting;
    };

    const listening = (async (): Promise<RunResult> => {
      try {
        let terminal: RunResult["status"] | undefined;
        let failure: string | undefined;
        for await (const notification of server.notifications) {
          const translated = translator.translate(notification);
          if (translated.text !== undefined) {
            text = translated.text;
            try {
              report = normalizeCodexReport(JSON.parse(text), spec.outputSchema);
            } catch {
              report = undefined;
            }
          }
          for (const event of translated.events) {
            events.push(event);
            if (event.type === "usage") {
              addUsage(tally, event.usage);
              estimatedCost += estimateCostMicros(store.db, event.model ?? spec.model, Date.now(), {
                ...event.usage, tokensCacheWrite1h: event.cacheWrite1hTokens ?? 0,
              }) ?? 0;
              if (spec.maxBudgetUsd !== undefined && estimatedCost > spec.maxBudgetUsd * 1_000_000) {
                void interrupt({ status: "error_max_budget_usd", message: `Codex superó el tope de USD ${spec.maxBudgetUsd}.` }).catch(() => {});
              } else if (spec.maxTurns !== undefined && tally.turns >= spec.maxTurns && !validateReport.safeParse(report).success) {
                void interrupt({ status: "error_max_turns", message: `Codex llegó al tope de ${spec.maxTurns} turnos sin reporte.` }).catch(() => {});
              }
            }
          }
          for (const entry of translated.transcript) record(entry);
          if (notification.method === "turn/started" && notification.params.threadId === threadId) turnId = notification.params.turn.id;
          if (translated.retry && ++retries > MAX_PROVIDER_RETRIES) {
            void interrupt({ status: "error", message: `Codex superó ${MAX_PROVIDER_RETRIES} reintentos del proveedor: ${translated.retry.message}` }).catch(() => {});
          }
          if (translated.error && translated.error.status !== "error") {
            const reason: Stop = { ...translated.error };
            if (reason.status === "quota_exhausted") {
              try {
                limits = await server.request("account/rateLimits/read", { excludeResetCreditDetails: true });
                reason.resetsAt = quotaResetAt(limits);
              } catch {
                reason.resetsAt = undefined;
              }
            }
            void interrupt(reason).catch(() => {});
          }
          if (translated.end) {
            confirmEnd();
            const turn = translated.end;
            if (turn.status === "completed") terminal = "success";
            else {
              const error = turn.error ? statusOfCodexError(turn.error) : { status: "error" as const, message: "Codex interrumpió el turno." };
              terminal = error.status;
              failure = error.message;
            }
            break;
          }
        }
        if (terminal === undefined && stopped === undefined) throw new Error(await server.exited);
        const status = stopped?.status ?? terminal!;
        const result: RunResult = {
          status,
          text,
          usage: tally,
          ...(stopped?.message || failure ? { message: stopped?.message ?? failure } : {}),
          ...(stopped?.resetsAt === undefined ? {} : { resetsAt: stopped.resetsAt }),
          ...((status === "success" || status === "error_max_budget_usd") && report !== undefined ? { structured: report } : {}),
        };
        record({ kind: "result", subtype: result.status, isError: result.status !== "success", turns: tally.turns, costUsd: estimatedCost / 1_000_000, text: result.message ?? (text || null) });
        await transcript.flush();
        return result;
      } finally {
        ended = true;
        confirmEnd();
        await server.close();
        events.close();
      }
    })();
    listening.catch(() => {});
    try {
      if (account.requiresOpenaiAuth && account.account === null) {
        await interrupt({ status: "login_expired", message: "Codex no tiene sesión: vuelve a iniciar sesión con `codex login`." });
      } else if (limits?.ordinaryUsageAllowed === false) {
        await interrupt({ status: "quota_exhausted", message: "Codex no permite uso ordinario: espera a que se restablezca la cuota.", resetsAt: quotaResetAt(limits) });
      } else {
        const { turn } = await server.request("turn/start", { threadId, input: [{ type: "text", text: spec.prompt }], effort, outputSchema: schema as JsonValue });
        turnId = turn.id;
      }
    } catch (error) {
      await server.close();
      await listening.catch(() => {});
      throw error;
    }
    return { ref: { runtime: "codex", sessionId: threadId, cwd: spec.cwd }, events, result: listening, interrupt: () => interrupt({ status: "error", message: "El run fue interrumpido." }) };
  }

  return {
    id: "codex",
    capabilities: { costPerTurn: false },
    probe,
    async describe(): Promise<RuntimeOptions> {
      const base = { id: "codex" as const, label: "Codex", about: "Codex con el login del binario instalado.", models: [], efforts: [] };
      const problem = await versionProblem();
      if (problem) return { ...base, available: false, message: problem };
      await prepare();
      const server = await launchCodexAppServer({ cwd: home, executable, args: options.args, baseEnv, procs: options.procs, killAfterMs: options.killAfterMs });
      try {
        const list = await models(server);
        const recommended = RECOMMENDED_CODEX_MODELS.flatMap((id) => list.filter((model) => model.model === id));
        const ordered = [...recommended, ...list.filter((model) => !RECOMMENDED_CODEX_MODELS.some((id) => id === model.model))];
        const efforts = [...new Set(list.flatMap((model) => model.supportedReasoningEfforts.map((item) => item.reasoningEffort)))];
        const defaultModel = list.find((model) => model.isDefault)?.model;
        return {
          ...base, available: true,
          models: ordered.map((model) => ({ id: model.model, label: model.displayName, about: recommended.includes(model) ? "Recomendado, de menos a más potente." : "Disponible en Codex." })),
          efforts: Effort.options.filter((id) => efforts.includes(id === "max" ? "xhigh" : id)).map((id) => ({ id, about: id === "max" ? "El esfuerzo xhigh de Codex." : `Esfuerzo ${id} de Codex.` })),
          ...(defaultModel === undefined ? {} : { defaultModel }),
        };
      } finally {
        await server.close();
      }
    },
    async start(spec) {
      await prepare();
      return launch(spec);
    },
    async resume(ref, message, changes) {
      await prepare();
      return launch({ ...(await sessions.load(ref.sessionId)), ...changes, cwd: ref.cwd, prompt: message }, ref.sessionId);
    },
  };
}
