import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import type { ExternalEvent, WaitResult } from "./catalog";
import { harness as createHarness } from "./harness";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function harness(options: Parameters<typeof createHarness>[0] = {}) {
  const h = createHarness(options);
  cleanups.push(h.cleanup);

  /** Un wait `pr.ci` cuyo estado "actual" decide el test: lo que ve `probe` y lo que cuenta `probes`. */
  const ci = { current: undefined as WaitResult | undefined, probes: 0, failProbe: undefined as Error | undefined };
  h.flows.registerWait({
    name: "pr.ci",
    args: z.object({ pr: z.number() }),
    outcomes: ["ok", "fail"],
    key: ({ pr }) => `pr:${pr}:ci`,
    match: (event: ExternalEvent, { pr }) =>
      event.type === "pr.ci" && event.pr === pr ? { outcome: event.state as string, output: { failures: event.failures } } : undefined,
    probe: () => {
      ci.probes++;
      return ci.failProbe ? Promise.reject(ci.failProbe) : Promise.resolve(ci.current);
    },
  });
  h.action("after", ["ok"]);
  return { ...h, ci };
}

const flow = (wait: Record<string, unknown> = {}) => ({
  schema: 1,
  id: "ci",
  name: "Espera el CI",
  trigger: { type: "manual" },
  params: { pr: "number" },
  start: "ci-wait",
  nodes: {
    "ci-wait": {
      type: "wait",
      event: "pr.ci",
      args: { pr: "$run.params.pr" },
      timeoutSec: 600,
      on: { ok: "after", fail: "@failed", timeout: "@blocked" },
      ...wait,
    },
    after: { type: "action", action: "after", args: { failures: "$ci-wait.failures" }, on: { ok: "@done" } },
  },
});

const stepOf = (h: ReturnType<typeof harness>, runId: Parameters<typeof h.flows.getRun>[0], nodeId: string) =>
  h.flows.getRun(runId).steps.find((s) => s.nodeId === nodeId);

