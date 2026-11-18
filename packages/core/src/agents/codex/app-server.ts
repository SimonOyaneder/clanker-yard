import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { BadRequestError } from "../../errors/domain";
import { KILL_GROUP_AFTER_MS, killGroup, type Procs } from "../../procs/procs";
import { createEventQueue } from "../event-queue";
import type { CodexMethods, CodexNotification, RpcError, RpcMessage, ThreadParams } from "./api";
import { CODEX_ARGS, codexEnv, isolatedThreadConfig } from "./config";

const REQUEST_TIMEOUT_MS = 30_000;
const STDERR_TAIL_CHARS = 2000;

export class CodexRpcError extends BadRequestError {
  constructor(method: string, readonly rpc: RpcError) {
    super(`codex app-server rechazó ${method} (${rpc.code}): ${rpc.message}`);
  }
}

export interface CodexAppServer {
  request<M extends keyof CodexMethods>(method: M, params: CodexMethods[M]["params"]): Promise<CodexMethods[M]["result"]>;
  notifications: AsyncIterable<CodexNotification>;
  exited: Promise<string>;
  close(): Promise<void>;
}

export interface CodexAppServerOptions {
  cwd: string;
  executable?: string;
  args?: string[];
  baseEnv?: Record<string, string | undefined>;
  git?: { ghConfigDir: string; gitConfig: string };
  version?: string;
  procs?: Procs;
  stepRunId?: string;
  requestTimeoutMs?: number;
  killAfterMs?: number;
}

export async function launchCodexAppServer({
  cwd, executable = "codex", args = CODEX_ARGS, baseEnv = process.env, version = "0.0.0",
  procs, stepRunId, requestTimeoutMs = REQUEST_TIMEOUT_MS, killAfterMs, git,
}: CodexAppServerOptions): Promise<CodexAppServer> {
  const child = spawn(executable, args, { cwd, env: codexEnv(baseEnv, git), detached: true, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const notifications = createEventQueue<CodexNotification>();
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; method: string }>();
  let nextId = 0;
  let stderr = "";
  let stopped: Error | undefined;
  let closing = false;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS); });

  const fail = (error: Error) => {
    stopped ??= error;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(stopped);
    }
    pending.clear();
    notifications.close();
  };
  child.on("error", (error: NodeJS.ErrnoException) => {
    fail(error.code === "ENOENT" ? new BadRequestError(`No encuentro "${executable}" en el PATH del core: instala Codex.`) : error);
  });
  child.stdin.on("error", () => {});
  const pgid = child.pid!;
  child.once("exit", () => {
    try {
      process.kill(-pgid, "SIGTERM");
    } catch {
      return;
    }
    const hardKill = setTimeout(() => {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        return;
      }
    }, killAfterMs ?? KILL_GROUP_AFTER_MS);
    hardKill.unref();
  });
  const exited = new Promise<string>((resolve) => {
    child.once("close", (code, signal) => {
      const reason = `codex app-server terminó (${signal ?? `código ${code}`}): ${stderr.trim() || "sin stderr"}`;
      fail(new BadRequestError(reason));
      resolve(reason);
    });
  });
  const close = async () => {
    if (!closing) {
      closing = true;
      fail(new BadRequestError("codex app-server cerrado"));
      child.stdin.end();
      killGroup(child, killAfterMs);
    }
    await exited;
  };
  const send = (message: object) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line) as RpcMessage;
      if (message.method !== undefined) {
        if (message.id !== undefined) {
          const legacy = message.method === "execCommandApproval" || message.method === "applyPatchApproval";
          if (legacy || message.method === "item/commandExecution/requestApproval" || message.method === "item/fileChange/requestApproval") {
            send({ id: message.id, result: { decision: legacy ? { denied: { rejection: "Clanker Yard no aprueba comandos del agente" } } : "decline" } });
          } else {
            send({ id: message.id, error: { code: -32601, message: "Clanker Yard no atiende requests del servidor" } });
          }
        } else {
          notifications.push(message as CodexNotification);
        }
      } else if (typeof message.id === "number") {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if ("error" in message) entry.reject(new CodexRpcError(entry.method, message.error));
        else entry.resolve(message.result);
      }
    } catch {
      fail(new BadRequestError("codex app-server envió JSONL inválido"));
      killGroup(child, killAfterMs);
    }
  });
  function call<T>(method: string, params: unknown): Promise<T> {
    if (stopped) return Promise.reject(stopped);
    const id = ++nextId;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new BadRequestError(`codex app-server no respondió ${method} en ${requestTimeoutMs} ms`));
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer, method });
      send({ id, method, params });
    }) as Promise<T>;
  }
  try {
    procs?.track(child, { kind: "agent", stepRunId });
    await call("initialize", { clientInfo: { name: "clanker_yard", title: "Clanker Yard", version } });
    send({ method: "initialized", params: {} });
    return {
      async request<M extends keyof CodexMethods>(method: M, params: CodexMethods[M]["params"]): Promise<CodexMethods[M]["result"]> {
        if (method === "thread/start" || method === "thread/resume") {
          const input = params as ThreadParams & { threadId?: string };
          const threadCwd = input.cwd ?? (method === "thread/resume"
            ? (await call<{ thread: { cwd: string } }>("thread/read", { threadId: input.threadId })).thread.cwd
            : cwd);
          const effective = await call<CodexMethods["config/read"]["result"]>("config/read", { cwd: threadCwd });
          return call(method, { ...input, cwd: threadCwd, approvalPolicy: "never", config: isolatedThreadConfig(effective.config, input.config) });
        }
        return call(method, params);
      },
      notifications,
      exited,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
