import { afterEach, describe, expect, test, vi } from "vitest";
import { OUTPUT_INLINE_MAX_BYTES } from "./engine";
import { devProfile, devRole, harness as createHarness, okReport, WAIT } from "./harness";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function harness(options: Parameters<typeof createHarness>[0] = {}) {
  const h = createHarness(options);
  cleanups.push(h.cleanup);
  return h;
}

describe("un flujo action → agent → action", () => {
  const linear = {
    schema: 1,
    id: "linear",
    name: "Lineal",
    trigger: { type: "manual" },
    start: "ws",
    nodes: {
      ws: { type: "action", action: "ws.open", args: {}, on: { ok: "plan" } },
      plan: {
        type: "agent",
        role: "dev",
        mode: "plan",
        brief: { ws: "$ws", issue: "$run.subject" },
        on: { ok: "publish", changes: "@blocked" },
      },
      publish: { type: "action", action: "pr.open", args: { plan: "$plan", issue: "$run.subject" }, on: { ok: "@done" } },
    },
  };

  test("termina en @done con los eventos en orden y los outputs viajan por refs", async () => {
    const h = harness();
    const published: unknown[] = [];
    h.action("ws.open", ["ok"], () => ({ outcome: "ok", output: { path: "/work/tree" } }));
    h.action("pr.open", ["ok"], (args) => {
      published.push(args);
      return { outcome: "ok", output: { pr: 7 } };
    });
    h.save(linear);

    const runId = h.start("linear");
    await h.finished(runId);

    const view = h.flows.getRun(runId);
    expect(view).toMatchObject({ status: "done", outcome: "done", lane: "dev", costMicros: 500 });
    expect(view.steps.map((s) => [s.nodeId, s.status, s.outcome])).toEqual([
      ["ws", "done", "ok"],
      ["plan", "done", "ok"],
      ["publish", "done", "ok"],
    ]);
    expect(h.eventTypes(runId)).toEqual([
      "run.started",
      "step.started",
      "step.finished",
      "step.started",
      "agent.started",
      "agent.ended",
      "step.finished",
      "step.started",
      "step.finished",
      "run.finished",
    ]);
    expect(published).toEqual([{ plan: { n: 1 }, issue: { type: "issue", id: "ENG-1" } }]);
    expect(h.calls[0]?.spec?.prompt).toContain("/work/tree");
    expect(view.steps[1]?.costMicros).toBe(500);
  });

  test("el agente queda atado a la versión del rol y del perfil de cuando empezó la corrida", async () => {
    const h = harness();
    h.action("ws.open", ["ok"]);
    h.action("pr.open", ["ok"]);
    h.save(linear);

    const runId = h.start("linear");
    h.defs.save({ kind: "role", slug: "dev", scope: "user", body: devRole("Eres dev v2."), source: "ui" });
    h.defs.save({ kind: "profile", slug: "default", scope: "user", body: devProfile("opus"), source: "ui" });
    await h.finished(runId);

    expect(h.calls[0]?.spec).toMatchObject({ systemPrompt: "Eres dev v1.", model: "sonnet" });
  });

  test("un outcome que no es ok sigue su edge", async () => {
    const h = harness({ script: () => Promise.resolve(okReport({ n: 1 }, "changes")) });
    h.action("ws.open", ["ok"]);
    h.action("pr.open", ["ok"]);
    h.save(linear);

    const runId = h.start("linear");
    await h.finished(runId);

    expect(h.flows.getRun(runId)).toMatchObject({ status: "failed", outcome: "blocked" });
    expect(h.nodes(runId)).toEqual(["ws", "plan"]);
  });

  test("resumeFrom retoma la sesión del nodo anterior si el modo lo permite", async () => {
    const h = harness();
    h.save({
      schema: 1,
      id: "two-agents",
      name: "Dos agentes",
      trigger: { type: "manual" },
      start: "plan",
      nodes: {
        plan: { type: "agent", role: "dev", mode: "plan", brief: {}, on: { ok: "implement", changes: "@failed" } },
        implement: {
          type: "agent",
          role: "dev",
          mode: "implement",
          resumeFrom: "plan",
          brief: {},
          on: { ok: "@done", changes: "@failed" },
        },
      },
    });

    const runId = h.start("two-agents");
    await h.finished(runId);

    expect(h.calls.map((c) => c.kind)).toEqual(["start", "resume"]);
    expect(h.flows.getRun(runId).status).toBe("done");
  });

  test("el costo de la corrida es la suma del costo de sus pasos", async () => {
    const costs = [300, 700];
    const h = harness({
      script: async () => ({
        ...okReport(),
        usage: { turns: 1, tokensIn: 1, tokensOut: 1, tokensCacheRead: 0, tokensCacheWrite: 0, costMicros: costs.shift() ?? 0, costSource: "runtime" },
      }),
    });
    h.save({
      schema: 1,
      id: "two-costs",
      name: "Dos costos",
      trigger: { type: "manual" },
      start: "plan",
      nodes: {
        plan: { type: "agent", role: "dev", mode: "plan", brief: {}, on: { ok: "implement", changes: "@failed" } },
        implement: { type: "agent", role: "dev", mode: "plan", brief: {}, on: { ok: "@done", changes: "@failed" } },
      },
    });

    const runId = h.start("two-costs");
    await h.finished(runId);

    const view = h.flows.getRun(runId);
    expect(view.steps.map((s) => s.costMicros)).toEqual([300, 700]);
    expect(view.costMicros).toBe(1000);
    expect(view.costMicros).toBe(view.steps.reduce((sum, s) => sum + s.costMicros, 0));
  });
});

