import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { agentSessions, stepRuns } from "../store/schema";
import { harness as createHarness, okReport } from "../testing/flows-harness";

// El apagado del core (`Engine.close({ graceMs })`): no toma pasos nuevos, interrumpe a los agentes de
// inmediato, da una gracia a las acciones y deja cada paso cortado en pending, listo para el próximo arranque.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Options = Parameters<typeof createHarness>[0];

function boot(options: Options = {}) {
  const h = createHarness(options);
  cleanups.push(h.cleanup);
  return h;
}

const forever = () => new Promise<never>(() => {});

const flow = (id: string, nodes: Record<string, unknown>, start: string) => ({ schema: 1, id, name: id, trigger: { type: "manual" }, start, nodes });

const twoActions = flow(
  "pr",
  {
    work: { type: "action", action: "work", args: {}, on: { ok: "after" } },
    after: { type: "action", action: "after", args: {}, on: { ok: "@done" } },
  },
  "work",
);

const agentFlow = flow(
  "dev",
  { plan: { type: "agent", role: "dev", mode: "plan", brief: { issue: "$run.subject" }, on: { ok: "@done", changes: "@blocked" } } },
  "plan",
);

const stepRow = (h: ReturnType<typeof boot>, runId: string, nodeId: string) =>
  h.store.db.select().from(stepRuns).all().find((s) => s.runId === runId && s.nodeId === nodeId);

describe("close con apagado", () => {
  test("no toma pasos nuevos: espera la acción en curso y deja lo que sigue en pending", async () => {
    vi.useFakeTimers();
    const h = boot();
    let release!: () => void;
    const started: string[] = [];
    h.action("work", ["ok"], async () => {
      started.push("work");
      await new Promise<void>((resolve) => (release = resolve));
      return { outcome: "ok" };
    });
    h.action("after", ["ok"], () => {
      started.push("after");
      return { outcome: "ok" };
    });
    h.save(twoActions);
    const first = h.start("pr");
    await vi.advanceTimersByTimeAsync(0);
    expect(stepRow(h, first, "work")).toMatchObject({ status: "running" });

    let closed = false;
    const closing = h.flows.close({ graceMs: 60_000 }).then(() => (closed = true));
    // Una corrida que llega con el apagado en marcha no se despacha.
    const second = h.start("pr", { type: "issue", id: "ENG-2" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(closed).toBe(false);
    expect(stepRow(h, second, "work")).toMatchObject({ status: "pending", attempt: 0 });

    release();
    await closing;

    // La acción que estaba en curso terminó sola (no se la abortó) y su siguiente paso no arrancó.
    expect(stepRow(h, first, "work")).toMatchObject({ status: "done", outcome: "ok" });
    expect(stepRow(h, first, "after")).toMatchObject({ status: "pending", attempt: 0 });
    expect(started).toEqual(["work"]);
  });

  test("pasada la gracia aborta la acción y el paso vuelve a pending sin gastar intento ni contar como corte", async () => {
    vi.useFakeTimers();
    const h = boot();
    let signal: AbortSignal | undefined;
    h.action("work", ["ok"], (_args, ctx) => {
      signal = ctx.signal;
      return forever();
    });
    h.action("after", ["ok"]);
    h.save(twoActions);
    const runId = h.start("pr");
    await vi.advanceTimersByTimeAsync(0);

    const closing = h.flows.close({ graceMs: 60_000 });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;

    expect(signal?.aborted).toBe(true);
    expect(stepRow(h, runId, "work")).toMatchObject({ status: "pending", attempt: 1, deferrals: 1, recoveries: 0, owner: null, leaseUntil: null });
    expect(h.flows.getRun(runId).status).toBe("running");
    expect(h.eventTypes(runId)).toContain("step.retrying");
  });

  test("sin gracia aborta de una vez", async () => {
    vi.useFakeTimers();
    const h = boot();
    h.action("work", ["ok"], forever);
    h.action("after", ["ok"]);
    h.save(twoActions);
    const runId = h.start("pr");
    await vi.advanceTimersByTimeAsync(0);

    await h.flows.close({ graceMs: 0 });

    expect(stepRow(h, runId, "work")).toMatchObject({ status: "pending", deferrals: 1 });
  });

  test("interrumpe al agente de inmediato, deja su sesión y el próximo arranque la retoma", async () => {
    vi.useFakeTimers();
    const a = boot({ persist: true, bootId: "boot_A", script: forever });
    a.save(agentFlow);
    const runId = a.start("dev");
    await vi.advanceTimersByTimeAsync(0);
    expect(a.store.db.select().from(agentSessions).all()).toMatchObject([{ status: "running" }]);

    // Con 60 s de gracia el agente igual se interrumpe ya: la gracia es para las acciones.
    await a.flows.close({ graceMs: 60_000 });

    expect(stepRow(a, runId, "plan")).toMatchObject({ status: "pending", attempt: 1, deferrals: 1, recoveries: 0 });
    const [session] = a.store.db.select().from(agentSessions).where(eq(agentSessions.stepRunId, stepRow(a, runId, "plan")!.id)).all();
    expect(session).toMatchObject({ status: "error", error: expect.stringContaining("se interrumpió") });

    const b = boot({ reopen: a.home, bootId: "boot_B", script: () => Promise.resolve(okReport()) });
    expect(b.flows.recover()).toBe(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(b.calls).toHaveLength(1);
    expect(b.calls[0]).toMatchObject({ kind: "resume" });
    expect(b.calls[0]?.prompt).toMatch(/^La app se reinició mientras trabajabas/);
    expect(b.flows.getRun(runId)).toMatchObject({ status: "done", outcome: "done" });
  });

  test("un agente que ya había terminado cierra su paso con su reporte", async () => {
    vi.useFakeTimers();
    const h = boot({ script: () => Promise.resolve(okReport()) });
    h.save(agentFlow);
    const runId = h.start("dev");
    await vi.advanceTimersByTimeAsync(0);

    await h.flows.close({ graceMs: 0 });

    expect(h.flows.getRun(runId)).toMatchObject({ status: "done", outcome: "done" });
  });
});
