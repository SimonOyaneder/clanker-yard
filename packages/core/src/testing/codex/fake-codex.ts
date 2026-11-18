import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodexNotification, JsonValue, RateLimitSnapshot, RpcMessage, Turn, TurnError } from "../../agents/codex/api";

export const CODEX_FAKE_EVIDENCE = {
  version: "0.169.1",
  modelNotFound: "docs/codex-subscription.md §8: captura real",
  quota_exhausted: "según tipos, sin captura real",
  login_expired: "según tipos, sin captura real",
  ordinaryUsageAllowed: "false: según tipos, sin captura real",
};

export interface FakeCodexOptions {
  scenario?: "ready" | "quota_exhausted" | "login_expired" | "crash";
  fragment?: boolean;
  silent?: string[];
  approval?: string;
  startupCrash?: boolean;
  child?: boolean | "ignoreSigterm";
  holdTurn?: boolean;
  reverseReplies?: boolean;
  malformed?: boolean;
  accountEmail?: string;
}

export async function createFakeCodex(dir: string, options: FakeCodexOptions = {}) {
  const script = join(dir, "fake-codex.mjs");
  const requests = join(dir, "requests.jsonl");
  const childPid = join(dir, "child.pid");
  const pidFile = join(dir, "server.pid");
  const environment = join(dir, "environment.json");
  await writeFile(script, `import { createInterface } from "node:readline";
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
(${fakeProcess.toString()})(${JSON.stringify({ ...options, requests, childPid, pidFile, environment })}, { createInterface, fs, spawn });`);
  return { executable: process.execPath, args: [script], requests, childPid, pidFile, environment };
}