describe("rondas", () => {
  const checkLoop = (maxRounds: number | string) => ({
    schema: 1,
    id: "check-loop",
    name: "Checks",
    trigger: { type: "manual" },
    params: { checkRounds: { type: "number", default: 2 } },
    start: "check",
    nodes: {
      check: {
        type: "action",
        action: "check",
        args: {},
        on: { ok: "@done", fail: { to: "fix", maxRounds, exhausted: "end" } },
      },
      fix: { type: "action", action: "fix", args: {}, on: { ok: "check" } },
      end: { type: "action", action: "end", args: {}, on: { ok: "@done" } },
    },
  });

  test("un edge con maxRounds 2 toma exhausted en la tercera vuelta", async () => {
    const h = harness();
    h.action("check", ["ok", "fail"], () => ({ outcome: "fail" }));
    h.action("fix", ["ok"]);
    h.action("end", ["ok"]);
    h.save(checkLoop(2));

    const runId = h.start("check-loop");
    await h.finished(runId);

    const view = h.flows.getRun(runId);
    expect(view.steps.map((s) => `${s.nodeId}#${s.visit}`)).toEqual([
      "check#1",
      "fix#1",
      "check#2",
      "fix#2",
      "check#3",
      "end#1",
    ]);
    expect(view.steps.filter((s) => s.nodeId === "fix").map((s) => s.round)).toEqual([1, 2]);
    expect(view.rounds).toEqual({ "check.fail": 2 });
    expect(view).toMatchObject({ status: "done", outcome: "done" });
  });

  test("maxRounds puede ser un param de la corrida", async () => {
    const h = harness();
    h.action("check", ["ok", "fail"], () => ({ outcome: "fail" }));
    h.action("fix", ["ok"]);
    h.action("end", ["ok"]);
    h.save(checkLoop("$run.params.checkRounds"));

    const runId = h.start("check-loop", { type: "issue", id: "ENG-1" }, { checkRounds: 1 });
    await h.finished(runId);

    expect(h.nodes(runId)).toEqual(["check", "fix", "check", "end"]);
  });

  test("un param inválido como maxRounds se rechaza al empezar", () => {
    const h = harness();
    h.action("check", ["ok", "fail"]);
    h.action("fix", ["ok"]);
    h.action("end", ["ok"]);
    h.save(checkLoop("$run.params.checkRounds"));

    expect(() => h.start("check-loop", { type: "issue", id: "ENG-1" }, { checkRounds: 0 })).toThrow(/checkRounds/);
  });

  test("edges con el mismo counter comparten las rondas", async () => {
    const h = harness();
    h.action("always-fails", ["ok", "fail"], () => ({ outcome: "fail" }));
    h.action("repair", ["ok"]);
    const bounded = (to: string) => ({ to, counter: "shared", maxRounds: 2, exhausted: "@failed" });
    h.save({
      schema: 1,
      id: "shared",
      name: "Compartido",
      trigger: { type: "manual" },
      start: "x",
      nodes: {
        x: { type: "action", action: "always-fails", args: {}, on: { ok: "@done", fail: bounded("fix-x") } },
        "fix-x": { type: "action", action: "repair", args: {}, on: { ok: "y" } },
        y: { type: "action", action: "always-fails", args: {}, on: { ok: "@done", fail: bounded("fix-y") } },
        "fix-y": { type: "action", action: "repair", args: {}, on: { ok: "x" } },
      },
    });

    const runId = h.start("shared");
    await h.finished(runId);

    expect(h.nodes(runId)).toEqual(["x", "fix-x", "y", "fix-y", "x"]);
    expect(h.flows.getRun(runId)).toMatchObject({ status: "failed", outcome: "failed", rounds: { shared: 2 } });
  });

  test("el edge puede dejar una nota al tomarse", async () => {
    const h = harness();
    h.action("check", ["ok", "fail"], () => ({ outcome: "fail" }));
    h.save({
      schema: 1,
      id: "noted",
      name: "Con nota",
      trigger: { type: "manual" },
      start: "check",
      nodes: { check: { type: "action", action: "check", args: {}, on: { ok: "@done", fail: { to: "@done", note: "Tests rojos" } } } },
    });

    const runId = h.start("noted");
    await h.finished(runId);

    const finishedStep = h.store.events.since(0, { runId, types: ["step.finished"] })[0];
    expect(finishedStep?.payload).toMatchObject({ outcome: "fail", note: "Tests rojos" });
  });
});

