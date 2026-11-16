import type { RunId, StepRunId } from "@clanker/api";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { agentSessions, stepRuns } from "../store/schema";
import { RunCommandError } from "./engine";
import { StepNotFoundError } from "./step-detail";
import { harness as createHarness, okReport, type AgentScript, WAIT } from "../testing/flows-harness";

// Lo que una persona le pide a una corrida (`control`) y a un paso (`stepCommand`).

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function harness(options: Parameters<typeof createHarness>[0] = {}) {
  const h = createHarness({ resumeKeepsSession: true, ...options });
  cleanups.push(h.cleanup);
  // Lo que un test deja en vuelo (un agente o una acción que nunca terminan) se cancela antes de cerrar el motor.
  cleanups.push(() => {
    for (const { id } of h.flows.listRuns({ status: ["running", "paused", "parked", "queued"] })) h.flows.control(id, "cancel", "core");
  });
  h.action("after", ["ok"]);
  h.flows.registerWait({
    name: "pr.ci",
    args: z.object({ pr: z.number() }),
    outcomes: ["ok", "fail"],
    key: ({ pr }) => `pr:${pr}:ci`,
    match: (event, { pr }) => (event.type === "pr.ci" && event.pr === pr ? { outcome: event.state as string } : undefined),
    probe: () => Promise.resolve(undefined),
  });
  const run = (id: RunId) => h.flows.getRun(id);
  const step = (id: RunId, nodeId: string, visit?: number) => run(id).steps.filter((s) => s.nodeId === nodeId && (visit === undefined || s.visit === visit)).at(-1);
  const eventsOf = (id: RunId, type: string) => h.store.events.since(0, { runId: id, types: [type as "run.status"] });
  return { ...h, run, step, eventsOf };
}

const flow = (id: string, nodes: Record<string, unknown>, start: string) => ({ schema: 1, id, name: id, trigger: { type: "manual" }, start, nodes });
const agent = (on: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  type: "agent",
  role: "dev",
  mode: "plan",
  brief: { issue: "$run.subject" },
  on,
  ...extra,
});

/** Un agente que no termina hasta que el test lo suelta, y se interrumpe como cualquier otro. */
function gatedAgent() {
  const releases: (() => void)[] = [];
  const script: AgentScript = () => new Promise((resolve) => releases.push(() => resolve(okReport())));
  return { script, releaseLast: () => releases.at(-1)?.() };
}

const planThenAfter = flow(
  "plan-after",
  { plan: agent({ ok: "after", changes: "@blocked" }), after: { type: "action", action: "after", args: {}, on: { ok: "@done" } } },
  "plan",
);

/** Un paso de agente sin reintentos que falla la primera vez: la corrida queda esperando una decisión. */
const failing = flow("fail", { plan: agent({ ok: "@done", changes: "@blocked" }, { retry: { max: 0, backoffSec: [] } }) }, "plan");
const breaksOnce = (): AgentScript => {
  let calls = 0;
  return () => Promise.resolve(++calls === 1 ? { status: "error" as const, message: "se cayó" } : okReport());
};