describe("wait", () => {
  test("espera con su clave y su plazo hasta que un signal calza, y entrega su output", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.save(flow());

    const t0 = Date.now();
    const runId = h.start("ci", undefined, { pr: 7 });
    await vi.advanceTimersByTimeAsync(0);

    expect(stepOf(h, runId, "ci-wait")).toMatchObject({ status: "waiting", waitKey: "pr:7:ci", deadline: t0 + 600_000, attempt: 1 });
    expect(h.flows.getRun(runId).status).toBe("running");
    expect(h.eventTypes(runId)).toEqual(["run.started", "step.started", "step.waiting"]);

    h.flows.signal({ type: "pr.ci", pr: 8, state: "ok" });
    h.flows.signal({ type: "pr.bot", pr: 7 });
    await vi.advanceTimersByTimeAsync(0);
    expect(stepOf(h, runId, "ci-wait")?.status).toBe("waiting");

    h.flows.signal({ type: "pr.ci", pr: 7, state: "ok", failures: [] });
    await vi.advanceTimersByTimeAsync(0);

    const view = h.flows.getRun(runId);
    expect(view).toMatchObject({ status: "done", outcome: "done" });
    expect(view.steps.map((s) => [s.nodeId, s.status, s.outcome])).toEqual([
      ["ci-wait", "done", "ok"],
      ["after", "done", "ok"],
    ]);
  });

  test("waitKeys da la clave de cada wait que espera ahora, y deja de darla cuando se cierra", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.save(flow());
    expect(h.flows.waitKeys()).toEqual([]);

    h.start("ci", { type: "issue", id: "ENG-7" }, { pr: 7 });
    h.start("ci", { type: "issue", id: "ENG-8" }, { pr: 8 });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.flows.waitKeys().sort()).toEqual(["pr:7:ci", "pr:8:ci"]);

    h.flows.signal({ type: "pr.ci", pr: 7, state: "ok", failures: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.flows.waitKeys()).toEqual(["pr:8:ci"]);
  });

  test("signal despierta solo a los waits que calzan", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.save(flow());

    const [seven, eight] = [h.start("ci", { type: "issue", id: "ENG-7" }, { pr: 7 }), h.start("ci", { type: "issue", id: "ENG-8" }, { pr: 8 })];
    await vi.advanceTimersByTimeAsync(0);
    h.flows.signal({ type: "pr.ci", pr: 8, state: "fail" });
    await vi.advanceTimersByTimeAsync(0);

    expect(h.flows.getRun(seven).status).toBe("running");
    expect(h.flows.getRun(eight)).toMatchObject({ status: "failed", outcome: "failed" });
  });

  test("probe al entrar: si lo esperado ya pasó, no queda esperando", async () => {
    const h = harness();
    h.ci.current = { outcome: "ok", output: { failures: [] } };
    h.save(flow());

    const runId = h.start("ci", undefined, { pr: 7 });
    await h.finished(runId);

    expect(h.ci.probes).toBe(1);
    expect(h.flows.getRun(runId)).toMatchObject({ status: "done", outcome: "done" });
    expect(h.eventTypes(runId)).not.toContain("step.waiting");
  });

  test("el sondeo periódico resuelve lo que pasó sin que nadie avisara", async () => {
    vi.useFakeTimers();
    const h = harness({ probeEverySec: 60 });
    h.save(flow());

    const runId = h.start("ci", undefined, { pr: 7 });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.ci.probes).toBe(1);

    await vi.advanceTimersByTimeAsync(50_000);
    expect(h.ci.probes).toBe(1);
    h.ci.current = { outcome: "fail", output: { failures: ["lint"] } };
    await vi.advanceTimersByTimeAsync(10_000);

    expect(h.ci.probes).toBe(2);
    expect(h.flows.getRun(runId)).toMatchObject({ status: "failed", outcome: "failed" });
  });

  test("el sondeo cada 60 s por defecto, sin traslapes", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.save(flow({ timeoutSec: undefined }));

    h.start("ci", undefined, { pr: 7 });
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(h.ci.probes).toBe(6);
  });

  test("al vencer el plazo el tick lo cierra con outcome timeout", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.save(flow({ timeoutSec: 90 }));

    const runId = h.start("ci", undefined, { pr: 7 });
    await vi.advanceTimersByTimeAsync(85_000);
    expect(h.flows.getRun(runId).status).toBe("running");
    await vi.advanceTimersByTimeAsync(10_000);

    const view = h.flows.getRun(runId);
    expect(view).toMatchObject({ status: "failed", outcome: "blocked" });
    expect(stepOf(h, runId, "ci-wait")).toMatchObject({ status: "done", outcome: "timeout" });
  });

  test("sin edge timeout, el vencimiento cuenta como error y estaciona la corrida", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.save(flow({ timeoutSec: 30, on: { ok: "after", fail: "@failed" } }));

    const runId = h.start("ci", undefined, { pr: 7 });
    await vi.advanceTimersByTimeAsync(40_000);

    expect(h.flows.getRun(runId)).toMatchObject({ status: "parked", parkReason: "needs_human" });
    expect(stepOf(h, runId, "ci-wait")).toMatchObject({ status: "failed", outcome: "timeout" });
  });

  test("un sondeo que lanza deja el wait esperando, con el error anotado, y se reintenta", async () => {
    vi.useFakeTimers();
    const h = harness({ probeEverySec: 60 });
    h.save(flow());

    const runId = h.start("ci", undefined, { pr: 7 });
    await vi.advanceTimersByTimeAsync(0);
    h.ci.failProbe = new Error("GitHub 502");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stepOf(h, runId, "ci-wait")).toMatchObject({ status: "waiting", error: "GitHub 502" });

    h.ci.failProbe = undefined;
    h.ci.current = { outcome: "ok", output: { failures: [] } };
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.flows.getRun(runId)).toMatchObject({ status: "done", outcome: "done" });
    expect(stepOf(h, runId, "after")).toMatchObject({ status: "done" });
  });

  test("un probe que lanza al entrar reintenta el paso como una acción", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.ci.failProbe = new Error("sin red");
    h.save(flow());

    const t0 = Date.now();
    const runId = h.start("ci", undefined, { pr: 7 });
    await vi.advanceTimersByTimeAsync(0);
    expect(stepOf(h, runId, "ci-wait")).toMatchObject({ status: "pending", attempt: 1, notBefore: t0 + 10_000, error: "sin red" });

    h.ci.failProbe = undefined;
    h.ci.current = { outcome: "ok", output: { failures: [] } };
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.flows.getRun(runId)).toMatchObject({ status: "done", outcome: "done" });
  });

  test("un outcome que el wait no declara es un error sin reintento", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.save(flow({ on: { ok: "after", fail: "@failed", error: "@blocked" } }));

    const runId = h.start("ci", undefined, { pr: 7 });
    await vi.advanceTimersByTimeAsync(0);
    h.flows.signal({ type: "pr.ci", pr: 7, state: "meh" });
    await vi.advanceTimersByTimeAsync(0);

    expect(stepOf(h, runId, "ci-wait")).toMatchObject({ status: "done", outcome: "error", error: expect.stringMatching(/outcome "meh"/) });
    expect(h.flows.getRun(runId).outcome).toBe("blocked");
  });

  test("un wait puede ser rama de un parallel", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.save({
      schema: 1,
      id: "fan",
      name: "Rama que espera",
      trigger: { type: "manual" },
      start: "all",
      nodes: {
        all: { type: "parallel", branches: ["ci-wait", "quick"], on: { ok: "@done", fail: "@failed", changes: "@failed", error: "@failed" } },
        "ci-wait": { type: "wait", event: "pr.ci", args: { pr: 7 }, timeoutSec: 600 },
        quick: { type: "action", action: "after", args: {} },
      },
    });

    const runId = h.start("fan");
    await vi.advanceTimersByTimeAsync(0);
    expect(stepOf(h, runId, "all")?.status).toBe("waiting");

    h.flows.signal({ type: "pr.ci", pr: 7, state: "ok" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.flows.getRun(runId)).toMatchObject({ status: "done", outcome: "done" });
  });

  test("un wait que el motor no puede cargar estaciona su corrida sin frenar el tick de las demás", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.save(flow());
    h.save({
      schema: 1,
      id: "solo",
      name: "Solo",
      trigger: { type: "manual" },
      start: "after",
      nodes: { after: { type: "action", action: "after", args: {}, on: { ok: "@done" } } },
    });

    const waiting = h.start("ci", { type: "issue", id: "ENG-1" }, { pr: 7 });
    await vi.advanceTimersByTimeAsync(0);
    // El wait apunta a un nodo que su flujo ya no tiene.
    h.store.db.$client.exec(`UPDATE step_runs SET node_id = 'gone' WHERE run_id = '${waiting}'`);
    const fresh = h.start("solo", { type: "issue", id: "ENG-2" });
    await vi.advanceTimersByTimeAsync(0);

    expect(h.flows.getRun(fresh)).toMatchObject({ status: "done" });
    expect(h.flows.getRun(waiting)).toMatchObject({ status: "parked", parkReason: "needs_human" });
    expect(stepOf(h, waiting, "gone")).toMatchObject({ status: "failed", outcome: "error", error: expect.stringContaining("gone") });
  });
});
