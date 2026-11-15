import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeStatus, ClaudeUsageWindow } from "@clanker/api";
import * as z from "zod";
import type { QueryFn } from "./claude-runtime";
import type { ClaudeCredentials } from "./credentials";
import { inheritedEnv } from "./options";
import {
  credentialMismatch,
  KEY_REJECTED_MESSAGE,
  noteSignals,
  outcomeOf,
  type Signals,
} from "./outcome";

/** `rate_limit_event` (lo que alimenta el uso) exige Claude Code 2.1.181 o más nuevo (`docs/claude-subscription.md`). */
export const MIN_CLAUDE_VERSION = "2.1.181";

export const NOT_INSTALLED_MESSAGE =
  "No encuentro Claude Code en el PATH: instálalo (https://code.claude.com/docs/en/setup), inicia sesión con `claude auth login` y vuelve a probar.";

/** Corre un comando y entrega su salida estándar aunque termine con código distinto de 0 (`auth status` lo hace sin sesión). */
export type ExecFn = (file: string, args: string[], env: Record<string, string>) => Promise<string>;

export const execClaude: ExecFn = (file, args, env) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { env, timeout: 15_000, encoding: "utf8" }, (error, stdout) => {
      // Un exit distinto de 0 con salida es un resultado; sin salida (no se pudo lanzar, timeout) es un fallo.
      if (error && stdout === "") reject(error);
      else resolve(stdout);
    });
  });

export interface ProbeOptions {
  credentials: ClaudeCredentials;
  baseEnv: Record<string, string | undefined>;
  query: QueryFn;
  exec?: ExecFn;
}

/** Lo que `claude auth status` dice; el resto de sus campos no se usa. */
const AuthStatus = z.object({
  loggedIn: z.boolean(),
  subscriptionType: z.string().optional(),
});

/** Las dos barras de la suscripción dentro de `rate_limit_event`; el SDK no las tipa, así que son opcionales. */
const UnifiedWindows = z.object({
  five_hour: z.object({ utilization: z.number(), resetsAt: z.number().optional() }).optional(),
  seven_day: z.object({ utilization: z.number(), resetsAt: z.number().optional() }).optional(),
});

/**
 * Prueba una credencial de Claude de menor a mayor costo (`docs/design.html#d-ui`, "Onboarding"):
 * con suscripción, el `claude` instalado, su versión y su login (sin gastar cuota); después, para las
 * dos, una llamada mínima (haiku, un turno, sin herramientas) de la que salen el plan, el uso y si la
 * cuota o el login están en regla. Nunca lanza por un problema de Claude: lo devuelve como `state`.
 */
