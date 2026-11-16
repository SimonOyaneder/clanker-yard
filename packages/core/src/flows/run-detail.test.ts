import { afterEach, describe, expect, test, vi } from "vitest";
import { repos, workspaces } from "../store/schema";
import { harness as createHarness, okReport, WAIT } from "../testing/flows-harness";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function harness(options: Parameters<typeof createHarness>[0] = {}) {
  const h = createHarness(options);
  cleanups.push(h.cleanup);
  return h;
}

const FLOW = {
  schema: 1,
  id: "con-agente",
  name: "Con agente",
  trigger: { type: "manual" },
  start: "acquire",
  nodes: {
    acquire: { type: "action", action: "acquire", args: {}, on: { ok: "plan" } },
    plan: { type: "agent", role: "dev", mode: "plan", brief: {}, on: { ok: "@done", changes: "@blocked" } },
  },
};

describe("getRun: lo que hace falta para dibujar la corrida", () => {
  test("trae el flujo fijado, cuándo arrancó y cerró cada paso y los tokens de sus agentes", async () => {
    const h = harness({ script: () => Promise.resolve(okReport()) });
    h.action("acquire", ["ok"]);
    h.save(FLOW);

    const runId = h.start("con-agente");
    await h.finished(runId);

    const run = h.flows.getRun(runId);
    expect(run.flowDef).toMatchObject({ id: "con-agente", start: "acquire" });
    expect(run.usage).toEqual({ input: 10, output: 20, cacheRead: 0, cacheWrite: 0 });
    expect(run.workspace).toBeNull();
    for (const step of run.steps) {
      expect(step.startedAt).not.toBeNull();
      expect(step.endedAt).toBeGreaterThanOrEqual(step.startedAt!);
    }
  });

  test("un paso que todavía no cierra no tiene endedAt", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = harness({ script: () => gate.then(() => okReport()) });
    h.action("acquire", ["ok"]);
    h.save(FLOW);

    const runId = h.start("con-agente");
    await vi.waitFor(() => expect(h.flows.getRun(runId).steps.some((s) => s.nodeId === "plan" && s.status === "running")).toBe(true), WAIT);

    const plan = h.flows.getRun(runId).steps.find((s) => s.nodeId === "plan");
    expect(plan).toMatchObject({ endedAt: null });
    expect(plan?.startedAt).not.toBeNull();
    release();
    await h.finished(runId);
  });

  test("el worktree sale del último lease que tomó la corrida, aunque ya lo haya soltado", async () => {
    const h = harness();
    h.action("acquire", ["ok"]);
    h.save(FLOW);
    const runId = h.start("con-agente");
    await h.finished(runId);

    h.store.tx(({ db, emit }) => {
      db.insert(repos).values({ id: "repo_1", name: "api", path: "/tmp/api", remote: null, defaultBranch: "main" }).run();
      db.insert(workspaces)
        .values({ id: "ws_1", repoId: "repo_1", path: "/tmp/ws", branch: "eng-1", baseRef: "main", state: "idle" })
        .run();
      emit({ type: "lease.acquired", origin: "core", runId, payload: { resource: "workspace", id: "ws_1", runId, token: 1 } });
    });

    expect(h.flows.getRun(runId).workspace).toEqual({ repo: "api", branch: "eng-1", base: "main" });
  });
});