describe("start", () => {
  const single = {
    schema: 1,
    id: "single",
    name: "Uno",
    trigger: { type: "manual" },
    params: { base: "string" },
    start: "work",
    nodes: { work: { type: "action", action: "work", args: {}, on: { ok: "@done" } } },
  };

  test("dos veces con el mismo flujo y sujeto devuelve la misma corrida", async () => {
    const h = harness();
    h.action("work", ["ok"]);
    h.save(single);

    const first = h.start("single", { type: "issue", id: "ENG-1" }, { base: "main" });
    const second = h.start("single", { type: "issue", id: "ENG-1" }, { base: "otra" });

    expect(second).toBe(first);
    expect(h.flows.getRun(first).params).toEqual({ base: "main" });
    await h.finished(first);

    // Terminada, el flujo se puede lanzar otra vez sobre el mismo sujeto.
    const third = h.start("single", { type: "issue", id: "ENG-1" }, { base: "main" });
    expect(third).not.toBe(first);
    await h.finished(third);
  });

  test("otro sujeto es otra corrida", async () => {
    const h = harness();
    h.action("work", ["ok"]);
    h.save(single);

    const a = h.start("single", { type: "issue", id: "ENG-1" }, { base: "main" });
    const b = h.start("single", { type: "pr", id: "ENG-1" }, { base: "main" });

    expect(b).not.toBe(a);
    await Promise.all([h.finished(a), h.finished(b)]);
  });

  test("rechaza sin crear nada lo que no puede correr", () => {
    const h = harness();
    h.action("work", ["ok"]);
    h.save(single);
    h.save({
      schema: 1,
      id: "with-gate",
      name: "Con gate",
      trigger: { type: "manual" },
      start: "both",
      nodes: {
        both: { type: "parallel", branches: ["ask"], on: { ok: "@done", changes: "@blocked", fail: "@failed" } },
        ask: { type: "gate", question: "¿Sigo?", timeoutSec: 60, options: [{ id: "yes", label: "Sí" }] },
      },
    });

    expect(() => h.start("single")).toThrow(/Falta el param "base"/);
    expect(() => h.start("single", undefined, { base: "main", extra: 1 })).toThrow(/extra/);
    expect(() => h.start("nope")).toThrow(/No existe el flujo/);
    expect(() => h.start("with-gate")).toThrow(/gate como rama de un parallel: ask/);
    expect(h.store.events.since(0, { types: ["run.started"] })).toEqual([]);
  });

  test("un flujo con agentes exige perfil", () => {
    const h = harness();
    h.save({
      schema: 1,
      id: "agent-only",
      name: "Agente",
      trigger: { type: "manual" },
      start: "plan",
      nodes: { plan: { type: "agent", role: "dev", mode: "plan", brief: {}, on: { ok: "@done", changes: "@failed" } } },
    });

    expect(() => h.flows.start("agent-only", { type: "issue", id: "ENG-1" })).toThrow(/perfil/);
  });
});

