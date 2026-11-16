import type { RunId } from "@clanker/api";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import type { ExternalEvent, WaitResult } from "./catalog";
import { agentSessions, runs, stepRuns } from "../store/schema";
import { harness as createHarness, okReport } from "./harness";

// Un corte es cerrar la app con pasos a medias y abrir otra sobre la misma base con otro boot id:
// el primer `harness` queda abandonado (su dispatcher detenido, lo que tenía en vuelo colgado, como
// un proceso muerto) y el segundo, con `reopen`, hace `recover()`. Un gate todavía no
// se ejecuta (`start` lo rechaza), así que no hay un paso suyo que cortar.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Options = Parameters<typeof createHarness>[0];

function boot(options: Options = {}) {
  const h = createHarness(options);
  cleanups.push(h.cleanup);
  /** Un wait `pr.ci` cuyo estado "actual" decide el test. */
  const ci = { current: undefined as WaitResult | undefined, probes: 0 };
  h.flows.registerWait({
    name: "pr.ci",
    args: z.object({ pr: z.number() }),
    outcomes: ["ok", "fail"],
    key: ({ pr }) => `pr:${pr}:ci`,
    match: (event: ExternalEvent, { pr }) => (event.type === "pr.ci" && event.pr === pr ? { outcome: event.state as string } : undefined),
    probe: () => {
      ci.probes++;
      return Promise.resolve(ci.current);
    },
  });
  return { ...h, ci };
}

/** La app que se corta: deja de despachar y lo que tenía en vuelo no vuelve a avanzar. */
const cut = (h: ReturnType<typeof boot>) => h.crash();

/** La app que arranca después del corte, sobre la misma base. */
const restart = (h: ReturnType<typeof boot>, bootId: string, options: Options = {}) => boot({ ...options, reopen: h.home, bootId });

const forever = () => new Promise<never>(() => {});

const stepOf = (h: ReturnType<typeof boot>, runId: Parameters<typeof h.flows.getRun>[0], nodeId: string) =>
  h.flows.getRun(runId).steps.find((s) => s.nodeId === nodeId);

const action = (id: string, extra: Record<string, unknown> = {}) => ({
  schema: 1,
  id,
  name: id,
  trigger: { type: "manual" },
  start: "work",
  nodes: { work: { type: "action", action: "work", args: {}, on: { ok: "@done" }, ...extra } },
});

