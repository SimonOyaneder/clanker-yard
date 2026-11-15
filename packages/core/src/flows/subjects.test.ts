import type { RunId, SubjectRef } from "@clanker/api";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { newId } from "../store/conventions";
import { runs } from "../store/schema";
import type { Tx } from "../store/store";
import { harness as createHarness } from "./harness";
import { claimPr } from "./subjects";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const ISSUE: SubjectRef = { type: "issue", id: "ENG-1" };
const PR: SubjectRef = { type: "pr", id: "pr_1" };

/** Una acción que no termina hasta que el test la suelta, y avisa cuándo empezó. */
function latch() {
  let release = () => {};
  const open = new Promise<void>((resolve) => (release = resolve));
  const state = { started: 0 };
  return { state, release, wait: () => ((state.started += 1), open) };
}

function harness(options: Parameters<typeof createHarness>[0] = {}) {
  const h = createHarness(options);
  cleanups.push(h.cleanup);
  const row = (runId: RunId) => h.store.db.select().from(runs).where(eq(runs.id, runId)).get()!;
  const events = (runId: RunId, type: string) => h.store.events.since(0, { runId, types: [type as "run.borrowed"] });
  const pendingDecision = (runId: RunId) => h.decisions.list({ runId, status: ["pending"] })[0];

  // Un flujo de dev que toma el PR como sujeto y se estaciona en un gate; uno de mantenimiento con un paso largo.
  const work = latch();
  // Se suelta antes de cerrar el motor, que espera a los pasos en curso.
  cleanups.push(() => work.release());
  h.action("claim", ["ok"], (_args, ctx) => {
    h.store.tx((tx) => claimPr(tx, ctx.runId, PR.id));
    return { outcome: "ok" };
  });
  h.action("after", ["ok"]);
  h.action("work", ["ok"], async () => {
    await work.wait();
    return { outcome: "ok" };
  });
  h.save({
    schema: 1,
    id: "dev-gated",
    name: "Dev con gate",
    trigger: { type: "manual" },
    start: "claim",
    nodes: {
      claim: { type: "action", action: "claim", args: {}, on: { ok: "ask" } },
      ask: { type: "gate", question: "¿Sigo?", options: [{ id: "go", label: "Seguir" }], on: { go: "after" } },
      after: { type: "action", action: "after", args: {}, on: { ok: "@done" } },
    },
  });
  h.save({
    schema: 1,
    id: "rebase",
    name: "Rebase",
    trigger: { type: "pr.conflict" },
    start: "work",
    nodes: { work: { type: "action", action: "work", args: {}, on: { ok: "@done" } } },
  });
  h.save({
    schema: 1,
    id: "council",
    name: "Council",
    trigger: { type: "pr.comment" },
    start: "work",
    nodes: { work: { type: "action", action: "work", args: {}, on: { ok: "@done" } } },
  });
  h.save({
    schema: 1,
    id: "dev-long",
    name: "Dev largo",
    trigger: { type: "manual" },
    start: "work",
    nodes: { work: { type: "action", action: "work", args: {}, on: { ok: "@done" } } },
  });
  return { ...h, row, events, pendingDecision, work };
}

/** Deja a `dev-gated` estacionada sobre `ISSUE`, dueña también de `PR`. */
async function parkedOwner(h: ReturnType<typeof harness>) {
  const owner = h.start("dev-gated", ISSUE);
  await h.finished(owner);
  expect(h.flows.getRun(owner).status).toBe("parked");
  return owner;
}

