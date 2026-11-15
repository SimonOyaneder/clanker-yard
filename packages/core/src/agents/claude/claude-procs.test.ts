import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createProcs } from "../../procs/procs";
import { procs as procsTable } from "../../store/schema";
import { openStore, type Store } from "../../store/store";
import type { RunSpec } from "../runtime";
import { createClaudeRuntime, type QueryFn } from "./claude-runtime";
import { subscriptionCredentials } from "./credentials";

// El proceso de Claude Code lo lanza `spawnClaudeCodeProcess`: aquí un `query` falso lo invoca como el
// SDK, pero con `sleep` en lugar de `claude`. No se llama a Claude.

let home: string;
let store: Store;
let pids: number[];
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "claude-procs-"));
  store = openStore({ path: ":memory:" });
  pids = [];
});
afterEach(async () => {
  for (const pid of pids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Ya terminó.
    }
  }
  store.close();
  await rm(home, { recursive: true, force: true });
});

const spec = (overrides: Partial<RunSpec> = {}): RunSpec => ({
  role: "dev",
  cwd: home,
  systemPrompt: "Eres el dev.",
  prompt: "Haz lo tuyo.",
  model: "haiku",
  native: { sources: [], skills: [] },
  references: [],
  hooks: false,
  tools: "all",
  outputSchema: { type: "object" },
  ...overrides,
});

const init = { type: "system", subtype: "init", apiKeySource: "none", session_id: "sess-1" } as unknown as SDKMessage;

/**
 * Como el SDK: lanza el proceso con `spawnClaudeCodeProcess`, anuncia la sesión y espera a que lo
 * aborten; entonces, tras su cierre ordenado, aborta la señal que le reenvía al spawn.
 */
function sdkLike(launched: (pid: number) => void, command: { command: string; args: string[] } = { command: "sleep", args: ["60"] }): QueryFn {
  return ({ options }: { options: Options }) =>
    (async function* () {
      const forwarded = new AbortController();
      options.abortController!.signal.addEventListener("abort", () => forwarded.abort(), { once: true });
      const child = options.spawnClaudeCodeProcess!({ ...command, cwd: home, env: {}, signal: forwarded.signal });
      // `SpawnedProcess` no declara `pid`, pero lo que devuelve el spawn es un `ChildProcess`.
      const { pid } = child as unknown as { pid: number };
      pids.push(pid);
      launched(pid);
      yield init;
      await new Promise((resolve) => child.once("exit", resolve));
      throw new Error("Claude Code process aborted by user");
    })();
}

const rows = () => store.db.select().from(procsTable).all();

test("el proceso de Claude Code arranca en su propio grupo, queda en procs con su paso y un interrupt lo baja entero", async () => {
  const procs = createProcs({ store, bootId: "boot_now" });
  let pid = 0;
  const runtime = createClaudeRuntime({
    credentials: async () => subscriptionCredentials({ executable: "/bin/claude" }),
    home,
    procs,
    query: sdkLike((launched) => (pid = launched)),
  });

  const run = await runtime.start(spec({ stepRunId: "stp_1" }));

  expect(rows()).toMatchObject([{ pid, pgid: pid, bootId: "boot_now", kind: "agent", stepRunId: "stp_1" }]);
  expect(process.kill(-pid, 0)).toBe(true);

  await run.interrupt();
  await run.result;
  await vi.waitFor(() => expect(rows()).toEqual([]));
  expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
});

test("un proceso que ignora el SIGTERM del interrupt cae con SIGKILL a los killAfterMs", async () => {
  const procs = createProcs({ store, bootId: "boot_now" });
  let pid = 0;
  const runtime = createClaudeRuntime({
    credentials: async () => subscriptionCredentials({ executable: "/bin/claude" }),
    home,
    procs,
    killAfterMs: 300,
    query: sdkLike((launched) => (pid = launched), { command: "sh", args: ["-c", "trap '' TERM; while :; do sleep 1; done"] }),
  });
  const run = await runtime.start(spec({ stepRunId: "stp_1" }));

  await run.interrupt();
  await new Promise((resolve) => setTimeout(resolve, 100));
  // El SIGTERM ya salió y el proceso lo ignora: sigue vivo hasta que se cumple el plazo.
  expect(process.kill(-pid, 0)).toBe(true);

  await run.result;
  await vi.waitFor(() => expect(rows()).toEqual([]));
  expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
});

test("un crash del core deja la fila y el próximo arranque mata el proceso del agente", async () => {
  const procs = createProcs({ store, bootId: "boot_old" });
  let pid = 0;
  const runtime = createClaudeRuntime({
    credentials: async () => subscriptionCredentials({ executable: "/bin/claude" }),
    home,
    procs,
    query: sdkLike((launched) => (pid = launched)),
  });
  await runtime.start(spec({ stepRunId: "stp_1" }));
  expect(rows()).toHaveLength(1);

  expect(createProcs({ store, bootId: "boot_new" }).killOrphans()).toBe(1);

  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(/ESRCH/));
  expect(rows()).toEqual([]);
});

test("sin procs deja el lanzamiento al SDK", async () => {
  let seen: Options | undefined;
  const query: QueryFn = ({ options }) => {
    seen = options;
    return (async function* () {
      yield init;
      throw new Error("fin");
    })();
  };
  const runtime = createClaudeRuntime({ credentials: async () => subscriptionCredentials({ executable: "/bin/claude" }), home, query });

  const run = await runtime.start(spec());
  await run.result.catch(() => {});

  expect(seen?.spawnClaudeCodeProcess).toBeUndefined();
});
