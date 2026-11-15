import type { ProjectId, RunId } from "@clanker/api";
import { afterEach, describe, expect, test, vi } from "vitest";
import { projects } from "../store/schema";
import { DecisionResolveError } from "./engine";
import { harness as createHarness, okReport, subjectOf, type AgentScript } from "./harness";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function harness(options: Parameters<typeof createHarness>[0] = {}) {
  const h = createHarness(options);
  cleanups.push(h.cleanup);
  h.action("work", ["ok"]);
  h.action("after", ["ok"]);

  const project = "prj_01J00000000000000000000000" as ProjectId;
  // Un reinicio (`reopen`) parte de la base ya sembrada.
  if (!options.reopen) {
    h.store.tx((tx) => {
      tx.db.insert(projects).values({ id: project, slug: "p", name: "P", tracker: "local", trackerRef: "p", flowParams: {} }).run();
    });
  }
  const startIn = (flow: string, subject: string) =>
    h.flows.start(flow, { type: "issue", id: subject }, undefined, { profile: "default", projectId: project });
  const decisionsOf = (runId: RunId) => h.decisions.list({ runId });
  const pending = (runId: RunId) => h.decisions.list({ runId, status: ["pending"] });
  const stepStatuses = (runId: RunId) => h.flows.getRun(runId).steps.map((s) => [s.nodeId, s.status, s.outcome]);
  const eventsOf = (runId: RunId, type: string) => h.store.events.since(0, { runId, types: [type as "run.parked"] });
  return { ...h, project, startIn, decisionsOf, pending, stepStatuses, eventsOf };
}

const GO_STOP = [
  { id: "go", label: "Seguir" },
  { id: "stop", label: "Parar" },
];

const gated = {
  schema: 1,
  id: "gated",
  name: "Con gate",
  trigger: { type: "manual" },
  start: "prep",
  nodes: {
    prep: { type: "action", action: "work", args: {}, on: { ok: "ask" } },
    ask: { type: "gate", question: "¿Sigo con $run.subject.id?", options: GO_STOP, on: { go: "after", stop: "@blocked" } },
    after: { type: "action", action: "after", args: {}, on: { ok: "@done" } },
  },
};

const plain = {
  schema: 1,
  id: "plain",
  name: "Simple",
  trigger: { type: "manual" },
  start: "work",
  nodes: { work: { type: "action", action: "work", args: {}, on: { ok: "@done" } } },
};