describe("una corrida dueña por sujeto", () => {
  test("dos corridas del mismo PR no corren a la vez: la segunda espera a la primera, no a un slot", async () => {
    const h = harness();
    const first = h.start("rebase", PR);
    await vi.waitFor(() => expect(h.work.state.started).toBe(1));

    const second = h.start("council", PR);
    expect(h.flows.getRun(second)).toMatchObject({ status: "queued" });
    // `start` ya despertó al dispatcher: si la hubiera tomado, el paso estaría en curso.
    expect(h.work.state.started).toBe(1);
    expect(h.flows.getRun(second).steps.every((s) => s.status === "pending")).toBe(true);

    h.work.release();
    await h.finished(second);
    expect(h.flows.getRun(first)).toMatchObject({ status: "done" });
    expect(h.flows.getRun(second)).toMatchObject({ status: "done", outcome: "done" });
    expect(h.store.events.since(0, { runId: second, types: ["run.status"] })[0]?.payload).toEqual({ from: "queued", to: "running" });
  });

  test("una corrida que no escribe o es hija no espera", () => {
    const h = harness();
    h.save({
      schema: 1,
      id: "local-only",
      name: "Local",
      trigger: { type: "manual" },
      effects: "local",
      start: "work",
      nodes: { work: { type: "action", action: "work", args: {}, on: { ok: "@done" } } },
    });
    h.start("dev-long", ISSUE);
    expect(h.flows.getRun(h.start("local-only", ISSUE)).status).toBe("running");
  });

  test("las corridas queued toman el sujeto en el orden en que llegaron", async () => {
    const h = harness();
    const first = h.start("dev-long", ISSUE);
    await vi.waitFor(() => expect(h.work.state.started).toBe(1));
    h.save({
      schema: 1,
      id: "other",
      name: "Otra",
      trigger: { type: "manual" },
      start: "work",
      nodes: { work: { type: "action", action: "work", args: {}, on: { ok: "@done" } } },
    });
    const second = h.start("other", ISSUE);
    const third = h.start("rebase", ISSUE);
    expect([second, third].map((id) => h.flows.getRun(id).status)).toEqual(["queued", "queued"]);

    h.work.release();
    await Promise.all([h.finished(second), h.finished(third)]);
    expect(h.flows.getRun(first).status).toBe("done");
    expect(h.flows.getRun(second).startedAt).toBeLessThanOrEqual(h.flows.getRun(third).startedAt);
    expect([second, third].map((id) => h.flows.getRun(id).status)).toEqual(["done", "done"]);
  });
});