async function fakeProcess(
  options: FakeCodexOptions & { requests: string; childPid: string; pidFile: string; environment: string },
  { createInterface, fs, spawn }: { createInterface: typeof import("node:readline").createInterface; fs: typeof import("node:fs/promises"); spawn: typeof import("node:child_process").spawn },
) {
  await fs.writeFile(options.pidFile, String(process.pid));
  await fs.writeFile(options.environment, JSON.stringify(process.env));
  let writes = Promise.resolve();
  const send = (message: object) => {
    const line = `${JSON.stringify(message)}\n`;
    writes = writes.then(async () => {
      if (options.fragment) {
        const middle = Math.floor(line.length / 2);
        process.stdout.write(line.slice(0, middle));
        await new Promise<void>((resolve) => setImmediate(resolve));
        process.stdout.write(line.slice(middle));
      } else {
        process.stdout.write(line);
      }
    });
  };
  const emit = (event: CodexNotification) => send(event);
  const crash = () => {
    process.stderr.write(`${"x".repeat(2100)}\nfalló la configuración de Codex`, () => process.exit(1));
  };
  process.stdout.on("error", () => process.exit(1));
  if (options.startupCrash) return crash();
  if (options.child === "ignoreSigterm") {
    spawn("sh", ["-c", 'trap "" TERM; echo $$ > "$1"; exec sleep 300', "sh", options.childPid], { stdio: "inherit" });
  } else if (options.child) {
    const child = spawn("sleep", ["300"], { stdio: "ignore" });
    await fs.writeFile(options.childPid, String(child.pid));
  }
  let initialized = false;
  let handshaken = false;
  let count = 0;
  const threads = new Map<string, { id: string; cwd: string | undefined; turns: Turn[] }>();
  let currentModel: string | undefined;
  let active: { threadId: string; turn: Turn } | undefined;
  let accountReply: (() => void) | undefined;
  const limits: RateLimitSnapshot = {
    limitId: "codex",
    primary: { usedPercent: options.scenario === "quota_exhausted" ? 100 : 4, windowDurationMins: 10080, resetsAt: 1795542935 },
    secondary: null, credits: null, spendControlReached: false,
  };
  const finish = (status: Turn["status"], error: TurnError | null = null) => {
    const { threadId, turn } = active!;
    emit({ method: "turn/completed", params: { threadId, turn: { ...turn, status, error } } });
  };
  const handle = async (message: RpcMessage) => {
    await fs.appendFile(options.requests, `${JSON.stringify(message)}\n`);
    if (message.method === undefined) return;
    if (options.silent?.includes(message.method)) return;
    if (message.method === "initialized") {
      initialized = handshaken;
      return;
    }
    if (message.id === undefined) return;
    const ok = (result: unknown) => send({ id: message.id, result });
    const error = (code: number, text: string) => send({ id: message.id, error: { code, message: text } });
    const params = message.params as { cwd?: string; threadId?: string; model?: string; config?: Record<string, JsonValue>; clientInfo?: unknown };
    if (message.method === "initialize") {
      if (handshaken) return error(-32600, "Already initialized");
      handshaken = true;
      return ok({ userAgent: "codex/0.169.1" });
    }
    if (!initialized) return error(-32600, "Not initialized");
    switch (message.method) {
      case "account/read":
        accountReply = () => ok({ account: options.scenario === "login_expired" ? null : { type: "chatgpt", email: options.accountEmail ?? null, planType: "self_serve_business_prolite", workspaceName: null }, requiresOpenaiAuth: true });
        if (!options.reverseReplies) accountReply();
        return;
      case "account/rateLimits/read":
        return ok({ ordinaryUsageAllowed: options.scenario !== "quota_exhausted", rateLimits: limits, rateLimitsByLimitId: { codex: limits } });
      case "model/list":
        if (options.malformed) {
          process.stdout.write("{invalid\n");
          return;
        }
        ok({ data: [{ id: "gpt-5.6-luna", model: "gpt-5.6-luna", displayName: "Luna", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Low" }], defaultReasoningEffort: "low", isDefault: true }], nextCursor: null });
        if (options.reverseReplies) accountReply!();
        return;
      case "config/read":
        return ok({ config: { mcp_servers: { sentinel: { command: "false", enabled: true }, ...(params.cwd?.endsWith("project") && { project_sentinel: { command: "false", enabled: true } }) } } });
      case "thread/start":
      case "thread/resume": {
        currentModel = params.model;
        const thread = { id: params.threadId ?? `thread_${++count}`, cwd: params.cwd, turns: [] };
        threads.set(thread.id, thread);
        return ok({ thread });
      }
      case "thread/read":
        return ok({ thread: threads.get(params.threadId!) });
      case "turn/interrupt":
        ok({});
        finish("interrupted");
        return;
      case "turn/start": {
        const threadId = params.threadId!;
        const turn: Turn = { id: `turn_${++count}`, items: [], status: "inProgress", error: null };
        active = { threadId, turn };
        ok({ turn });
        emit({ method: "turn/started", params: { threadId, turn } });
        if (options.scenario === "crash") return crash();
        if (options.approval) send({ id: "approval_1", method: options.approval, params: { threadId, turnId: turn.id, itemId: "command_1", command: "false" } });
        if (options.holdTurn) return;
        const kind = currentModel === "missing" ? "modelNotFound"
          : options.scenario === "quota_exhausted" ? "usageLimitExceeded"
          : options.scenario === "login_expired" ? "unauthorized" : undefined;
        if (kind) {
          const failure: TurnError = { message: kind, codexErrorInfo: kind, additionalDetails: null };
          emit({ method: "error", params: { threadId, turnId: turn.id, error: failure, willRetry: false } });
          finish("failed", failure);
          return;
        }
        const item = { type: "agentMessage" as const, id: "item_1", text: "Listo." };
        emit({ method: "item/started", params: { threadId, turnId: turn.id, item: { ...item, text: "" } } });
        emit({ method: "item/agentMessage/delta", params: { threadId, turnId: turn.id, itemId: item.id, delta: item.text } });
        emit({ method: "item/completed", params: { threadId, turnId: turn.id, item } });
        const usage = { totalTokens: 112, inputTokens: 100, cachedInputTokens: 80, cacheWriteInputTokens: 0, outputTokens: 12, reasoningOutputTokens: 2 };
        emit({ method: "thread/tokenUsage/updated", params: { threadId, turnId: turn.id, tokenUsage: { total: usage, last: usage, modelContextWindow: 200000 } } });
        emit({ method: "account/rateLimits/updated", params: { rateLimits: { ...limits, spendControlReached: null } } });
        finish("completed");
        return;
      }
      default:
        error(-32601, "Method not found");
    }
  };
  let chain = Promise.resolve();
  createInterface({ input: process.stdin }).on("line", (line) => {
    chain = chain.then(() => handle(JSON.parse(line) as RpcMessage)).catch(() => {
      process.stderr.write("fake-codex: request inválida", () => process.exit(1));
    });
  }).on("close", () => { void chain.then(() => writes).then(() => process.exit(0)); });
}