export async function probeClaude({
  credentials,
  baseEnv,
  query,
  exec = execClaude,
}: ProbeOptions): Promise<ClaudeStatus> {
  const { mode, executable } = credentials;
  const env = { ...inheritedEnv(baseEnv), ...credentials.env() };
  const status = (fields: Omit<ClaudeStatus, "mode">): ClaudeStatus => ({
    mode,
    ...(executable === undefined ? {} : { executable }),
    ...fields,
  });

  let version: string | undefined;
  let plan: string | undefined;
  if (mode === "subscription") {
    if (executable === undefined) return status({ state: "not_installed", message: NOT_INSTALLED_MESSAGE });
    try {
      version = /\d+\.\d+\.\d+/.exec(await exec(executable, ["--version"], env))?.[0];
      if (version !== undefined && compareVersions(version, MIN_CLAUDE_VERSION) < 0) {
        return status({
          state: "outdated",
          version,
          message: `Claude Code ${version} es anterior a la ${MIN_CLAUDE_VERSION}, la mínima para leer el uso de la cuota: actualízalo con \`claude update\`.`,
        });
      }
      const login = AuthStatus.safeParse(parseJson(await exec(executable, ["auth", "status", "--json"], env)));
      if (!login.success) {
        return status({
          state: "error",
          ...(version === undefined ? {} : { version }),
          message: "No pude leer la salida de `claude auth status --json`: ¿es una versión de Claude Code que no conozco?",
        });
      }
      if (!login.data.loggedIn) {
        return status({
          state: "login_required",
          ...(version === undefined ? {} : { version }),
          message: "Claude Code no tiene una sesión iniciada: corre `claude auth login` y vuelve a probar.",
        });
      }
      plan = login.data.subscriptionType;
    } catch (error) {
      return status({ state: "error", message: `No pude ejecutar ${executable}: ${(error as Error).message}` });
    }
  }

  const signals: Signals = { loginFailed: false };
  let initVersion: string | undefined;
  let usage: ClaudeStatus["usage"];
  let mismatch: string | undefined;
  let final: SDKResultMessage | undefined;
  let crash: unknown;
  try {
    const stream = query({
      prompt: "Responde solo con la palabra: pong",
      options: {
        cwd: tmpdir(),
        model: "haiku",
        env,
        ...(executable === undefined ? {} : { pathToClaudeCodeExecutable: executable }),
        settingSources: [],
        tools: [],
        persistSession: false,
        maxTurns: 1,
      },
    });
    for await (const message of stream) {
      noteSignals(message, signals);
      if (message.type === "system" && message.subtype === "init") {
        initVersion = message.claude_code_version;
        mismatch ??= credentialMismatch(mode, message.apiKeySource);
      } else if (message.type === "rate_limit_event") {
        usage = usageOf(message.rate_limit_info, usage);
      } else if (message.type === "result") {
        final = message;
      }
    }
  } catch (error) {
    // Tras un `result` con error el SDK lanza: el estado sale del `result` y de las señales.
    crash = error;
  }

  version ??= initVersion;
  const found = {
    ...(version === undefined ? {} : { version }),
    ...(plan === undefined ? {} : { plan }),
    ...(usage === undefined ? {} : { usage }),
  };
  if (mismatch !== undefined) return status({ state: "error", message: mismatch, ...found });
  if (final === undefined && !signals.loginFailed && signals.quota === undefined) {
    const reason = crash instanceof Error ? crash.message : "terminó sin respuesta";
    return status({ state: "error", message: `La llamada de prueba a Claude falló: ${reason}`, ...found });
  }

  const outcome = outcomeOf(final, signals, mode);
  switch (outcome.status) {
    case "success":
      return status({ state: "ready", ...found });
    case "quota_exhausted":
      return status({
        state: "quota_exhausted",
        message: outcome.message,
        ...found,
        ...(outcome.resetsAt === undefined ? {} : { resetsAt: outcome.resetsAt }),
      });
    case "login_expired":
      return status({
        state: mode === "api-key" ? "key_rejected" : "login_expired",
        message: outcome.message ?? KEY_REJECTED_MESSAGE,
        ...found,
      });
    default:
      return status({ state: "error", message: outcome.message ?? "La llamada de prueba a Claude falló.", ...found });
  }
}

type RateLimitInfo = Extract<SDKMessage, { type: "rate_limit_event" }>["rate_limit_info"];

/** Las barras de 5 h y 7 días del evento de límites, de `unifiedWindows` o, sin él, de la ventana que reporta. */
function usageOf(info: RateLimitInfo, previous: ClaudeStatus["usage"]): ClaudeStatus["usage"] {
  const windows = UnifiedWindows.safeParse((info as { unifiedWindows?: unknown }).unifiedWindows);
  const window = (w: { utilization: number; resetsAt?: number | undefined } | undefined): ClaudeUsageWindow | undefined =>
    w && { utilization: w.utilization, ...(w.resetsAt === undefined ? {} : { resetsAt: w.resetsAt * 1000 }) };
  const reported = window(
    info.utilization === undefined ? undefined : { utilization: info.utilization, resetsAt: info.resetsAt },
  );
  const fiveHour = window(windows.data?.five_hour) ?? (info.rateLimitType === "five_hour" ? reported : undefined);
  const sevenDay = window(windows.data?.seven_day) ?? (info.rateLimitType === "seven_day" ? reported : undefined);
  const next = { ...previous, ...(fiveHour && { fiveHour }), ...(sevenDay && { sevenDay }) };
  return Object.keys(next).length === 0 ? previous : next;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