describe("refs", () => {
  test("$prev y $self traen el output del paso anterior y el de la visita anterior del mismo nodo", async () => {
    const h = harness();
    const seen: Record<string, unknown>[] = [];
    h.action("begin", ["ok"], () => ({ outcome: "ok", output: { n: 0 } }));
    h.action("review", ["ok", "again"], (args) => {
      seen.push(args);
      const n = ((args.prev as { n: number }).n ?? 0) + 1;
      return { outcome: seen.length < 2 ? "again" : "ok", output: { n } };
    });
    h.save({
      schema: 1,
      id: "prev-self",
      name: "Prev y self",
      trigger: { type: "manual" },
      start: "begin",
      nodes: {
        begin: { type: "action", action: "begin", args: {}, on: { ok: "review" } },
        review: {
          type: "action",
          action: "review",
          args: { prev: "$prev", self: "$self", subject: "$run.subject.id" },
          on: { ok: "@done", again: { to: "review", maxRounds: 3, exhausted: "@done" } },
        },
      },
    });

    const runId = h.start("prev-self");
    await h.finished(runId);

    expect(seen).toEqual([
      { prev: { n: 0 }, self: null, subject: "ENG-1" },
      { prev: { n: 1 }, self: { n: 1 }, subject: "ENG-1" },
    ]);
  });

  test("when falso salta el paso con outcome skipped, que sigue el edge ok", async () => {
    const h = harness();
    const ran: string[] = [];
    h.action("begin", ["ok"], () => ({ outcome: "ok", output: { doubts: [] } }));
    h.action("maybe", ["ok"], () => {
      ran.push("maybe");
      return { outcome: "ok" };
    });
    h.save({
      schema: 1,
      id: "when",
      name: "When",
      trigger: { type: "manual" },
      start: "begin",
      nodes: {
        begin: { type: "action", action: "begin", args: {}, on: { ok: "maybe" } },
        maybe: { type: "action", action: "maybe", args: {}, when: "$begin.doubts", on: { ok: "@done" } },
      },
    });

    const runId = h.start("when");
    await h.finished(runId);

    expect(ran).toEqual([]);
    const maybe = h.flows.getRun(runId).steps[1];
    expect(maybe).toMatchObject({ nodeId: "maybe", status: "done", outcome: "skipped", attempt: 1 });
  });

  test("un valor de más de 16 KB va a artifacts y el paso recibe la referencia", async () => {
    const h = harness();
    const blob = "x".repeat(OUTPUT_INLINE_MAX_BYTES + 1);
    let received: Record<string, unknown> = {};
    h.action("big", ["ok"], () => ({ outcome: "ok", output: { blob, small: 1 } }));
    h.action("use", ["ok"], (args) => {
      received = args;
      return { outcome: "ok" };
    });
    h.save({
      schema: 1,
      id: "big",
      name: "Grande",
      trigger: { type: "manual" },
      start: "big",
      nodes: {
        big: { type: "action", action: "big", args: {}, on: { ok: "use" } },
        use: { type: "action", action: "use", args: { all: "$big", blob: "$big.blob", small: "$big.small" }, on: { ok: "@done" } },
      },
    });

    const runId = h.start("big");
    await h.finished(runId);

    expect(received).toMatchObject({ small: 1, all: { size: expect.any(Number) }, blob: { size: blob.length + 2 } });
    const { artifact } = received.blob as { artifact: string };
    const stored = h.artifacts.get(artifact as never);
    expect(JSON.parse(new TextDecoder().decode(stored?.content))).toBe(blob);
  });
});

