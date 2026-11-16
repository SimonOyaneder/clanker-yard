import type { RunId } from "@clanker/api";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RunNotFoundError } from "./engine";
import { harness as createHarness, WAIT } from "./harness";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Options = Parameters<typeof createHarness>[0];

function harness(options: Options = {}) {
  const h = createHarness(options);
  cleanups.push(h.cleanup);
  h.action("handled", ["ok"]);
  /** La corrida hija (o la n-ésima) que lanzó `parent`. */
  const childrenOf = (parent: RunId) => h.flows.listRuns().filter((r) => r.parentRunId === parent).reverse();
  /** La acción `work` del subflujo `child()`: el test decide su outcome. */
  const work = (fn: (args: Record<string, unknown>) => { outcome: string } = () => ({ outcome: "ok" })) =>
    h.action("work", ["ok", "stuck", "broken"], fn);
  return { ...h, childrenOf, work };
}

const forever = () => new Promise<never>(() => {});
const ends = { done: "@done", blocked: "@blocked", failed: "@failed" };

/** Un subflujo de mantenimiento con un nodo `work` que decide el test. */
const child = (extra: Record<string, unknown> = {}) => ({
  schema: 1,
  id: "child",
  name: "Hijo",
  trigger: { type: "subflow" },
  params: { n: { type: "number", default: 0 } },
  start: "work",
  nodes: { work: { type: "action", action: "work", args: { n: "$run.params.n" }, on: { ok: "@done", stuck: "@blocked", broken: "@failed" } } },
  ...extra,
});

const parent = (call: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  schema: 1,
  id: "parent",
  name: "Padre",
  trigger: { type: "pr.comment" },
  start: "sub",
  nodes: {
    sub: { type: "flow", flow: "child", params: {}, on: { done: "@done", blocked: "handled", failed: "@failed" }, ...call },
    handled: { type: "action", action: "handled", args: {}, on: { ok: "@done" } },
  },
  ...extra,
});