describe("pausar y retomar", () => {
  test("sin now el agente en curso termina, el paso siguiente no se despacha y al retomar sigue", async () => {
    const agentRun = gatedAgent();
    const h = harness({ script: agentRun.script });
    h.save(planThenAfter);
    const runId = h.start("plan-after");
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT);

    h.flows.control(runId, "pause", "ui");
    expect(h.run(runId).status).toBe("paused");
    agentRun.releaseLast();
    await vi.waitFor(() => expect(h.step(runId, "plan")?.status).toBe("done"), WAIT);

    expect(h.step(runId, "after")).toMatchObject({ status: "pending", attempt: 0 });
    expect(h.run(runId).status).toBe("paused");

    h.flows.control(runId, "resume", "cli");
    await vi.waitFor(() => expect(h.run(runId)).toMatchObject({ status: "done", outcome: "done" }), WAIT);
    expect(h.eventsOf(runId, "run.status").map((e) => [e.origin, e.payload])).toEqual([
      ["ui", { from: "running", to: "paused", now: false }],
      ["cli", { from: "paused", to: "running" }],
    ]);
  });

  test("con now interrumpe al agente, su paso vuelve a pending con su sesión y al retomar la retoma", async () => {
    const h = harness({ script: () => new Promise(() => {}) });
    h.save(planThenAfter);
    const runId = h.start("plan-after");
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT);

    h.flows.control(runId, "pause", "ui", { now: true });
    await vi.waitFor(() => expect(h.step(runId, "plan")?.status).toBe("pending"), WAIT);

    expect(h.step(runId, "plan")).toMatchObject({ attempt: 1, error: expect.stringContaining("se pausó") });
    expect(h.store.db.select().from(stepRuns).all()[0]).toMatchObject({ deferrals: 1, recoveries: 0, owner: null });
    expect(h.store.db.select().from(agentSessions).all()).toMatchObject([{ status: "error", error: expect.stringContaining("se interrumpió") }]);
    expect(h.run(runId).status).toBe("paused");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.calls).toHaveLength(1);

    h.flows.control(runId, "resume", "ui");
    await vi.waitFor(() => expect(h.calls).toHaveLength(2), WAIT);
    expect(h.calls[1]).toMatchObject({ kind: "resume", sessionId: h.calls[0]?.sessionId });
    expect(h.calls[1]?.prompt).toMatch(/^Una persona pausó la corrida/);
  });

  test("pausar con now una corrida ya pausada interrumpe al agente que seguía", async () => {
    const h = harness({ script: () => new Promise(() => {}) });
    h.save(planThenAfter);
    const runId = h.start("plan-after");
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT);

    h.flows.control(runId, "pause", "ui");
    expect(h.step(runId, "plan")?.status).toBe("running");
    h.flows.control(runId, "pause", "ui", { now: true });
    await vi.waitFor(() => expect(h.step(runId, "plan")?.status).toBe("pending"), WAIT);

    expect(h.eventsOf(runId, "run.status")).toHaveLength(1);
  });

  test("pausa y retoma también a las hijas de un subflujo", async () => {
    const h = harness();
    let release!: () => void;
    h.action("work", ["ok"], () => new Promise((resolve) => (release = () => resolve({ outcome: "ok" }))));
    h.save({ ...flow("child", { work: { type: "action", action: "work", args: {}, on: { ok: "@done" } } }, "work"), trigger: { type: "subflow" } });
    h.save(flow("parent", { sub: { type: "flow", flow: "child", params: {}, on: { done: "@done", blocked: "@blocked", failed: "@failed" } } }, "sub"));
    const parent = h.start("parent");
    await vi.waitFor(() => expect(h.flows.listRuns().some((r) => r.parentRunId === parent)).toBe(true), WAIT);
    const child = h.flows.listRuns().find((r) => r.parentRunId === parent)?.id as RunId;

    h.flows.control(parent, "pause", "ui");
    expect([h.run(parent).status, h.run(child).status]).toEqual(["paused", "paused"]);
    h.flows.control(parent, "resume", "ui");
    expect([h.run(parent).status, h.run(child).status]).toEqual(["running", "running"]);

    await vi.waitFor(() => expect(release).toBeDefined(), WAIT);
    release();
    await vi.waitFor(() => expect(h.run(parent)).toMatchObject({ status: "done", outcome: "done" }), WAIT);
  });

  test("un wait de una corrida pausada se cierra con su evento, pero lo que sigue espera al retomar", async () => {
    const h = harness();
    h.save(
      flow(
        "ci",
        {
          wait: { type: "wait", event: "pr.ci", args: { pr: 7 }, on: { ok: "after", fail: "@failed" } },
          after: { type: "action", action: "after", args: {}, on: { ok: "@done" } },
        },
        "wait",
      ),
    );
    const runId = h.start("ci");
    await vi.waitFor(() => expect(h.step(runId, "wait")?.status).toBe("waiting"), WAIT);

    h.flows.control(runId, "pause", "ui");
    expect(h.flows.waitKeys()).toEqual(["pr:7:ci"]);
    h.flows.signal({ type: "pr.ci", pr: 7, state: "ok" });
    expect(h.step(runId, "wait")).toMatchObject({ status: "done", outcome: "ok" });
    expect(h.step(runId, "after")?.status).toBe("pending");

    h.flows.control(runId, "resume", "ui");
    await vi.waitFor(() => expect(h.run(runId).status).toBe("done"), WAIT);
  });

  test("una corrida pausada sigue ocupando su cupo de carril", async () => {
    const h = harness({ laneCapacity: () => ({ dev: 1, maintenance: 1 }) });
    h.action("work", ["ok"], () => new Promise(() => {}));
    h.save(flow("w", { work: { type: "action", action: "work", args: {}, on: { ok: "@done" } } }, "work"));
    const first = h.start("w", { type: "issue", id: "ENG-1" });
    h.flows.control(first, "pause", "ui");

    const second = h.start("w", { type: "issue", id: "ENG-2" });

    expect([h.run(first).status, h.run(second).status]).toEqual(["paused", "queued"]);
  });

  test("solo se pausa lo que corre y solo se retoma lo pausado", async () => {
    const h = harness();
    h.save(flow("w", { ask: { type: "gate", question: "¿Sigo?", options: [{ id: "go", label: "Seguir" }], on: { go: "@done" } } }, "ask"));
    const runId = h.start("w");
    await h.finished(runId);
    expect(h.run(runId).status).toBe("parked");

    expect(() => h.flows.control(runId, "pause", "ui")).toThrow(RunCommandError);
    expect(() => h.flows.control(runId, "pause", "ui")).toThrow(/estacionada/);
    expect(() => h.flows.control(runId, "resume", "ui")).toThrow(/solo se retoma una pausada/);
    expect(() => h.flows.control("run_00000000000000000000000000" as RunId, "pause", "ui")).toThrow(/No existe la corrida/);

    h.flows.control(runId, "cancel", "ui");
    expect(() => h.flows.control(runId, "pause", "ui")).toThrow(/solo se pausa una corrida que corre/);
  });

  test("cancelar una pausada la cancela y deja al actor en run.finished", async () => {
    const h = harness();
    h.save(flow("w", { work: { type: "action", action: "after", args: {}, on: { ok: "@done" } } }, "work"));
    const runId = h.start("w");
    h.flows.control(runId, "pause", "ui");
    h.flows.control(runId, "cancel", "mcp");

    expect(h.run(runId).status).toBe("canceled");
    expect(h.eventsOf(runId, "run.finished").map((e) => [e.origin, e.payload.outcome])).toEqual([["mcp", "canceled"]]);
  });
});