describe("recover: action", () => {
  test("se re-ejecuta con la misma clave y salta las etapas que ya hizo", async () => {
    vi.useFakeTimers();
    const a = boot({ persist: true, bootId: "boot_A" });
    const keys: string[] = [];
    const sideEffects: string[] = [];
    a.action("work", ["ok"], async (_args, ctx) => {
      keys.push(ctx.key);
      await ctx.once("push", () => Promise.resolve(sideEffects.push("push")));
      return forever();
    });
    a.save(action("pr"));
    const runId = a.start("pr");
    await vi.advanceTimersByTimeAsync(0);
    expect(stepOf(a, runId, "work")).toMatchObject({ status: "running", attempt: 1 });
    void cut(a);

    const b = restart(a, "boot_B");
    b.action("work", ["ok"], async (_args, ctx) => {
      keys.push(ctx.key);
      await ctx.once("push", () => Promise.resolve(sideEffects.push("push")));
      return { outcome: "ok" };
    });
    expect(b.flows.recover()).toBe(1);
    await vi.advanceTimersByTimeAsync(0);

    expect(b.flows.getRun(runId)).toMatchObject({ status: "done", outcome: "done" });
    expect(stepOf(b, runId, "work")).toMatchObject({ status: "done", attempt: 2 });
    expect(keys).toEqual([`${runId}:work:1`, `${runId}:work:1`]);
    expect(sideEffects).toEqual(["push"]);
    expect(b.eventTypes(runId)).toContain("step.retrying");
  });

  test("un corte no gasta intento del retry", async () => {
    vi.useFakeTimers();
    const a = boot({ persist: true, bootId: "boot_A" });
    a.action("work", ["ok"], forever);
    a.save(action("pr", { retry: { max: 1, backoffSec: [1] } }));
    const runId = a.start("pr");
    await vi.advanceTimersByTimeAsync(0);
    void cut(a);

    const b = restart(a, "boot_B");
    let calls = 0;
    b.action("work", ["ok"], () => {
      if (++calls === 1) throw new Error("red caída");
      return { outcome: "ok" };
    });
    b.flows.recover();
    await vi.advanceTimersByTimeAsync(6000);

    // Sin el corte serían dos fallas y la corrida quedaría parked: max 1 permite una sola.
    expect(b.flows.getRun(runId)).toMatchObject({ status: "done", outcome: "done" });
    expect(stepOf(b, runId, "work")).toMatchObject({ attempt: 3 });
  });

  test("despierta al dispatcher: un paso con backoff pendiente corre sin que nadie lance nada", async () => {
    vi.useFakeTimers();
    const a = boot({ persist: true, bootId: "boot_A" });
    a.action("work", ["ok"], () => {
      throw new Error("red caída");
    });
    a.save(action("pr", { retry: { max: 3, backoffSec: [10] } }));
    const runId = a.start("pr");
    await vi.advanceTimersByTimeAsync(0);
    expect(stepOf(a, runId, "work")).toMatchObject({ status: "pending" });
    void cut(a);

    const b = restart(a, "boot_B");
    b.action("work", ["ok"]);
    expect(b.flows.recover()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(b.flows.getRun(runId)).toMatchObject({ status: "done", outcome: "done" });
  });
});

describe("recover: agent", () => {
  const agentFlow = {
    schema: 1,
    id: "dev",
    name: "dev",
    trigger: { type: "manual" },
    start: "plan",
    nodes: {
      plan: { type: "agent", role: "dev", mode: "plan", brief: { issue: "$run.subject" }, on: { ok: "@done", changes: "@blocked" } },
    },
  };

  test("con sessionId retoma esa sesión con el aviso del corte y la deja cerrada una sola vez", async () => {
    vi.useFakeTimers();
    const a = boot({ persist: true, bootId: "boot_A", script: forever });
    a.save(agentFlow);
    const runId = a.start("dev");
    await vi.advanceTimersByTimeAsync(0);
    expect(a.store.db.select().from(agentSessions).all()).toMatchObject([{ status: "running" }]);
    void cut(a);

    const b = restart(a, "boot_B", { script: () => Promise.resolve(okReport()) });
    b.flows.recover();
    await vi.advanceTimersByTimeAsync(0);

    expect(b.calls).toHaveLength(1);
    expect(b.calls[0]).toMatchObject({ kind: "resume", subject: "ENG-1" });
    expect(b.calls[0]?.prompt).toMatch(/^La app se reinició mientras trabajabas/);
    expect(b.flows.getRun(runId)).toMatchObject({ status: "done", outcome: "done" });
    const sessions = b.store.db.select().from(agentSessions).all();
    expect(sessions.map((s) => s.status).sort()).toEqual(["error", "success"]);
    expect(b.eventTypes(runId).filter((t) => t === "agent.ended")).toHaveLength(2);
  });

  test("sin sessionId abre una sesión nueva con el mismo brief y el aviso de cambios a medias", async () => {
    vi.useFakeTimers();
    const a = boot({ persist: true, bootId: "boot_A", script: forever });
    a.save(agentFlow);
    const runId = a.start("dev");
    await vi.advanceTimersByTimeAsync(0);
    void cut(a);
    // El corte llegó antes de que el runtime le diera un id a la sesión.
    a.store.tx((tx) => tx.db.delete(agentSessions).run());

    const b = restart(a, "boot_B", { script: () => Promise.resolve(okReport()) });
    b.flows.recover();
    await vi.advanceTimersByTimeAsync(0);

    expect(b.calls).toHaveLength(1);
    expect(b.calls[0]).toMatchObject({ kind: "start", subject: "ENG-1" });
    expect(b.calls[0]?.prompt).toContain("cambios a medias");
    expect(b.flows.getRun(runId)).toMatchObject({ status: "done", outcome: "done" });
  });

  test("un reintento normal después del corte no repite el aviso", async () => {
    vi.useFakeTimers();
    const a = boot({ persist: true, bootId: "boot_A", script: forever });
    a.save({ ...agentFlow, nodes: { plan: { ...agentFlow.nodes.plan, retry: { max: 2, backoffSec: [1, 1] } } } });
    a.start("dev");
    await vi.advanceTimersByTimeAsync(0);
    void cut(a);

    let calls = 0;
    const b = restart(a, "boot_B", {
      script: () => (++calls === 1 ? Promise.reject(new Error("runtime caído")) : Promise.resolve(okReport())),
    });
    b.flows.recover();
    await vi.advanceTimersByTimeAsync(6000);

    expect(b.calls.map((c) => c.prompt.includes("La app se reinició"))).toEqual([true, false]);
  });
});

describe("recover: wait", () => {
  const waitFlow = {
    schema: 1,
    id: "ci",
    name: "ci",
    trigger: { type: "manual" },
    params: { pr: "number" },
    start: "ci-wait",
    nodes: {
      "ci-wait": {
        type: "wait",
        event: "pr.ci",
        args: { pr: "$run.params.pr" },
        timeoutSec: 600,
        on: { ok: "@done", fail: "@failed", timeout: "@blocked" },
      },
    },
  };

  test("sondea al bootear y encuentra lo que pasó con la app cerrada, sin esperar al calendario", async () => {
    vi.useFakeTimers();
    const a = boot({ persist: true, bootId: "boot_A", probeEverySec: 3600 });
    a.save(waitFlow);
    const runId = a.start("ci", undefined, { pr: 7 });
    await vi.advanceTimersByTimeAsync(0);
    expect(a.ci.probes).toBe(1);
    void cut(a);

    const b = restart(a, "boot_B", { probeEverySec: 3600 });
    b.ci.current = { outcome: "fail" };
    expect(b.flows.recover()).toBe(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(b.ci.probes).toBe(1);
    expect(b.flows.getRun(runId)).toMatchObject({ status: "failed", outcome: "failed" });
  });

  test("sin novedades sigue esperando con su clave, y un plazo que venció con la app cerrada da timeout", async () => {
    vi.useFakeTimers();
    const a = boot({ persist: true, bootId: "boot_A" });
    a.save(waitFlow);
    const runId = a.start("ci", undefined, { pr: 7 });
    await vi.advanceTimersByTimeAsync(0);
    void cut(a);

    const b = restart(a, "boot_B");
    b.flows.recover();
    await vi.advanceTimersByTimeAsync(0);
    expect(b.flows.getRun(runId).status).toBe("running");
    expect(stepOf(b, runId, "ci-wait")).toMatchObject({ status: "waiting", waitKey: "pr:7:ci" });

    vi.setSystemTime(Date.now() + 601_000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(b.flows.getRun(runId)).toMatchObject({ status: "failed", outcome: "blocked" });
  });

  test("un signal después del corte cierra el wait recuperado", async () => {
    vi.useFakeTimers();
    const a = boot({ persist: true, bootId: "boot_A" });
    a.save(waitFlow);
    const runId = a.start("ci", undefined, { pr: 7 });
    await vi.advanceTimersByTimeAsync(0);
    void cut(a);

    const b = restart(a, "boot_B");
    b.flows.recover();
    await vi.advanceTimersByTimeAsync(0);
    b.flows.signal({ type: "pr.ci", pr: 7, state: "ok" });
    await vi.advanceTimersByTimeAsync(0);

    expect(b.flows.getRun(runId)).toMatchObject({ status: "done", outcome: "done" });
  });
});

describe("recover: parallel", () => {
  const parallelFlow = {
    schema: 1,
    id: "checks",
    name: "checks",
    trigger: { type: "manual" },
    start: "all",
    nodes: {
      all: { type: "parallel", branches: ["lint", "tests"], on: { ok: "@done", changes: "@failed", fail: "@failed", error: "@failed" } },
      lint: { type: "action", action: "lint", args: {} },
      tests: { type: "action", action: "tests", args: {} },
    },
  };

  test("recupera la rama cortada, no repite la que terminó y el join se evalúa al cerrar la última", async () => {
    vi.useFakeTimers();
    const a = boot({ persist: true, bootId: "boot_A" });
    a.action("lint", ["ok"]);
    a.action("tests", ["ok"], forever);
    a.save(parallelFlow);
    const runId = a.start("checks");
    await vi.advanceTimersByTimeAsync(0);
    expect(stepOf(a, runId, "lint")).toMatchObject({ status: "done" });
    expect(stepOf(a, runId, "tests")).toMatchObject({ status: "running" });
    expect(stepOf(a, runId, "all")).toMatchObject({ status: "waiting" });
    void cut(a);

    const b = restart(a, "boot_B");
    const ran: string[] = [];
    b.action("lint", ["ok"], () => {
      ran.push("lint");
      return { outcome: "ok" };
    });
    b.action("tests", ["ok"], () => {
      ran.push("tests");
      return { outcome: "ok" };
    });
    expect(b.flows.recover()).toBe(1);
    await vi.advanceTimersByTimeAsync(0);

    expect(ran).toEqual(["tests"]);
    expect(b.flows.getRun(runId)).toMatchObject({ status: "done", outcome: "done" });
    expect(stepOf(b, runId, "all")).toMatchObject({ status: "done", outcome: "ok" });
  });

  test("una rama que agota sus cortes da error y el join lo recoge", async () => {
    vi.useFakeTimers();
    let h = boot({ persist: true, bootId: "boot_0" });
    h.action("lint", ["ok"]);
    h.action("tests", ["ok"], forever);
    h.save(parallelFlow);
    const runId = h.start("checks");
    await vi.advanceTimersByTimeAsync(0);
    for (const bootId of ["boot_1", "boot_2", "boot_3"]) {
      void cut(h);
      h = restart(h, bootId);
      h.action("lint", ["ok"]);
      h.action("tests", ["ok"], forever);
      h.flows.recover();
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(stepOf(h, runId, "tests")).toMatchObject({ status: "failed", outcome: "error" });
    expect(stepOf(h, runId, "all")).toMatchObject({ status: "done", outcome: "error" });
    expect(h.flows.getRun(runId)).toMatchObject({ status: "failed", outcome: "failed" });
  });
});

describe("recover: límite de cortes", () => {
  test("al tercer corte en el mismo paso da error y la corrida queda parked con el motivo", async () => {
    vi.useFakeTimers();
    let h = boot({ persist: true, bootId: "boot_0" });
    h.action("work", ["ok"], forever);
    h.save(action("pr"));
    const runId = h.start("pr");
    await vi.advanceTimersByTimeAsync(0);

    for (const bootId of ["boot_1", "boot_2"]) {
      void cut(h);
      h = restart(h, bootId);
      h.action("work", ["ok"], forever);
      expect(h.flows.recover()).toBe(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(stepOf(h, runId, "work")).toMatchObject({ status: "running" });
    }
    void cut(h);
    h = restart(h, "boot_3");
    h.action("work", ["ok"], forever);
    h.flows.recover();
    await vi.advanceTimersByTimeAsync(0);

    expect(stepOf(h, runId, "work")).toMatchObject({ status: "failed", outcome: "error", error: expect.stringContaining("3 veces") });
    expect(h.flows.getRun(runId)).toMatchObject({ status: "parked", parkReason: "needs_human" });
  });

  test("si cerrar el paso al tercer corte falla, su corrida queda parked y el resto se recupera igual", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    cleanups.push(() => log.mockRestore());
    let h = boot({ persist: true, bootId: "boot_0" });
    h.action("work", ["ok"], forever);
    h.save({
      ...action("broken"),
      params: { rounds: { type: "number", default: 2 } },
      nodes: {
        work: { type: "action", action: "work", args: {}, on: { ok: "@done", error: { to: "work", maxRounds: "$run.params.rounds", exhausted: "@failed" } } },
      },
    });
    h.save(action("pr"));
    const broken = h.start("broken", { type: "issue", id: "ENG-1" });
    await vi.advanceTimersByTimeAsync(0);

    for (const bootId of ["boot_1", "boot_2"]) {
      void cut(h);
      h = restart(h, bootId);
      h.action("work", ["ok"], forever);
      h.flows.recover();
      await vi.advanceTimersByTimeAsync(0);
    }
    const healthy = h.start("pr", { type: "issue", id: "ENG-2" });
    await vi.advanceTimersByTimeAsync(0);
    // Un param roto: el edge `error` ya no puede resolver su maxRounds.
    h.store.db.$client.exec(`UPDATE runs SET params = '{"rounds":0}' WHERE id = '${broken}'`);
    void cut(h);
    h = restart(h, "boot_3");
    h.action("work", ["ok"]);

    expect(h.flows.recover()).toBe(2);
    await vi.advanceTimersByTimeAsync(0);

    expect(stepOf(h, broken, "work")).toMatchObject({ status: "failed", outcome: "error", error: expect.stringContaining("rounds") });
    expect(h.flows.getRun(broken)).toMatchObject({ status: "parked", parkReason: "needs_human" });
    expect(h.flows.getRun(healthy)).toMatchObject({ status: "done", outcome: "done" });
  });
});

describe("fencing del attempt", () => {
  test("el cierre de un attempt viejo se rechaza y su lease perdido interrumpe al zombi", async () => {
    vi.useFakeTimers();
    const a = boot({ persist: true, bootId: "boot_A" });
    const zombie = { release: () => {}, aborted: false };
    a.action("work", ["a", "b"], (_args, ctx) => {
      ctx.signal.addEventListener("abort", () => (zombie.aborted = true));
      return new Promise((resolve) => (zombie.release = () => resolve({ outcome: "a" })));
    });
    a.save({
      ...action("pr"),
      nodes: { work: { type: "action", action: "work", args: {}, on: { a: "@failed", b: "@done" } } },
    });
    const runId = a.start("pr");
    await vi.advanceTimersByTimeAsync(0);
    expect(stepOf(a, runId, "work")).toMatchObject({ status: "running", attempt: 1 });
    const closing = cut(a);

    // La otra app toma el paso mientras la primera sigue viva (otra base abierta sobre el mismo archivo).
    const b = restart(a, "boot_B");
    b.action("work", ["a", "b"], () => ({ outcome: "b" }));
    b.flows.recover();
    await vi.advanceTimersByTimeAsync(0);
    expect(stepOf(b, runId, "work")).toMatchObject({ status: "done", outcome: "b", attempt: 2 });

    // El latido del attempt 1 ya no encuentra su lease: interrumpe a quien siga trabajando.
    await vi.advanceTimersByTimeAsync(40_000);
    expect(zombie.aborted).toBe(true);

    zombie.release();
    await closing;
    await vi.advanceTimersByTimeAsync(0);

    const row = b.store.db.select().from(stepRuns).all().find((s) => s.nodeId === "work");
    expect(row).toMatchObject({ status: "done", outcome: "b", attempt: 2 });
    expect(b.flows.getRun(runId)).toMatchObject({ status: "done", outcome: "done" });
  });
});

describe("recover: flow", () => {
  const subflow = {
    schema: 1,
    id: "pr-feedback",
    name: "feedback",
    trigger: { type: "subflow" },
    start: "work",
    nodes: { work: { type: "action", action: "work", args: {}, on: { ok: "@done" } } },
  };
  const caller = {
    schema: 1,
    id: "techlead",
    name: "techlead",
    trigger: { type: "manual" },
    start: "feedback",
    nodes: { feedback: { type: "flow", flow: "pr-feedback", params: {}, on: { done: "@done", blocked: "@blocked", failed: "@failed" } } },
  };
  const childOf = (h: ReturnType<typeof boot>, runId: string) => h.flows.listRuns().find((r) => r.parentRunId === runId);

  test("recupera el paso cortado de la hija y el padre sigue cuando ella termina", async () => {
    vi.useFakeTimers();
    const a = boot({ persist: true, bootId: "boot_A" });
    a.action("work", ["ok"], forever);
    a.save(subflow);
    a.save(caller);
    const runId = a.start("techlead");
    await vi.advanceTimersByTimeAsync(0);
    expect(stepOf(a, runId, "feedback")).toMatchObject({ status: "waiting" });
    void cut(a);

    const b = restart(a, "boot_B");
    b.action("work", ["ok"]);
    expect(b.flows.recover()).toBe(1);
    await vi.advanceTimersByTimeAsync(0);

    const child = childOf(b, runId);
    expect(b.flows.getRun(child?.id as RunId)).toMatchObject({ status: "done", outcome: "done" });
    expect(b.flows.getRun(child?.id as RunId).steps[0]).toMatchObject({ attempt: 2 });
    expect(b.flows.getRun(runId)).toMatchObject({ status: "done", outcome: "done" });
    expect(stepOf(b, runId, "feedback")).toMatchObject({ status: "done", outcome: "done" });
  });

  test("si el corte llegó entre el fin de la hija y el cierre del padre, recover cierra el paso", async () => {
    vi.useFakeTimers();
    const a = boot({ persist: true, bootId: "boot_A" });
    a.action("work", ["ok"], forever);
    a.save(subflow);
    a.save(caller);
    const runId = a.start("techlead");
    await vi.advanceTimersByTimeAsync(0);
    void cut(a);

    const b = restart(a, "boot_B");
    b.action("work", ["ok"]);
    const child = childOf(b, runId);
    // La hija terminó @blocked y la app murió antes de cerrar el paso del padre.
    b.store.tx((tx) => {
      tx.db.update(stepRuns).set({ status: "done", outcome: "ok" }).where(eq(stepRuns.runId, child?.id as RunId)).run();
      tx.db.update(runs).set({ status: "failed", outcome: "blocked", endedAt: Date.now() }).where(eq(runs.id, child?.id as RunId)).run();
    });
    expect(stepOf(b, runId, "feedback")).toMatchObject({ status: "waiting" });
    b.flows.recover();
    await vi.advanceTimersByTimeAsync(0);

    expect(stepOf(b, runId, "feedback")).toMatchObject({ status: "done", outcome: "blocked" });
    expect(b.flows.getRun(runId)).toMatchObject({ status: "failed", outcome: "blocked" });
  });

  test("una hija estacionada por agotar sus cortes deja al padre esperando", async () => {
    vi.useFakeTimers();
    let h = boot({ persist: true, bootId: "boot_0" });
    h.action("work", ["ok"], forever);
    h.save(subflow);
    h.save(caller);
    const runId = h.start("techlead");
    await vi.advanceTimersByTimeAsync(0);
    for (const bootId of ["boot_1", "boot_2", "boot_3"]) {
      void cut(h);
      h = restart(h, bootId);
      h.action("work", ["ok"], forever);
      h.flows.recover();
      await vi.advanceTimersByTimeAsync(0);
    }

    const child = childOf(h, runId);
    expect(h.flows.getRun(child?.id as RunId)).toMatchObject({ status: "parked", parkReason: "needs_human" });
    expect(h.flows.getRun(runId).status).toBe("running");
    expect(stepOf(h, runId, "feedback")).toMatchObject({ status: "waiting" });
  });
});

describe("salto de reloj", () => {
  test("al despertar de un sleep extiende los leases propios y avisa a quien mantiene otros", async () => {
    vi.useFakeTimers();
    const onClockJump = vi.fn();
    const h = boot({ onClockJump });
    h.action("work", ["ok"], forever);
    h.save(action("pr"));
    const runId = h.start("pr");
    await vi.advanceTimersByTimeAsync(0);
    const lease = () => h.store.db.select().from(stepRuns).all().find((s) => s.nodeId === "work")?.leaseUntil;
    const first = lease();
    expect(first).toBe(Date.now() + 120_000);

    // Sin salto, los ticks normales no tocan nada.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onClockJump).not.toHaveBeenCalled();

    // La máquina duerme 10 min: el lease quedó vencido y los timers no corrieron.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    expect(lease()).toBeLessThan(Date.now());
    await vi.advanceTimersByTimeAsync(5000);

    expect(lease()).toBe(Date.now() + 120_000);
    expect(onClockJump).toHaveBeenCalledTimes(1);
    expect(stepOf(h, runId, "work")).toMatchObject({ status: "running", attempt: 1 });
    void cut(h);
  });
});

test("registrar una acción después de recover() lanza: los pasos recuperados ya no la encontrarían", () => {
  const h = boot();
  h.flows.recover();

  expect(() => h.action("tarde", ["ok"])).toThrow(/después de recover\(\)/);
});