describe("el nodo flow", () => {
  test("la hija termina @blocked y el padre sigue su edge blocked", async () => {
    const h = harness();
    h.work(() => ({ outcome: "stuck" }));
    h.save(child());
    h.save(parent());

    const runId = h.start("parent", { type: "pr", id: "acme/web#1" });
    await h.finished(runId);

    expect(h.flows.getRun(runId)).toMatchObject({ status: "done", outcome: "done" });
    expect(h.flows.getRun(runId).steps.map((s) => [s.nodeId, s.status, s.outcome])).toEqual([
      ["sub", "done", "blocked"],
      ["handled", "done", "ok"],
    ]);
    const [kid] = h.childrenOf(runId);
    expect(kid).toMatchObject({
      parentRunId: runId,
      flow: { slug: "child", version: 1 },
      subject: { type: "pr", id: "acme/web#1" },
      lane: "maintenance",
      outcome: "blocked",
    });
  });

  test.each([
    ["ok", "done", "done"],
    ["broken", "failed", "failed"],
  ])("el outcome %s de la hija es %s en el padre", async (result, outcome, status) => {
    const h = harness();
    h.work(() => ({ outcome: result }));
    h.save(child());
    h.save(parent());

    const runId = h.start("parent");
    await h.finished(runId);

    expect(h.flows.getRun(runId).steps[0]).toMatchObject({ nodeId: "sub", outcome });
    expect(h.flows.getRun(runId).status).toBe(status);
  });

  test("la hija recibe sus params, ve los nodos del padre y no pisa el sujeto vivo del padre", async () => {
    const h = harness();
    const seen: unknown[] = [];
    h.action("prepare", ["ok"], () => ({ outcome: "ok", output: { branch: "feat/x" } }));
    h.action("work", ["ok"], (args) => {
      seen.push(args);
      return { outcome: "ok" };
    });
    h.save(
      child({
        nodes: { work: { type: "action", action: "work", args: { n: "$run.params.n", branch: "$prepare.branch" }, on: { ok: "@done" } } },
      }),
    );
    h.save(
      parent(
        { params: { n: "$run.params.rounds" } },
        {
          params: { rounds: { type: "number", default: 3 } },
          start: "prepare",
          nodes: {
            prepare: { type: "action", action: "prepare", args: {}, on: { ok: "sub" } },
            sub: { type: "flow", flow: "child", params: { n: "$run.params.rounds" }, on: ends },
          },
        },
      ),
    );

    const runId = h.start("parent", undefined, { rounds: 5 });
    await h.finished(runId);

    expect(seen).toEqual([{ n: 5, branch: "feat/x" }]);
    expect(h.flows.getRun(runId).status).toBe("done");
  });

  test("un agente de la hija trabaja en el worktree del padre y retoma su sesión con resumeFrom", async () => {
    // El primero en pedir worktree es el paso `plan` del padre: solo él lo tiene tomado.
    let heldBy: string | undefined;
    const h = harness({
      workspaceOf: (id) => {
        heldBy ??= id;
        return id === heldBy ? { path: "/work/parent", base: "main" } : undefined;
      },
    });
    h.save(
      child({
        nodes: { implement: { type: "agent", role: "dev", mode: "implement", resumeFrom: "plan", brief: {}, on: { ok: "@done", changes: "@failed" } } },
        start: "implement",
      }),
    );

    h.save(
      parent(
        {},
        {
          start: "plan",
          nodes: {
            plan: { type: "agent", role: "dev", mode: "plan", brief: {}, on: { ok: "sub", changes: "@failed" } },
            sub: { type: "flow", flow: "child", params: {}, on: ends },
          },
        },
      ),
    );
    const runId = h.start("parent");
    await h.finished(runId);

    expect(h.flows.getRun(runId).status).toBe("done");
    expect(h.calls.map((c) => c.kind)).toEqual(["start", "resume"]);
  });

  test("stopBefore corta antes del nodo indicado y el padre sigue por done", async () => {
    const h = harness();
    const ran: string[] = [];
    for (const name of ["first", "second", "third"]) {
      h.action(name, ["ok"], () => {
        ran.push(name);
        return { outcome: "ok" };
      });
    }
    h.save(
      child({
        start: "first",
        nodes: {
          first: { type: "action", action: "first", args: {}, on: { ok: "second" } },
          second: { type: "action", action: "second", args: {}, on: { ok: "third" } },
          third: { type: "action", action: "third", args: {}, on: { ok: "@done" } },
        },
      }),
    );
    h.save(parent({ stopBefore: "third" }));

    const runId = h.start("parent");
    await h.finished(runId);

    expect(ran).toEqual(["first", "second"]);
    const [kid] = h.childrenOf(runId);
    expect(kid).toMatchObject({ status: "done", outcome: "done" });
    expect(h.flows.getRun(kid?.id as RunId).steps.map((s) => s.nodeId)).toEqual(["first", "second"]);
    expect(h.flows.getRun(runId)).toMatchObject({ status: "done", outcome: "done" });
  });

  test("stopBefore en el nodo inicial es un error del paso y no crea la hija", async () => {
    const h = harness();
    h.work();
    h.save(child());
    h.save(parent({ stopBefore: "work", on: { done: "@done", blocked: "handled", failed: "@failed", error: "@failed" } }));

    const runId = h.start("parent");
    await h.finished(runId);

    expect(h.flows.getRun(runId).steps[0]).toMatchObject({ outcome: "error", error: expect.stringContaining("nodo inicial") });
    expect(h.childrenOf(runId)).toEqual([]);
  });

  test("las hijas de un forEach corren el mismo flujo sobre el mismo sujeto a la vez", async () => {
    const h = harness();
    const seen: unknown[] = [];
    h.work((args) => {
      seen.push(args.n);
      return { outcome: "ok" };
    });
    h.flows.registerConsolidator({ name: "flows", outcomes: ["ok"], run: (byBranch) => ({ outcome: "ok", output: byBranch }) });
    h.save(child());
    h.save({
      schema: 1,
      id: "bench",
      name: "Bench",
      trigger: { type: "manual" },
      params: { variants: { type: "list", default: [{ n: 1 }, { n: 2 }] } },
      start: "all",
      nodes: {
        all: {
          type: "parallel",
          branches: { forEach: "$run.params.variants", branch: { type: "flow", flow: "child", params: "$item" } },
          join: "flows",
          on: { ok: "@done" },
        },
      },
    });

    const runId = h.start("bench");
    await h.finished(runId);

    expect(h.flows.getRun(runId)).toMatchObject({ status: "done" });
    expect(h.childrenOf(runId)).toHaveLength(2);
    expect(seen.sort()).toEqual([1, 2]);
  });

  test("un subflujo de un perfil propio: el nodo puede pedir otro perfil y uno inexistente es error", async () => {
    const h = harness();
    h.work();
    h.save(child());
    h.save(parent({ profile: "ghost", on: { done: "@done", blocked: "handled", failed: "@failed", error: "@failed" } }));

    const runId = h.start("parent");
    await h.finished(runId);

    expect(h.flows.getRun(runId).steps[0]).toMatchObject({ outcome: "error", error: expect.stringContaining("ghost") });
  });
});