describe("reintentar un paso", () => {
  test("un paso que falló y espera una decisión: visita nueva con sesión nueva, la decisión queda respondida", async () => {
    const h = harness({ script: breaksOnce() });
    h.save(failing);
    const runId = h.start("fail");
    await h.finished(runId);
    expect(h.run(runId)).toMatchObject({ status: "parked", parkReason: "needs_human" });
    const failed = h.step(runId, "plan") as { id: StepRunId };

    h.flows.stepCommand(failed.id, { retry: true }, "ui");
    await vi.waitFor(() => expect(h.run(runId)).toMatchObject({ status: "done", outcome: "done" }), WAIT);

    expect(h.run(runId).steps.map((s) => [s.nodeId, s.visit, s.status])).toEqual([
      ["plan", 1, "failed"],
      ["plan", 2, "done"],
    ]);
    expect(h.decisions.list({ runId })[0]).toMatchObject({ status: "answered", resolution: { option: "retry" }, resolvedBy: "ui" });
    expect(h.calls.map((c) => c.kind)).toEqual(["start", "start"]);
    expect(h.eventsOf(runId, "step.commanded").map((e) => [e.origin, e.stepRunId, e.payload.command])).toEqual([["ui", failed.id, "retry"]]);
  });

  test("desde un paso anterior cancela lo que la corrida tenía en marcha, lo interrumpe y vuelve a correr el nodo", async () => {
    const h = harness();
    let signal: AbortSignal | undefined;
    h.action("slow", ["ok"], (_args, ctx) => {
      signal = ctx.signal;
      return new Promise(() => {});
    });
    h.save(
      flow(
        "two",
        {
          first: { type: "action", action: "after", args: {}, on: { ok: "second" } },
          second: { type: "action", action: "slow", args: {}, on: { ok: "@done" } },
        },
        "first",
      ),
    );
    const runId = h.start("two");
    await vi.waitFor(() => expect(h.step(runId, "second")?.status).toBe("running"), WAIT);
    const first = h.step(runId, "first") as { id: StepRunId };

    h.flows.stepCommand(first.id, { retry: true }, "cli");

    expect(signal?.aborted).toBe(true);
    expect(h.step(runId, "second", 1)).toMatchObject({ status: "canceled" });
    expect(h.run(runId).steps.filter((s) => s.nodeId === "first").map((s) => s.visit)).toEqual([1, 2]);
    await vi.waitFor(() => expect(h.step(runId, "second", 2)?.status).toBe("running"), WAIT);
  });

  test("sobre un nodo flow cancela la corrida hija y abre otra", async () => {
    const h = harness();
    h.action("slow", ["ok"], () => new Promise(() => {}));
    h.save({ ...flow("child", { work: { type: "action", action: "slow", args: {}, on: { ok: "@done" } } }, "work"), trigger: { type: "subflow" } });
    h.save(flow("parent", { sub: { type: "flow", flow: "child", params: {}, on: { done: "@done", blocked: "@blocked", failed: "@failed" } } }, "sub"));
    const parent = h.start("parent");
    await vi.waitFor(() => expect(h.flows.listRuns().filter((r) => r.parentRunId === parent)).toHaveLength(1), WAIT);

    h.flows.stepCommand(h.step(parent, "sub")?.id as StepRunId, { retry: true }, "ui");

    await vi.waitFor(() => expect(h.flows.listRuns().filter((r) => r.parentRunId === parent)).toHaveLength(2), WAIT);
    expect(h.flows.listRuns().filter((r) => r.parentRunId === parent).map((r) => r.status).sort()).toEqual(["canceled", "running"]);
  });

  test("una corrida estacionada en otro paso: reintentar cierra su decisión como superseded y la reencola", async () => {
    const h = harness();
    h.save(
      flow(
        "gate-after",
        {
          first: { type: "action", action: "after", args: {}, on: { ok: "ask" } },
          ask: { type: "gate", question: "¿Sigo?", options: [{ id: "go", label: "Seguir" }], on: { go: "@done" } },
        },
        "first",
      ),
    );
    const runId = h.start("gate-after");
    await h.finished(runId);
    const first = h.step(runId, "first") as { id: StepRunId };

    h.flows.stepCommand(first.id, { retry: true }, "ui");

    expect(h.decisions.list({ runId }).map((d) => [d.kind, d.status])).toEqual([["gate", "superseded"]]);
    expect(h.run(runId).status).toBe("running");
    await vi.waitFor(() => expect(h.run(runId).status).toBe("parked"), WAIT);
    expect(h.step(runId, "ask", 1)?.status).toBe("canceled");
    expect(h.step(runId, "ask", 2)?.status).toBe("waiting");
  });

  test("se rechaza sobre una rama de un parallel, una corrida terminada y un paso que no existe", async () => {
    const h = harness();
    h.action("work", ["ok"]);
    h.save(
      flow(
        "par",
        {
          fan: { type: "parallel", branches: ["a", "b"], on: { ok: "@done", changes: "@blocked", fail: "@failed", error: "@failed" } },
          a: { type: "action", action: "work", args: {} },
          b: { type: "action", action: "work", args: {} },
        },
        "fan",
      ),
    );
    const runId = h.start("par");
    await vi.waitFor(() => expect(h.run(runId).status).toBe("done"), WAIT);
    const branch = h.step(runId, "a") as { id: StepRunId };

    expect(() => h.flows.stepCommand(branch.id, { retry: true }, "ui")).toThrow(/solo se comanda un paso de una corrida viva/);
    expect(() => h.flows.stepCommand("stp_00000000000000000000000000" as StepRunId, { retry: true }, "ui")).toThrow(StepNotFoundError);
  });

  test("una rama de un parallel no se reintenta sola", async () => {
    const h = harness();
    h.action("slow", ["ok"], () => new Promise(() => {}));
    h.save(
      flow(
        "par",
        {
          fan: { type: "parallel", branches: ["a", "b"], on: { ok: "@done", changes: "@blocked", fail: "@failed", error: "@failed" } },
          a: { type: "action", action: "slow", args: {} },
          b: { type: "action", action: "slow", args: {} },
        },
        "fan",
      ),
    );
    const runId = h.start("par");
    await vi.waitFor(() => expect(h.step(runId, "a")?.status).toBe("running"), WAIT);

    expect(() => h.flows.stepCommand(h.step(runId, "a")?.id as StepRunId, { retry: true }, "ui")).toThrow(/reintenta el parallel/);
  });
});