describe("préstamo del sujeto", () => {
  test("mantenimiento toma prestado el PR de la corrida de dev estacionada, corre y se lo devuelve", async () => {
    const handovers: string[] = [];
    const handOverWorkspaces = (_tx: Tx, from: RunId, to: RunId) => void handovers.push(`${from}>${to}`);
    const h = harness({ handOverWorkspaces });
    const owner = await parkedOwner(h);

    const borrower = h.start("rebase", PR);
    expect(h.row(borrower)).toMatchObject({ status: "running", borrowedFromRunId: owner });
    expect(h.flows.getRun(borrower).borrowedFromRunId).toBe(owner);
    expect(h.flows.listRuns().find((run) => run.id === owner)?.borrowedFromRunId).toBeNull();
    expect(h.events(borrower, "run.borrowed")[0]?.payload).toEqual({ runId: borrower, fromRunId: owner });
    expect(handovers).toEqual([`${owner}>${borrower}`]);

    h.work.release();
    await h.finished(borrower);
    expect(h.flows.getRun(borrower)).toMatchObject({ status: "done", outcome: "done" });
    expect(h.events(borrower, "run.returned")[0]?.payload).toEqual({ runId: borrower, fromRunId: owner });
    expect(handovers).toEqual([`${owner}>${borrower}`, `${borrower}>${owner}`]);
    // Los eventos de devolución van antes del fin: el worktree no se suelta con la corrida que lo devuelve.
    const seq = (type: string) => h.store.events.since(0, { runId: borrower, types: [type as "run.returned"] })[0]?.seq ?? 0;
    expect(seq("run.returned")).toBeLessThan(seq("run.finished"));
    // La dueña sigue donde estaba: parked con su decisión abierta, y nada la esperó.
    expect(h.flows.getRun(owner)).toMatchObject({ status: "parked", parkReason: "gate" });
    expect(h.pendingDecision(owner)).toBeDefined();
    expect(h.events(owner, "run.requeued")).toEqual([]);
  });

  test("un solo préstamo a la vez: la segunda corrida de mantenimiento espera la devolución y lo pide después", async () => {
    const h = harness();
    const owner = await parkedOwner(h);

    const first = h.start("rebase", PR);
    const second = h.start("council", PR);
    expect(h.row(first).borrowedFromRunId).toBe(owner);
    expect(h.row(second)).toMatchObject({ status: "queued", borrowedFromRunId: null });

    h.work.release();
    await h.finished(second);
    expect(h.flows.getRun(first).status).toBe("done");
    expect(h.row(second).borrowedFromRunId).toBe(owner);
    expect(h.flows.getRun(second)).toMatchObject({ status: "done" });
  });

  test("una corrida de dev no toma prestado: espera a la dueña estacionada", async () => {
    const h = harness();
    await parkedOwner(h);
    const dev = h.start("dev-long", PR);
    expect(h.flows.getRun(dev).status).toBe("queued");
  });

  test("si la dueña no está estacionada o es de mantenimiento, no hay préstamo", async () => {
    const h = harness();
    const owner = h.start("rebase", PR);
    await vi.waitFor(() => expect(h.work.state.started).toBe(1));
    const waiting = h.start("council", PR);
    expect(h.flows.getRun(waiting).status).toBe("queued");
    expect(h.row(owner).borrowedFromRunId).toBeNull();
  });

  test("una corrida en cola toma el sujeto prestado cuando la dueña se estaciona", async () => {
    const h = harness();
    const gate = latch();
    h.action("hold", ["ok"], async (_args, ctx) => {
      h.store.tx((tx) => claimPr(tx, ctx.runId, PR.id));
      await gate.wait();
      return { outcome: "ok" };
    });
    h.save({
      schema: 1,
      id: "dev-late-gate",
      name: "Dev que se estaciona tarde",
      trigger: { type: "manual" },
      start: "hold",
      nodes: {
        hold: { type: "action", action: "hold", args: {}, on: { ok: "ask" } },
        ask: { type: "gate", question: "¿Sigo?", options: [{ id: "go", label: "Seguir" }], on: { go: "@done" } },
      },
    });
    const owner = h.start("dev-late-gate", ISSUE);
    await vi.waitFor(() => expect(gate.state.started).toBe(1));
    const waiting = h.start("rebase", PR);
    expect(h.flows.getRun(waiting).status).toBe("queued");

    gate.release();
    await vi.waitFor(() => expect(h.row(waiting)).toMatchObject({ status: "running", borrowedFromRunId: owner }));
    h.work.release();
    await h.finished(waiting);
    expect(h.flows.getRun(owner).status).toBe("parked");
  });

  test("una decisión resuelta durante el préstamo espera la devolución", async () => {
    const h = harness();
    const owner = await parkedOwner(h);
    const borrower = h.start("rebase", PR);
    await vi.waitFor(() => expect(h.work.state.started).toBe(1));

    const decision = h.pendingDecision(owner);
    h.flows.resolveGate(decision!.id, "go", "ui");
    expect(h.decisions.get(decision!.id)).toMatchObject({ status: "answered" });
    // El sujeto sigue prestado: la dueña no corre ni se reencola, y su siguiente paso espera.
    expect(h.flows.getRun(owner).status).toBe("parked");
    expect(h.events(owner, "run.requeued")).toEqual([]);
    expect(h.flows.getRun(owner).steps.map((s) => [s.nodeId, s.status])).toEqual([
      ["claim", "done"],
      ["ask", "done"],
      ["after", "pending"],
    ]);

    h.work.release();
    await vi.waitFor(() => expect(h.flows.getRun(owner)).toMatchObject({ status: "done", outcome: "done" }));
    expect(h.flows.getRun(borrower).status).toBe("done");
    expect(h.events(owner, "run.requeued")[0]?.payload).toEqual({ decisionId: decision!.id, reason: "gate" });
    // Primero vuelve el sujeto, después la dueña sigue.
    const order = h.store.events
      .since(0, { types: ["run.returned", "run.requeued", "run.finished"] })
      .map((e) => `${e.type}:${e.runId === owner ? "owner" : "borrower"}`);
    expect(order).toEqual(["run.returned:borrower", "run.requeued:owner", "run.finished:borrower", "run.finished:owner"]);
  });

  test("si la dueña se cancela durante el préstamo, quien lo tiene pasa a ser la dueña", async () => {
    const h = harness();
    const owner = await parkedOwner(h);
    const borrower = h.start("rebase", PR);
    await vi.waitFor(() => expect(h.work.state.started).toBe(1));

    h.flows.control(owner, "cancel", { by: "ui" });
    expect(h.row(borrower)).toMatchObject({ status: "running", borrowedFromRunId: null });
    // Ya es la dueña: una corrida nueva sobre el PR espera, no pide prestado.
    expect(h.flows.getRun(h.start("council", PR)).status).toBe("queued");
    h.work.release();
    await h.finished(borrower);
    expect(h.events(borrower, "run.returned")).toEqual([]);
  });

  test("cancelar a quien tiene el préstamo se lo devuelve a la dueña, que sigue estacionada", async () => {
    const h = harness();
    const owner = await parkedOwner(h);
    const borrower = h.start("rebase", PR);
    await vi.waitFor(() => expect(h.work.state.started).toBe(1));

    h.flows.control(borrower, "cancel", { by: "ui" });
    expect(h.events(borrower, "run.returned")).toHaveLength(1);
    expect(h.flows.getRun(owner).status).toBe("parked");
    expect(h.pendingDecision(owner)).toBeDefined();
  });

  test("el índice rechaza dos dueñas sobre el mismo sujeto y dos préstamos de la misma dueña", () => {
    const h = harness();
    const owner = h.row(h.start("dev-long", ISSUE));
    // Otro flujo, para que solo falle el índice de dueña y no el de (flujo, sujeto).
    const { flowDefId, flowVersion } = h.row(h.start("council", { type: "issue", id: "OTHER" }));
    const insert = (values: Partial<typeof owner>) =>
      h.store.tx((tx) =>
        tx.db.insert(runs).values({ ...owner, id: newId("run"), flowDefId, flowVersion, ...values }).run(),
      );
    const rejection = (values: Partial<typeof owner>) => {
      try {
        insert(values);
      } catch (error) {
        return String((error as Error).cause);
      }
      return undefined;
    };
    expect(rejection({ status: "running" })).toMatch(/UNIQUE constraint failed/);
    expect(rejection({ status: "queued" })).toBeUndefined();
    expect(rejection({ status: "running", borrowedFromRunId: owner.id, subjectId: "x" })).toBeUndefined();
    expect(rejection({ status: "running", borrowedFromRunId: owner.id, subjectId: "y" })).toMatch(/UNIQUE constraint failed/);
  });
});

describe("el worktree y su token", () => {
  test("un `$ws` lleva el token vigente del worktree, no el que tenía al tomarlo", async () => {
    let token = 1;
    const h = harness({ workspaceOf: () => ({ path: "/work/tree", base: "main", workspaceId: "ws_1", fencingToken: token }) });
    const seen: unknown[] = [];
    h.action("acquire", ["ok"], () => ({ outcome: "ok", output: { workspaceId: "ws_1", path: "/work/tree", fencingToken: 1 } }));
    h.action("use", ["ok"], (args) => {
      seen.push(args.ws);
      return { outcome: "ok" };
    });
    h.save({
      schema: 1,
      id: "uses-ws",
      name: "Usa el worktree",
      trigger: { type: "manual" },
      start: "ws",
      nodes: {
        ws: { type: "action", action: "acquire", args: {}, on: { ok: "use" } },
        use: { type: "action", action: "use", args: { ws: "$ws" }, on: { ok: "@done" } },
      },
    });
    token = 3;
    await h.finished(h.start("uses-ws", ISSUE));
    expect(seen).toEqual([{ workspaceId: "ws_1", path: "/work/tree", fencingToken: 3 }]);
  });
});