describe("gate", () => {
  test("estaciona solo su corrida: otra del mismo proyecto sigue y el proyecto no se pausa", async () => {
    const h = harness();
    h.save(gated);
    h.save(plain);

    const parked = h.startIn("gated", "ENG-1");
    const other = h.startIn("plain", "ENG-2");
    await Promise.all([h.finished(parked), h.finished(other)]);

    expect(h.flows.getRun(other)).toMatchObject({ status: "done", outcome: "done" });
    expect(h.flows.getRun(parked)).toMatchObject({ status: "parked", parkReason: "gate", endedAt: null });
    expect(h.stepStatuses(parked)).toEqual([
      ["prep", "done", "ok"],
      ["ask", "waiting", null],
    ]);
    const [decision] = h.pending(parked);
    expect(decision).toMatchObject({
      kind: "gate",
      status: "pending",
      title: "¿Sigo con $run.subject.id?",
      options: ["go", "stop"],
      projectId: h.project,
      stepRunId: h.flows.getRun(parked).steps[1]?.id,
    });
    expect(h.eventsOf(parked, "run.parked")[0]?.payload).toEqual({ reason: "gate", decisionId: decision?.id });
    expect(h.store.db.select().from(projects).all()[0]?.status).toBe("active");
  });

  test("resolveGate sigue el edge de la opción, cierra la decisión y reencola la corrida", async () => {
    const h = harness();
    h.save(gated);

    const runId = h.startIn("gated", "ENG-1");
    await h.finished(runId);
    const [decision] = h.pending(runId);
    h.flows.resolveGate(decision?.id as never, "go", "ui");
    await vi.waitFor(() => expect(h.flows.getRun(runId).status).toBe("done"));

    expect(h.stepStatuses(runId)).toEqual([
      ["prep", "done", "ok"],
      ["ask", "done", "go"],
      ["after", "done", "ok"],
    ]);
    expect(h.decisions.get(decision?.id as never)).toMatchObject({ status: "answered", resolution: { option: "go" }, resolvedBy: "ui" });
    expect(h.eventsOf(runId, "run.requeued")[0]?.payload).toEqual({ decisionId: decision?.id, reason: "gate" });
    expect(h.eventsOf(runId, "decision.resolved")).toHaveLength(1);
  });

  test("una opción que termina el flujo no reencola la corrida", async () => {
    const h = harness();
    h.save(gated);

    const runId = h.startIn("gated", "ENG-1");
    await h.finished(runId);
    h.flows.resolveGate(h.pending(runId)[0]?.id as never, "stop", "cli");

    expect(h.flows.getRun(runId)).toMatchObject({ status: "failed", outcome: "blocked", parkReason: null });
    expect(h.eventsOf(runId, "run.requeued")).toEqual([]);
  });

  test("la corrida resuelta va antes que las nuevas cuando hay que esperar un cupo de agente", async () => {
    const releases = new Map<string, () => void>();
    const script: AgentScript = (call) =>
      subjectOf(call.prompt) === "ENG-2"
        ? new Promise((resolve) => releases.set("ENG-2", () => resolve(okReport())))
        : Promise.resolve(okReport());
    const h = harness({ maxAgents: 1, script });
    h.save({
      ...gated,
      nodes: {
        ...gated.nodes,
        after: { type: "agent", role: "dev", mode: "plan", brief: { issue: "$run.subject" }, on: { ok: "@done", changes: "@blocked" } },
      },
    });
    h.save({
      ...plain,
      id: "agent-only",
      nodes: { work: { type: "agent", role: "dev", mode: "plan", brief: { issue: "$run.subject" }, on: { ok: "@done", changes: "@blocked" } } },
    });

    const old = h.startIn("gated", "ENG-1");
    await h.finished(old);
    const holder = h.startIn("agent-only", "ENG-2");
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    const fresh = h.startIn("agent-only", "ENG-3");
    h.flows.resolveGate(h.pending(old)[0]?.id as never, "go", "ui");
    expect(h.calls).toHaveLength(1);

    releases.get("ENG-2")?.();
    await vi.waitFor(() => expect(h.flows.getRun(fresh).status).toBe("done"));

    expect(h.calls.map((c) => c.subject)).toEqual(["ENG-2", "ENG-1", "ENG-3"]);
    expect(h.flows.getRun(old).status).toBe("done");
    expect(h.flows.getRun(holder).status).toBe("done");
  });

  test("con timeoutSec y default sigue solo con la opción por defecto", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.save({ ...gated, nodes: { ...gated.nodes, ask: { ...gated.nodes.ask, timeoutSec: 30, default: "go" } } });

    const runId = h.startIn("gated", "ENG-1");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.flows.getRun(runId).status).toBe("parked");
    await vi.advanceTimersByTimeAsync(15_000);

    expect(h.flows.getRun(runId)).toMatchObject({ status: "done", outcome: "done" });
    expect(h.decisionsOf(runId)[0]).toMatchObject({ status: "expired", resolution: { option: "go" }, resolvedBy: "timeout" });
  });

  test("con timeoutSec y sin default el vencimiento es el outcome timeout, que sin edge estaciona por needs_human", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.save({ ...gated, nodes: { ...gated.nodes, ask: { ...gated.nodes.ask, timeoutSec: 30 } } });

    const runId = h.startIn("gated", "ENG-1");
    await vi.advanceTimersByTimeAsync(40_000);

    expect(h.flows.getRun(runId)).toMatchObject({ status: "parked", parkReason: "needs_human" });
    expect(h.decisionsOf(runId).map((d) => [d.kind, d.status])).toEqual([
      ["needs_human", "pending"],
      ["gate", "expired"],
    ]);
  });

  test("tras un reinicio la corrida sigue estacionada con su decisión abierta", async () => {
    const first = harness({ persist: true, bootId: "boot-1" });
    first.save(gated);
    const runId = first.startIn("gated", "ENG-1");
    await first.finished(runId);
    await first.crash();

    const second = harness({ reopen: first.home, bootId: "boot-2" });
    second.flows.recover();

    expect(second.flows.getRun(runId)).toMatchObject({ status: "parked", parkReason: "gate" });
    expect(second.pending(runId)).toHaveLength(1);
  });

  test("resolver con una opción que no es suya, o dos veces, no cambia nada", async () => {
    const h = harness();
    h.save(gated);

    const runId = h.startIn("gated", "ENG-1");
    await h.finished(runId);
    const id = h.pending(runId)[0]?.id as never;

    expect(() => h.flows.resolveGate(id, "retry", "ui")).toThrow(/no es una opción.*go, stop/);
    expect(h.flows.getRun(runId).status).toBe("parked");
    h.flows.resolveGate(id, "stop", "ui");
    expect(() => h.flows.resolveGate(id, "go", "ui")).toThrow(DecisionResolveError);
    expect(() => h.flows.resolveGate("dec_nope" as never, "go", "ui")).toThrow(/No existe la decisión/);
  });

  test("cancelar una corrida estacionada deja su decisión superseded", async () => {
    const h = harness();
    h.save(gated);

    const runId = h.startIn("gated", "ENG-1");
    await h.finished(runId);
    h.flows.control(runId, "cancel", { by: "ui" });

    expect(h.flows.getRun(runId)).toMatchObject({ status: "canceled", parkReason: null });
    expect(h.stepStatuses(runId)[1]).toEqual(["ask", "canceled", null]);
    expect(h.decisionsOf(runId)[0]).toMatchObject({ status: "superseded", resolvedBy: "ui" });
  });

  test("un gate en un subflujo estaciona la hija y el padre espera", async () => {
    const h = harness();
    h.save({ ...gated, id: "child", trigger: { type: "subflow" } });
    h.save({
      schema: 1,
      id: "parent",
      name: "Padre",
      trigger: { type: "manual" },
      start: "sub",
      nodes: { sub: { type: "flow", flow: "child", params: {}, on: { done: "@done", blocked: "@blocked", failed: "@failed" } } },
    });

    const parent = h.startIn("parent", "ENG-1");
    await vi.waitFor(() => expect(h.flows.listRuns().some((r) => r.parentRunId === parent && r.status === "parked")).toBe(true));
    const child = h.flows.listRuns().find((r) => r.parentRunId === parent);
    h.flows.resolveGate(h.pending(child?.id as RunId)[0]?.id as never, "go", "ui");

    await vi.waitFor(() => expect(h.flows.getRun(parent)).toMatchObject({ status: "done", outcome: "done" }));
  });
});