describe("steer", () => {
  test("a un agente en curso lo interrumpe y retoma su sesión con el mensaje", async () => {
    let calls = 0;
    const h = harness({ script: () => (++calls === 1 ? new Promise(() => {}) : Promise.resolve(okReport())) });
    h.save(planThenAfter);
    const runId = h.start("plan-after");
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT);
    const plan = h.step(runId, "plan") as { id: StepRunId };

    h.flows.stepCommand(plan.id, { steer: "usa el helper que ya existe" }, "ui");

    await vi.waitFor(() => expect(h.run(runId)).toMatchObject({ status: "done", outcome: "done" }), WAIT);
    expect(h.calls[1]).toMatchObject({ kind: "resume", sessionId: h.calls[0]?.sessionId });
    expect(h.calls[1]?.prompt).toContain("usa el helper que ya existe");
    expect(h.store.db.select().from(stepRuns).all().find((s) => s.nodeId === "plan")).toMatchObject({ attempt: 2, deferrals: 1 });
    expect(h.eventsOf(runId, "step.commanded").map((e) => [e.origin, e.payload.command, e.payload.message])).toEqual([
      ["ui", "steer", "usa el helper que ya existe"],
    ]);
  });

  test("a un agente pending (tras pausar con now) lo marca y el mensaje llega al retomar", async () => {
    let calls = 0;
    const h = harness({ script: () => (++calls === 1 ? new Promise(() => {}) : Promise.resolve(okReport())) });
    h.save(planThenAfter);
    const runId = h.start("plan-after");
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT);
    h.flows.control(runId, "pause", "ui", { now: true });
    await vi.waitFor(() => expect(h.step(runId, "plan")?.status).toBe("pending"), WAIT);

    h.flows.stepCommand(h.step(runId, "plan")?.id as StepRunId, { steer: "mejor no toques el schema" }, "mcp");
    h.flows.control(runId, "resume", "ui");

    await vi.waitFor(() => expect(h.run(runId).status).toBe("done"), WAIT);
    expect(h.calls[1]?.prompt).toContain("mejor no toques el schema");
    expect(h.calls[1]?.prompt).not.toMatch(/pausó la corrida/);
  });

  test("al agente que falló y espera una decisión le da un paso nuevo que retoma su última sesión", async () => {
    const h = harness({ script: breaksOnce() });
    h.save(failing);
    const runId = h.start("fail");
    await h.finished(runId);
    const failed = h.step(runId, "plan") as { id: StepRunId };

    h.flows.stepCommand(failed.id, { steer: "el outcome es ok si los tests pasan" }, "cli");

    await vi.waitFor(() => expect(h.run(runId)).toMatchObject({ status: "done", outcome: "done" }), WAIT);
    expect(h.calls[1]).toMatchObject({ kind: "resume", sessionId: h.calls[0]?.sessionId });
    expect(h.calls[1]?.prompt).toContain("el outcome es ok si los tests pasan");
    expect(h.decisions.list({ runId })[0]).toMatchObject({ status: "superseded", resolvedBy: "cli" });
    const steered = h.eventsOf(runId, "step.commanded")[0];
    expect(steered?.stepRunId).toBe(h.step(runId, "plan", 2)?.id);
  });

  test("se rechaza sobre una acción, con un mensaje vacío y sobre un agente que ya terminó", async () => {
    const h = harness();
    h.action("slow", ["ok"], () => new Promise(() => {}));
    h.save(
      flow(
        "ag-slow",
        { plan: agent({ ok: "slow", changes: "@blocked" }), slow: { type: "action", action: "slow", args: {}, on: { ok: "@done" } } },
        "plan",
      ),
    );
    const runId = h.start("ag-slow");
    await vi.waitFor(() => expect(h.step(runId, "slow")?.status).toBe("running"), WAIT);

    expect(() => h.flows.stepCommand(h.step(runId, "slow")?.id as StepRunId, { steer: "hola" }, "ui")).toThrow(/Solo un paso de agente recibe un mensaje/);
    expect(() => h.flows.stepCommand(h.step(runId, "plan")?.id as StepRunId, { steer: "hola" }, "ui")).toThrow(/está done/);
    expect(h.eventsOf(runId, "step.commanded")).toEqual([]);
  });

  test("no acepta un mensaje vacío", async () => {
    const h = harness({ script: () => new Promise(() => {}) });
    h.save(planThenAfter);
    const runId = h.start("plan-after");
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT);

    expect(() => h.flows.stepCommand(h.step(runId, "plan")?.id as StepRunId, { steer: "  " }, "ui")).toThrow(/vacío/);
  });
});