describe("acciones", () => {
  const charge = (extra: Record<string, unknown> = {}) => ({
    schema: 1,
    id: "charge",
    name: "Cobro",
    trigger: { type: "manual" },
    start: "charge",
    nodes: {
      charge: {
        type: "action",
        action: "charge",
        args: {},
        on: { ok: "@done", error: "recover" },
        ...extra,
      },
      recover: { type: "action", action: "recover", args: {}, on: { ok: "@done" } },
    },
  });

  test("una acción que falla dos veces y pasa a la tercera usa la misma clave y no repite las etapas de once", async () => {
    const h = harness();
    const keys: string[] = [];
    const effects: string[] = [];
    h.action("charge", ["ok"], async (_args, ctx) => {
      keys.push(ctx.key);
      await ctx.once("create-invoice", () => {
        effects.push("create-invoice");
        return Promise.resolve({ id: "inv_1" });
      });
      if (keys.length < 3) throw new Error("503 del banco");
      const invoice = await ctx.once("create-invoice", () => Promise.resolve({ id: "otro" }));
      return { outcome: "ok", output: invoice };
    });
    h.action("recover", ["ok"]);
    h.save(charge({ retry: { max: 2, backoffSec: [0, 0] } }));

    const runId = h.start("charge");
    await h.finished(runId);

    const view = h.flows.getRun(runId);
    expect(keys).toEqual([`${runId}:charge:1`, `${runId}:charge:1`, `${runId}:charge:1`]);
    expect(effects).toEqual(["create-invoice"]);
    expect(view.steps).toHaveLength(1);
    expect(view.steps[0]).toMatchObject({ status: "done", outcome: "ok", attempt: 3 });
    expect(h.eventTypes(runId).filter((t) => t === "step.retrying")).toHaveLength(2);
  });

  test("por defecto reintenta 3 veces con 10 s, 60 s y 5 min de backoff", async () => {
    vi.useFakeTimers();
    const h = harness();
    let calls = 0;
    h.action("charge", ["ok"], () => {
      if (++calls < 3) throw new Error("timeout de red");
      return { outcome: "ok" };
    });
    h.action("recover", ["ok"]);
    h.save(charge());

    const t0 = Date.now();
    const runId = h.start("charge");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.flows.getRun(runId).steps[0]).toMatchObject({ status: "pending", attempt: 1, notBefore: t0 + 10_000 });

    await vi.advanceTimersByTimeAsync(9_000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2);
    expect(h.flows.getRun(runId).steps[0]).toMatchObject({ status: "pending", attempt: 2, notBefore: t0 + 70_000 });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.flows.getRun(runId)).toMatchObject({ status: "done", outcome: "done" });
    expect(calls).toBe(3);
  });

  test("los outcomes de negocio nunca se reintentan", async () => {
    const h = harness();
    let calls = 0;
    h.action("charge", ["ok", "declined"], () => {
      calls++;
      return { outcome: "declined" };
    });
    h.action("recover", ["ok"]);
    h.save({
      ...charge(),
      nodes: { charge: { type: "action", action: "charge", args: {}, on: { ok: "@done", declined: "@blocked" } } },
    });

    const runId = h.start("charge");
    await h.finished(runId);

    expect(calls).toBe(1);
    expect(h.flows.getRun(runId)).toMatchObject({ status: "failed", outcome: "blocked" });
  });

  test("agotados los reintentos sigue el edge error, y sin edge la corrida queda parked", async () => {
    const h = harness();
    h.action("charge", ["ok"], () => {
      throw new Error("503 del banco");
    });
    h.action("recover", ["ok"]);
    h.save(charge({ retry: { max: 1, backoffSec: [0] } }));
    h.save({
      ...charge({ retry: { max: 1, backoffSec: [0] } }),
      id: "charge-no-edge",
      nodes: {
        charge: { type: "action", action: "charge", args: {}, retry: { max: 1, backoffSec: [0] }, on: { ok: "@done" } },
      },
    });

    const handled = h.start("charge");
    const parked = h.start("charge-no-edge");
    await Promise.all([h.finished(handled), h.finished(parked)]);

    expect(h.flows.getRun(handled)).toMatchObject({ status: "done" });
    expect(h.nodes(handled)).toEqual(["charge", "recover"]);
    expect(h.flows.getRun(handled).steps[0]).toMatchObject({ outcome: "error", error: "503 del banco", attempt: 2 });
    const view = h.flows.getRun(parked);
    expect(view).toMatchObject({ status: "parked", parkReason: "needs_human", outcome: null });
    expect(view.steps[0]).toMatchObject({ status: "failed", outcome: "error", error: "503 del banco" });
    expect(h.eventTypes(parked).at(-1)).toBe("run.parked");
  });

  test("un outcome que la acción no declara es un error sin reintento", async () => {
    const h = harness();
    let calls = 0;
    h.action("charge", ["ok"], () => {
      calls++;
      return { outcome: "inventado" };
    });
    h.action("recover", ["ok"]);
    h.save(charge());

    const runId = h.start("charge");
    await h.finished(runId);

    expect(calls).toBe(1);
    expect(h.flows.getRun(runId).steps[0]).toMatchObject({ outcome: "error", error: expect.stringContaining("inventado") });
  });

  test("al vencer timeoutSec aborta el signal y sigue el edge timeout", async () => {
    vi.useFakeTimers();
    const h = harness();
    let signal: AbortSignal | undefined;
    h.action("charge", ["ok"], (_args, ctx) => {
      signal = ctx.signal;
      return new Promise<never>(() => {});
    });
    h.action("recover", ["ok"]);
    h.save(charge({ timeoutSec: 30, on: { ok: "@done", timeout: "recover", error: "@failed" } }));

    const runId = h.start("charge");
    await vi.advanceTimersByTimeAsync(29_000);
    expect(h.flows.getRun(runId).status).toBe("running");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(signal?.aborted).toBe(true);
    expect(h.nodes(runId)).toEqual(["charge", "recover"]);
    expect(h.flows.getRun(runId).steps[0]).toMatchObject({ outcome: "timeout" });
  });
});