describe("paso con error sin edge", () => {
  const planner = (extra: Record<string, unknown> = {}) => ({
    schema: 1,
    id: "planner",
    name: "Planner",
    trigger: { type: "manual" },
    start: "plan",
    nodes: {
      plan: {
        type: "agent",
        role: "dev",
        mode: "plan",
        brief: { issue: "$run.subject" },
        retry: { max: 1, backoffSec: [0] },
        on: { ok: "@done", changes: "after" },
        ...extra,
      },
      after: { type: "action", action: "after", args: {}, on: { ok: "@done" } },
    },
  });
  const failing: AgentScript = () => Promise.resolve({ status: "error", message: "se cayó" });

  test("un reintento y después parked needs_human con una decisión que ofrece reintentar, forzar y cancelar", async () => {
    const h = harness({ script: failing });
    h.save(planner());

    const runId = h.startIn("planner", "ENG-1");
    await h.finished(runId);

    expect(h.calls).toHaveLength(2);
    expect(h.flows.getRun(runId)).toMatchObject({ status: "parked", parkReason: "needs_human" });
    const [decision] = h.pending(runId);
    expect(decision).toMatchObject({
      kind: "needs_human",
      title: 'El paso "plan" no puede seguir',
      body: "se cayó",
      options: ["retry", "force:ok", "force:changes", "cancel"],
      stepRunId: h.flows.getRun(runId).steps[0]?.id,
    });
    expect(h.eventsOf(runId, "run.parked")[0]?.payload).toEqual({ reason: "needs_human", decisionId: decision?.id });
  });

  test("retry vuelve a correr el nodo como una visita nueva", async () => {
    let broken = true;
    const h = harness({ script: () => Promise.resolve(broken ? { status: "error" as const, message: "se cayó" } : okReport()) });
    h.save(planner());

    const runId = h.startIn("planner", "ENG-1");
    await h.finished(runId);
    broken = false;
    h.flows.resolveGate(h.pending(runId)[0]?.id as never, "retry", "ui");
    await vi.waitFor(() => expect(h.flows.getRun(runId).status).toBe("done"));

    expect(h.flows.getRun(runId).steps.map((s) => [s.nodeId, s.visit, s.status])).toEqual([
      ["plan", 1, "failed"],
      ["plan", 2, "done"],
    ]);
    expect(h.eventsOf(runId, "run.requeued")[0]?.payload).toMatchObject({ reason: "needs_human" });
  });

  test("force:<outcome> sigue el edge de ese outcome sin ejecutar el paso", async () => {
    const h = harness({ script: failing });
    h.save(planner());

    const runId = h.startIn("planner", "ENG-1");
    await h.finished(runId);
    h.flows.resolveGate(h.pending(runId)[0]?.id as never, "force:changes", "mcp");
    await vi.waitFor(() => expect(h.flows.getRun(runId).status).toBe("done"));

    expect(h.calls).toHaveLength(2);
    expect(h.flows.getRun(runId).steps.map((s) => [s.nodeId, s.status])).toEqual([
      ["plan", "failed"],
      ["after", "done"],
    ]);
    expect(h.decisionsOf(runId)[0]).toMatchObject({ status: "answered", resolution: { option: "force:changes" }, resolvedBy: "mcp" });
  });

  test("cancel termina la corrida y deja la decisión respondida", async () => {
    const h = harness({ script: failing });
    h.save(planner());

    const runId = h.startIn("planner", "ENG-1");
    await h.finished(runId);
    h.flows.resolveGate(h.pending(runId)[0]?.id as never, "cancel", "ui");

    expect(h.flows.getRun(runId)).toMatchObject({ status: "canceled", parkReason: null });
    expect(h.decisionsOf(runId)[0]).toMatchObject({ status: "answered", resolution: { option: "cancel" } });
  });

  test("un paso que no se puede cargar ofrece solo reintentar o cancelar", async () => {
    vi.useFakeTimers();
    const h = harness();
    let calls = 0;
    h.action("flaky", ["ok"], () => {
      if (++calls === 1) throw new Error("timeout de red");
      return { outcome: "ok" };
    });
    h.save({ ...plain, id: "flaky", nodes: { work: { type: "action", action: "flaky", args: {}, on: { ok: "@done" } } } });

    const runId = h.startIn("flaky", "ENG-1");
    await vi.advanceTimersByTimeAsync(0);
    h.store.db.$client.exec(`UPDATE step_runs SET node_id = 'gone' WHERE run_id = '${runId}'`);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(h.flows.getRun(runId)).toMatchObject({ status: "parked", parkReason: "needs_human" });
    expect(h.pending(runId)[0]).toMatchObject({ options: ["retry", "cancel"], body: expect.stringContaining("gone") });
  });
});