describe("forzar un resultado", () => {
  test("sobre un paso de agente se rechaza, aunque declare el outcome", async () => {
    const h = harness({ script: () => new Promise(() => {}) });
    h.save(planThenAfter);
    const runId = h.start("plan-after");
    await vi.waitFor(() => expect(h.calls).toHaveLength(1), WAIT);
    const plan = h.step(runId, "plan") as { id: StepRunId };

    expect(() => h.flows.stepCommand(plan.id, { force: "ok" }, "ui")).toThrow(RunCommandError);
    expect(() => h.flows.stepCommand(plan.id, { force: "ok" }, "ui")).toThrow(/Solo se fuerza el resultado de un paso action o wait \(nunca el de un agente\)/);
    expect(h.step(runId, "plan")?.status).toBe("running");
    expect(h.eventsOf(runId, "step.commanded")).toEqual([]);
  });

  test("sobre una acción en curso la aborta y sigue el edge del outcome sin ejecutarla", async () => {
    const h = harness();
    let signal: AbortSignal | undefined;
    h.action("slow", ["ok", "fail"], (_args, ctx) => {
      signal = ctx.signal;
      return new Promise(() => {});
    });
    h.save(
      flow(
        "w",
        {
          slow: { type: "action", action: "slow", args: {}, on: { ok: "after", fail: "@failed" } },
          after: { type: "action", action: "after", args: {}, on: { ok: "@done" } },
        },
        "slow",
      ),
    );
    const runId = h.start("w");
    await vi.waitFor(() => expect(h.step(runId, "slow")?.status).toBe("running"), WAIT);
    const slow = h.step(runId, "slow") as { id: StepRunId };

    expect(() => h.flows.stepCommand(slow.id, { force: "nope" }, "ui")).toThrow(/no declara el outcome "nope": ok, fail/);
    h.flows.stepCommand(slow.id, { force: "ok" }, "ui");

    expect(signal?.aborted).toBe(true);
    await vi.waitFor(() => expect(h.run(runId)).toMatchObject({ status: "done", outcome: "done" }), WAIT);
    expect(h.step(runId, "slow")).toMatchObject({ status: "done", outcome: "ok" });
    expect(h.eventsOf(runId, "step.commanded").map((e) => [e.origin, e.payload.command, e.payload.outcome])).toEqual([["ui", "force", "ok"]]);
  });

  test("sobre un wait lo termina con ese outcome", async () => {
    const h = harness();
    h.save(
      flow(
        "ci",
        {
          wait: { type: "wait", event: "pr.ci", args: { pr: 7 }, on: { ok: "after", fail: "@failed" } },
          after: { type: "action", action: "after", args: {}, on: { ok: "@done" } },
        },
        "wait",
      ),
    );
    const runId = h.start("ci");
    await vi.waitFor(() => expect(h.step(runId, "wait")?.status).toBe("waiting"), WAIT);

    h.flows.stepCommand(h.step(runId, "wait")?.id as StepRunId, { force: "fail" }, "mcp");

    expect(h.run(runId)).toMatchObject({ status: "failed", outcome: "failed" });
    expect(h.step(runId, "wait")).toMatchObject({ status: "done", outcome: "fail" });
  });

  test("sobre una acción que falló y espera una decisión usa la opción force de la decisión", async () => {
    const h = harness();
    h.action("boom", ["ok"], () => {
      throw new Error("se cayó");
    });
    h.save(flow("w", { boom: { type: "action", action: "boom", args: {}, retry: { max: 0, backoffSec: [] }, on: { ok: "@done" } } }, "boom"));
    const runId = h.start("w");
    await h.finished(runId);
    expect(h.run(runId).status).toBe("parked");
    expect(() => h.flows.stepCommand(h.step(runId, "boom")?.id as StepRunId, { force: "error" }, "ui")).toThrow(/no declara/);
    h.flows.stepCommand(h.step(runId, "boom")?.id as StepRunId, { force: "ok" }, "ui");

    expect(h.run(runId)).toMatchObject({ status: "done", outcome: "done" });
    expect(h.decisions.list({ runId })[0]).toMatchObject({ status: "answered", resolution: { option: "force:ok" }, resolvedBy: "ui" });
  });
});