describe("fallos del propio motor", () => {
  test("si no se puede cerrar un paso, la corrida queda parked en él y el evento de inicio queda cerrado", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    cleanups.push(() => log.mockRestore());
    const h = harness();
    h.action("check", ["ok", "fail"], () => {
      // Un param roto a mitad de la corrida: el edge ya no puede resolver su maxRounds.
      h.store.db.$client.exec(`UPDATE runs SET params = '{"checkRounds":0}'`);
      return { outcome: "fail" };
    });
    h.action("fix", ["ok"]);
    h.save({
      schema: 1,
      id: "broken",
      name: "Roto",
      trigger: { type: "manual" },
      params: { checkRounds: { type: "number", default: 2 } },
      start: "check",
      nodes: {
        check: {
          type: "action",
          action: "check",
          args: {},
          on: { ok: "@done", fail: { to: "fix", maxRounds: "$run.params.checkRounds", exhausted: "@failed" } },
        },
        fix: { type: "action", action: "fix", args: {}, on: { ok: "check" } },
      },
    });

    const runId = h.start("broken");
    await h.finished(runId);

    expect(h.flows.getRun(runId)).toMatchObject({ status: "parked", parkReason: "needs_human" });
    expect(h.flows.getRun(runId).steps[0]).toMatchObject({ status: "failed", outcome: "error", error: expect.stringContaining("checkRounds") });
    expect(h.eventTypes(runId)).toEqual(["run.started", "step.started", "step.finished", "run.parked"]);
    expect(log).toHaveBeenCalled();
  });

  test("un paso que el motor no puede cargar estaciona su corrida sin frenar a las demás", async () => {
    vi.useFakeTimers();
    const h = harness();
    let calls = 0;
    h.action("flaky", ["ok"], () => {
      if (++calls === 1) throw new Error("timeout de red");
      return { outcome: "ok" };
    });
    const single = (id: string) => ({
      schema: 1,
      id,
      name: id,
      trigger: { type: "manual" },
      start: "flaky",
      nodes: { flaky: { type: "action", action: "flaky", args: {}, on: { ok: "@done" } } },
    });
    h.save(single("old"));
    h.save(single("new"));

    const old = h.start("old", { type: "issue", id: "ENG-1" });
    await vi.advanceTimersByTimeAsync(0);
    // El paso en backoff apunta a un nodo que su flujo ya no tiene.
    h.store.db.$client.exec(`UPDATE step_runs SET node_id = 'gone' WHERE run_id = '${old}'`);
    await vi.advanceTimersByTimeAsync(10_000);
    const fresh = h.start("new", { type: "issue", id: "ENG-2" });
    await vi.advanceTimersByTimeAsync(0);

    expect(h.flows.getRun(fresh)).toMatchObject({ status: "done" });
    expect(h.flows.getRun(old)).toMatchObject({ status: "parked", parkReason: "needs_human" });
    expect(h.flows.getRun(old).steps[0]).toMatchObject({ status: "failed", outcome: "error", error: expect.stringContaining("gone") });
    expect(h.eventTypes(old).slice(-2)).toEqual(["step.finished", "run.parked"]);
  });
});