describe("escalar al pasarse del tope del paso", () => {
  const escalating = {
    schema: 1,
    id: "escalating",
    name: "Escala",
    trigger: { type: "manual" },
    start: "implement",
    nodes: {
      implement: {
        type: "agent",
        role: "dev",
        mode: "implement",
        brief: { issue: "$run.subject" },
        escalate: { counter: "review", from: 2, profileRole: "dev-escala" },
        on: { ok: "@done", changes: "@blocked" },
      },
    },
  };
  const profiles = (h: ReturnType<typeof harness>) =>
    h.defs.save({
      kind: "profile",
      slug: "default",
      scope: "user",
      body: { roles: { dev: { model: "sonnet" }, "dev-escala": { model: "opus" } } },
      source: "ui",
    });

  test("un reintento con dev-escala, una sesión nueva y un handoff", async () => {
    const h = harness({
      script: (call) =>
        Promise.resolve(call.spec?.model === "opus" ? okReport() : { status: "error_max_budget_usd", message: "te pasaste de USD 5" }),
    });
    profiles(h);
    h.save(escalating);

    const runId = h.startIn("escalating", "ENG-1");
    await vi.waitFor(() => expect(h.flows.getRun(runId).status).toBe("done"));

    expect(h.calls.map((c) => [c.kind, c.spec?.model])).toEqual([
      ["start", "sonnet"],
      ["start", "opus"],
    ]);
    expect(h.calls[1]?.prompt).toContain("se pasó de su tope de gasto o de turnos");
    expect(h.flows.getRun(runId).steps[0]).toMatchObject({ status: "done", outcome: "ok", attempt: 2 });
  });

  test("si vuelve a pasarse la corrida queda parked con needs_human", async () => {
    const h = harness({ script: () => Promise.resolve({ status: "error_max_turns", message: "se acabaron los turnos" }) });
    profiles(h);
    h.save(escalating);

    const runId = h.startIn("escalating", "ENG-1");
    await h.finished(runId);

    expect(h.calls.map((c) => c.spec?.model)).toEqual(["sonnet", "opus"]);
    expect(h.flows.getRun(runId)).toMatchObject({ status: "parked", parkReason: "needs_human" });
    expect(h.pending(runId)[0]).toMatchObject({ kind: "needs_human", body: "se acabaron los turnos" });
  });

  test("un nodo sin escalate no reintenta: el tope es un error", async () => {
    const h = harness({ script: () => Promise.resolve({ status: "error_max_turns", message: "se acabaron los turnos" }) });
    h.save({ ...escalating, nodes: { implement: { ...escalating.nodes.implement, escalate: undefined } } });

    const runId = h.startIn("escalating", "ENG-1");
    await h.finished(runId);

    expect(h.calls).toHaveLength(1);
    expect(h.flows.getRun(runId)).toMatchObject({ status: "parked", parkReason: "needs_human" });
  });
});