describe("start con subflujos", () => {
  test("rechaza un subflujo que no existe y un gate como rama de un parallel dentro del subflujo", async () => {
    const h = harness();
    h.work();
    h.save(child());
    h.save(parent());
    expect(() => h.start("parent")).not.toThrow();

    const gated = harness();
    gated.save(
      child({
        start: "both",
        nodes: {
          both: { type: "parallel", branches: ["work"], on: { ok: "@done", changes: "@blocked", fail: "@failed" } },
          work: { type: "gate", question: "?", options: [{ id: "go", label: "Seguir" }], timeoutSec: 60 },
        },
      }),
    );
    gated.save(parent());
    expect(() => gated.start("parent")).toThrow(/child\.work/);
  });

  test("la corrida fija la versión del subflujo: cambiarlo después no afecta a la que ya empezó", async () => {
    const h = harness();
    const ran: string[] = [];
    h.work(() => {
      ran.push("v1");
      return { outcome: "ok" };
    });
    h.action("other", ["ok"], () => {
      ran.push("v2");
      return { outcome: "ok" };
    });
    h.save(child());
    h.save(parent());

    const runId = h.start("parent");
    h.save(child({ nodes: { work: { type: "action", action: "other", args: {}, on: { ok: "@done" } } } }));
    await h.finished(runId);

    expect(ran).toEqual(["v1"]);
  });
});

describe("cancelar", () => {
  test("cancelar el padre cancela la hija, interrumpe su acción y no deja nada vivo", async () => {
    const h = harness();
    let started: () => void = () => {};
    const running = new Promise<void>((resolve) => (started = resolve));
    const aborted = vi.fn();
    h.action("work", ["ok", "stuck", "broken"], (_args, ctx) => {
      ctx.signal.addEventListener("abort", () => aborted(ctx.signal.reason), { once: true });
      started();
      return forever();
    });
    h.save(child());
    h.save(parent());

    const runId = h.start("parent");
    await running;
    const [kid] = h.childrenOf(runId);
    h.flows.control(runId, "cancel", "ui");

    expect(h.flows.getRun(runId)).toMatchObject({ status: "canceled", outcome: null });
    expect(h.flows.getRun(kid?.id as RunId)).toMatchObject({ status: "canceled", outcome: null });
    expect(h.flows.getRun(runId).steps.map((s) => s.status)).toEqual(["canceled"]);
    expect(h.flows.getRun(kid?.id as RunId).steps.map((s) => s.status)).toEqual(["canceled"]);
    expect(aborted).toHaveBeenCalledOnce();
    for (const id of [runId, kid?.id as RunId]) {
      const finished = h.store.events.since(0, { runId: id, types: ["run.finished"] });
      expect(finished.map((e) => e.payload)).toEqual([expect.objectContaining({ outcome: "canceled" })]);
    }
    // Ni el cierre tardío de la acción ni el dispatcher reviven nada.
    await vi.waitFor(() => expect(h.flows.getRun(runId).steps).toHaveLength(1), WAIT);
    expect(h.flows.getRun(kid?.id as RunId).steps).toHaveLength(1);
  });

  test("cancelar interrumpe al agente de la hija y su resultado tardío se descarta", async () => {
    let started: () => void = () => {};
    const running = new Promise<void>((resolve) => (started = resolve));
    const h = harness({
      script: () => {
        started();
        return forever();
      },
    });
    h.save(
      child({
        start: "implement",
        nodes: { implement: { type: "agent", role: "dev", mode: "implement", brief: {}, on: { ok: "@done", changes: "@failed" } } },
      }),
    );

    h.save(parent({}, { start: "sub", nodes: { sub: { type: "flow", flow: "child", params: {}, on: ends } } }));
    const runId = h.start("parent");
    await running;
    h.flows.control(runId, "cancel", "ui");

    const [kid] = h.childrenOf(runId);
    await vi.waitFor(() => expect(h.store.events.since(0, { runId: kid?.id, types: ["agent.ended"] })).toHaveLength(1), WAIT);
    expect(h.flows.getRun(kid?.id as RunId)).toMatchObject({ status: "canceled" });
    expect(h.flows.getRun(kid?.id as RunId).steps.map((s) => [s.status, s.attempt])).toEqual([["canceled", 1]]);
    expect(h.calls).toHaveLength(1);
  });

  test("cancelar solo a la hija cierra el paso del padre como failed", async () => {
    const h = harness();
    let started: () => void = () => {};
    const running = new Promise<void>((resolve) => (started = resolve));
    h.action("work", ["ok", "stuck", "broken"], () => {
      started();
      return forever();
    });
    h.save(child());
    h.save(parent());

    const runId = h.start("parent");
    await running;
    const [kid] = h.childrenOf(runId);
    h.flows.control(kid?.id as RunId, "cancel", "ui");
    await vi.waitFor(() => expect(h.flows.getRun(runId).status).toBe("failed"), WAIT);

    expect(h.flows.getRun(runId).steps[0]).toMatchObject({ nodeId: "sub", outcome: "failed", error: expect.stringContaining("se canceló") });
  });

  test("cancelar una corrida terminada no hace nada y una que no existe lanza", async () => {
    const h = harness();
    h.work();
    h.save(child());
    h.save(parent());
    const runId = h.start("parent");
    await h.finished(runId);

    h.flows.control(runId, "cancel", "ui");

    expect(h.flows.getRun(runId).status).toBe("done");
    expect(() => h.flows.control("run_nope" as RunId, "cancel", "ui")).toThrow(RunNotFoundError);
  });
});
