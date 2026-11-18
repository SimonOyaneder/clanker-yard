import { execFile } from "node:child_process";
import { access, constants, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { promisify } from "node:util";
import type { CodexStatus } from "@clanker/api";
import { messageOf } from "../../errors/format";
import type { Procs } from "../../procs/procs";
import { CodexRpcError, launchCodexAppServer, type CodexAppServer } from "./app-server";
import { MIN_CODEX_VERSION } from "./codex-runtime";
import { codexEnv } from "./config";
import { CodexLimits, codexStatusWithLimits } from "./usage";

const exec = promisify(execFile);

export interface CodexProbeOptions {
  cwd?: string;
  baseEnv?: Record<string, string | undefined>;
  executable?: string;
  args?: string[];
  procs?: Procs;
}

async function findCodex(env: Record<string, string | undefined>, cwd: string): Promise<string | undefined> {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = resolve(cwd, dir, "codex");
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function probeCodex(options: CodexProbeOptions): Promise<{ status: CodexStatus; limits?: CodexLimits }> {
  const cwd = options.cwd ?? tmpdir();
  const baseEnv = options.baseEnv ?? process.env;
  const executable = options.executable ?? await findCodex(baseEnv, cwd);
  if (executable === undefined) {
    return { status: { state: "not_installed", message: "No encuentro Codex en el PATH del core: instálalo, ejecuta `codex login` y vuelve a probar." } };
  }
  let status: CodexStatus = { state: "ready", executable };
  let server: CodexAppServer | undefined;
  try {
    const { stdout } = await exec(executable, [...(options.args ?? []), "--version"], {
      cwd, env: codexEnv(baseEnv), timeout: 20_000,
    });
    const version = /\d+\.\d+\.\d+/.exec(stdout)?.[0];
    if (version === undefined) return { status: { ...status, state: "error", message: "No pude leer la versión de Codex." } };
    status = { ...status, version };
    const installed = version.split(".").map(Number);
    const minimum = MIN_CODEX_VERSION.split(".").map(Number);
    const different = installed.findIndex((part, i) => part !== minimum[i]);
    if (different !== -1 && installed[different]! < minimum[different]!) {
      return { status: { ...status, state: "outdated", message: `Codex ${version} es anterior a la versión mínima ${MIN_CODEX_VERSION}: actualízalo y vuelve a probar.` } };
    }
    server = await launchCodexAppServer({ cwd, baseEnv, executable, args: options.args, procs: options.procs });
    const { account } = await server.request("account/read", { refreshToken: false });
    if (account?.type !== "chatgpt") {
      return { status: { ...status, state: "login_required", message: account?.type === "apiKey"
        ? "Codex está usando una API key, no la suscripción: ejecuta `codex login` con tu cuenta de ChatGPT y vuelve a probar."
        : "Codex necesita una sesión de ChatGPT: ejecuta `codex login` con tu cuenta y vuelve a probar." } };
    }
    status = { ...status, plan: account.planType };
    const limits = CodexLimits.parse(await server.request("account/rateLimits/read", { excludeResetCreditDetails: true }));
    return { status: codexStatusWithLimits(status, limits), limits };
  } catch (error) {
    const loginExpired = error instanceof CodexRpcError && /\b(?:401|unauthorized|authentication required)\b/i.test(error.rpc.message);
    const state = (error as NodeJS.ErrnoException).code === "ENOENT" ? "not_installed"
      : loginExpired ? "login_expired" : "error";
    return {
      status: {
        ...status,
        state,
        message: state === "login_expired"
          ? "La sesión de Codex venció o fue rechazada: ejecuta `codex login` y vuelve a probar."
          : messageOf(error),
      },
    };
  } finally {
    await server?.close();
  }
}