describe("tope de la corrida", () => {
  const chain = (limits: Record<string, unknown>, nodes = 3) => ({
    schema: 1,
    id: "chain",
    name: "Cadena",
    trigger: { type: "manual" },
    limits,
    start: "s1",
    nodes: Object.fromEntries(
      Array.from({ length: nodes }, (_, i) => [
        `s${i + 1}`,
        { type: "agent", role: "dev", mode: "plan", brief: { issue: "$run.subject" }, on: { ok: i + 1 === nodes ? "@done" : `s${i + 2}`, changes: "@blocked" } },
      ]),
    ),
  });

  test("el tope de gasto estaciona solo esa corrida: el proyecto no se pausa y otra corrida sigue", async () => {
    const h = harness();
    h.save(chain({ maxCostUsd: 0.0004 }));
    h.save(plain);

    const capped = h.startIn("chain", "ENG-1");
    const other = h.startIn("plain", "ENG-2");
    await Promise.all([h.finished(capped), h.finished(other)]);

    expect(h.flows.getRun(other).status).toBe("done");
    expect(h.flows.getRun(capped)).toMatchObject({ status: "parked", parkReason: "limit", costMicros: 500 });
    expect(h.stepStatuses(capped)).toEqual([
      ["s1", "done", "ok"],
      ["s2", "pending", null],
    ]);
    expect(h.pending(capped)[0]).toMatchObject({ kind: "needs_human", options: ["continue", "cancel"], stepRunId: h.flows.getRun(capped).steps[1]?.id });
    expect(h.store.db.select().from(projects).all()[0]?.status).toBe("active");
  });

  test("continue le suma otra vez el tope y el paso pendiente corre", async () => {
    const h = harness();
    h.save(chain({ maxCostUsd: 0.0004 }));

    const runId = h.startIn("chain", "ENG-1");
    await h.finished(runId);
    h.flows.resolveGate(h.pending(runId)[0]?.id as never, "continue", "ui");
    await vi.waitFor(() => expect(h.decisionsOf(runId)).toHaveLength(2));

    // Con 2 × USD 0,0004 caben dos pasos de 500 micros: el tercero vuelve a estacionar.
    expect(h.flows.getRun(runId)).toMatchObject({ status: "parked", parkReason: "limit", costMicros: 1000 });
    h.flows.resolveGate(h.pending(runId)[0]?.id as never, "continue", "ui");
    await vi.waitFor(() => expect(h.flows.getRun(runId).status).toBe("done"));
    expect(h.eventsOf(runId, "run.requeued")).toHaveLength(2);
  });

  test("maxSteps estaciona antes del paso que lo pasaría", async () => {
    const h = harness();
    h.save(chain({ maxSteps: 2 }));

    const runId = h.startIn("chain", "ENG-1");
    await h.finished(runId);

    expect(h.flows.getRun(runId)).toMatchObject({ status: "parked", parkReason: "limit" });
    expect(h.stepStatuses(runId).map(([node, status]) => `${node}:${status}`)).toEqual(["s1:done", "s2:done", "s3:pending"]);
    expect(h.pending(runId)[0]?.body).toContain("Lleva 2 pasos y su tope es 2");
  });

  test("cancel desde la decisión del tope termina la corrida", async () => {
    const h = harness();
    h.save(chain({ maxSteps: 1 }));

    const runId = h.startIn("chain", "ENG-1");
    await h.finished(runId);
    h.flows.resolveGate(h.pending(runId)[0]?.id as never, "cancel", "ui");

    expect(h.flows.getRun(runId)).toMatchObject({ status: "canceled" });
    expect(h.stepStatuses(runId)[1]).toEqual(["s2", "canceled", null]);
  });

  test("el tope de gasto del proyecto manda sobre el del flujo", async () => {
    const h = harness();
    h.store.tx((tx) => tx.db.update(projects).set({ maxCostUsd: 0.0004 }).run());
    h.save(chain({ maxCostUsd: 100 }));

    const runId = h.startIn("chain", "ENG-1");
    await h.finished(runId);

    expect(h.flows.getRun(runId)).toMatchObject({ status: "parked", parkReason: "limit" });
  });

  test("sin tope no se estaciona nunca", async () => {
    const h = harness();
    h.save(chain({}));

    const runId = h.startIn("chain", "ENG-1");
    await vi.waitFor(() => expect(h.flows.getRun(runId).status).toBe("done"));
  });
});