describe("agentes", () => {
  const planner = (on: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    schema: 1,
    id: "planner",
    name: "Planner",
    trigger: { type: "manual" },
    start: "plan",
    nodes: { plan: { type: "agent", role: "dev", mode: "plan", brief: {}, on, ...extra } },
  });

  test("un timeout interrumpe al agente y sigue el edge timeout", async () => {
    vi.useFakeTimers();
    const h = harness({ script: () => new Promise(() => {}) });
    h.save(planner({ ok: "@done", changes: "@failed", timeout: "@blocked" }, { timeoutSec: 10 }));

    const runId = h.start("planner");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(h.flows.getRun(runId)).toMatchObject({ status: "failed", outcome: "blocked" });
    expect(h.flows.getRun(runId).steps[0]).toMatchObject({ outcome: "timeout" });
  });

  test("un reporte con el tope de turnos agotado es un error sin reintento", async () => {
    const h = harness({ script: () => Promise.resolve({ status: "error_max_turns", message: "se acabaron los turnos" }) });
    h.save(planner({ ok: "@done", changes: "@done", error: "@blocked" }));

    const runId = h.start("planner");
    await h.finished(runId);

    expect(h.calls).toHaveLength(1);
    expect(h.flows.getRun(runId).steps[0]).toMatchObject({ outcome: "error", error: "se acabaron los turnos" });
  });

  test("una cuota agotada devuelve el paso a pending hasta que se renueve, sin gastar intento", async () => {
    vi.useFakeTimers();
    let first = true;
    const h = harness({
      script: () => {
        if (!first) return Promise.resolve(okReport());
        first = false;
        return Promise.resolve({ status: "quota_exhausted", message: "sin cuota", resetsAt: Date.now() + 3_600_000 });
      },
    });
    h.save(planner({ ok: "@done", changes: "@failed" }));

    const runId = h.start("planner");
    await vi.advanceTimersByTimeAsync(0);
    // `attempt` es el token de fencing: no retrocede, el intento se descuenta aparte.
    expect(h.flows.getRun(runId).steps[0]).toMatchObject({ status: "pending", attempt: 1 });

    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(h.flows.getRun(runId)).toMatchObject({ status: "done" });
    expect(h.flows.getRun(runId).steps[0]).toMatchObject({ attempt: 2 });
  });
});

describe("intentos gastados y fencing", () => {
  test("una espera por el entorno no cuenta como intento del retry y attempt nunca retrocede", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const h = harness({
      script: () => {
        calls++;
        if (calls === 1) return Promise.resolve({ status: "quota_exhausted", message: "sin cuota", resetsAt: Date.now() + 1000 });
        if (calls === 2) return Promise.resolve({ status: "error", message: "falló" });
        return Promise.resolve(okReport());
      },
    });
    h.save({
      schema: 1,
      id: "planner",
      name: "planner",
      trigger: { type: "manual" },
      start: "plan",
      nodes: { plan: { type: "agent", role: "dev", mode: "plan", brief: {}, retry: { max: 1, backoffSec: [1] }, on: { ok: "@done", changes: "@failed" } } },
    });

    const runId = h.start("planner");
    await vi.advanceTimersByTimeAsync(10_000);

    // Con la espera contada como intento, la falla del segundo lease habría agotado el retry.
    expect(h.flows.getRun(runId)).toMatchObject({ status: "done" });
    expect(h.flows.getRun(runId).steps[0]).toMatchObject({ attempt: 3 });
  });
});

describe("dispatcher", () => {
  const agentFlow = (id: string, trigger: string) => ({
    schema: 1,
    id,
    name: id,
    trigger: { type: trigger },
    start: "plan",
    nodes: { plan: { type: "agent", role: "dev", mode: "plan", brief: {}, on: { ok: "@done", changes: "@failed" } } },
  });

  test("respeta el máximo global de agentes y atiende primero al carril de mantenimiento", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = harness({
      maxAgents: 1,
      script: (call) => (call.subject === "dev-1" ? gate.then(() => okReport()) : Promise.resolve(okReport())),
    });
    h.save(agentFlow("dev-flow", "manual"));
    h.save(agentFlow("maint-flow", "pr.conflict"));

    const first = h.start("dev-flow", { type: "issue", id: "dev-1" });
    const second = h.start("dev-flow", { type: "issue", id: "dev-2" });
    const maintenance = h.start("maint-flow", { type: "pr", id: "pr-3" });
    await vi.waitFor(() => expect(h.calls.map((c) => c.subject)).toEqual(["dev-1"]), WAIT);

    release();
    await Promise.all([h.finished(first), h.finished(second), h.finished(maintenance)]);

    expect(h.calls.map((c) => c.subject)).toEqual(["dev-1", "pr-3", "dev-2"]);
    expect(h.flows.getRun(maintenance).lane).toBe("maintenance");
  });
});
