import { type ProjectId, type RunId, type Profile } from "@clanker/api";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentScript } from "../flows/harness";
import { devRole, harness as createHarness, okReport } from "../flows/harness";
import { newId } from "../store/conventions";
import { runMetrics, runRoleCosts, runs } from "../store/schema";
import { createMetrics } from "./metrics";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Un equipo de dos roles con modelos distintos y un flujo con rondas: dev, review y vuelta a dev hasta que review aprueba. */
function team(script: AgentScript, options: { resumeKeepsSession?: boolean } = {}) {
  const h = createHarness({ script, roles: { reviewer: devRole("Eres review.") }, ...options });
  cleanups.push(h.cleanup);
  const profile: Profile = { roles: { dev: { model: "opus", effort: "high" }, reviewer: { model: "sonnet" } } };
  h.defs.save({ kind: "profile", slug: "default", scope: "user", body: profile, source: "ui" });
  h.save({
    schema: 1,
    id: "loop",
    name: "Loop",
    trigger: { type: "manual" },
    start: "implement",
    nodes: {
      implement: { type: "agent", role: "dev", mode: "plan", brief: {}, on: { ok: "review", changes: "@blocked" } },
      review: {
        type: "agent",
        role: "reviewer",
        mode: "plan",
        brief: {},
        on: { ok: "@done", changes: { to: "fix", counter: "review", maxRounds: 3, exhausted: "@failed" } },
      },
      fix: { type: "agent", role: "dev", mode: "plan", brief: {}, on: { ok: "review", changes: "@blocked" } },
    },
  });
  const metrics = createMetrics(h.store);
  const startIn = async (projectId: ProjectId, subject: string) => {
    const runId = h.flows.start("loop", { type: "issue", id: subject }, {}, { profile: "default", projectId });
    await h.finished(runId);
    return runId;
  };
  const closeAt = (runId: RunId, endedAt: number) =>
    h.store.tx((tx) => tx.db.update(runs).set({ endedAt }).where(eq(runs.id, runId)).run());
  return { ...h, metrics, startIn, closeAt };
}

/** Cada llamada gasta lo que dice `costs` (en orden) con 1 token de entrada y 2 de salida; review pide cambios la primera vez. */
function scripted(costs: number[], reviewOutcomes: string[] = ["ok"]): AgentScript {
  const outcomes = [...reviewOutcomes];
  return async (call) => {
    const isReview = call.spec?.role === "reviewer";
    return {
      ...okReport({ n: 1 }, isReview ? (outcomes.shift() ?? "ok") : "ok"),
      usage: { turns: 1, tokensIn: 1, tokensOut: 2, tokensCacheRead: 0, tokensCacheWrite: 0, costMicros: costs.shift() ?? 0, costSource: "runtime" },
    };
  };
}

const projectA = newId("prj");
const projectB = newId("prj");

describe("al cerrar la corrida", () => {
  test("guarda resultado, rondas, outcomes por nodo y costo por rol", async () => {
    const h = team(scripted([100, 200, 300, 400], ["changes", "ok"]));

    const runId = await h.startIn(projectA, "ENG-1");

    const metrics = h.store.db.select().from(runMetrics).where(eq(runMetrics.runId, runId)).get();
    expect(metrics).toMatchObject({
      result: "done",
      rounds: { review: 1 },
      outcomes: { implement: { ok: 1 }, review: { changes: 1, ok: 1 }, fix: { ok: 1 } },
      costMicros: 1000,
    });
    const run = h.flows.getRun(runId);
    expect(metrics?.minutes).toBe(((run.endedAt ?? 0) - run.startedAt) / 60_000);
    expect(metrics?.costMicros).toBe(run.costMicros);
    expect(h.store.db.select().from(runRoleCosts).where(eq(runRoleCosts.runId, runId)).orderBy(runRoleCosts.role).all()).toEqual([
      { runId, role: "dev", model: "opus", effort: "high", tokens: 6, costMicros: 400 },
      { runId, role: "reviewer", model: "sonnet", effort: null, tokens: 6, costMicros: 600 },
    ]);
  });

  test("el costo de un resume con el mismo id de sesión cuenta en el paso que lo pidió y en la corrida", async () => {
    const h = team(scripted([100, 40]), { resumeKeepsSession: true });
    h.save({
      schema: 1,
      id: "resumed",
      name: "Retomado",
      trigger: { type: "manual" },
      start: "plan",
      nodes: {
        plan: { type: "agent", role: "dev", mode: "plan", brief: {}, on: { ok: "implement", changes: "@failed" } },
        implement: { type: "agent", role: "dev", mode: "implement", resumeFrom: "plan", brief: {}, on: { ok: "@done", changes: "@failed" } },
      },
    });

    const runId = h.flows.start("resumed", { type: "issue", id: "ENG-1" }, {}, { profile: "default", projectId: projectA });
    await h.finished(runId);

    expect(h.calls.map((c) => c.kind)).toEqual(["start", "resume"]);
    const run = h.flows.getRun(runId);
    expect(run.steps.map((s) => s.costMicros)).toEqual([100, 40]);
    expect(run.costMicros).toBe(140);
    expect(h.store.db.select().from(runMetrics).where(eq(runMetrics.runId, runId)).get()).toMatchObject({ costMicros: 140 });
    expect(h.store.db.select().from(runRoleCosts).where(eq(runRoleCosts.runId, runId)).all()).toEqual([
      { runId, role: "dev", model: "opus", effort: "high", tokens: 6, costMicros: 140 },
    ]);
  });

  test("una corrida que termina mal guarda su outcome, y una cancelada, canceled", async () => {
    const h = team(scripted([10], ["changes", "changes", "changes", "changes"]));
    h.action("never", ["ok"], () => new Promise(() => {}));
    h.save({
      schema: 1,
      id: "stuck",
      name: "Atascado",
      trigger: { type: "manual" },
      start: "wait",
      nodes: { wait: { type: "action", action: "never", args: {}, on: { ok: "@done" } } },
    });

    const failed = await h.startIn(projectA, "ENG-1");
    const canceled = h.flows.start("stuck", { type: "issue", id: "ENG-2" }, {}, { profile: "default", projectId: projectA });
    h.flows.cancel(canceled);

    const result = (id: RunId) => h.store.db.select().from(runMetrics).where(eq(runMetrics.runId, id)).get();
    expect(result(failed)).toMatchObject({ result: "failed", rounds: { review: 3 } });
    expect(result(canceled)).toMatchObject({ result: "canceled", costMicros: 0, outcomes: {} });
  });
});

describe("agregados", () => {
  async function seeded() {
    const h = team(scripted([100, 200, 100, 300, 50, 60]));
    const a1 = await h.startIn(projectA, "ENG-1");
    const a2 = await h.startIn(projectA, "ENG-2");
    const b1 = await h.startIn(projectB, "ENG-3");
    // Cierres en dos días, vistos desde UTC-3: a1 y a2 el 1 de enero; b1 el 3, a las 01:00 UTC (2 en UTC-3).
    h.closeAt(a1, Date.UTC(2027, 0, 1, 12));
    h.closeAt(a2, Date.UTC(2027, 0, 2, 1));
    h.closeAt(b1, Date.UTC(2027, 0, 3, 1));
    return { ...h, a1, a2, b1 };
  }

  test("byRole y byModel suman las corridas y se pueden filtrar por proyecto y rango", async () => {
    const { metrics } = await seeded();

    expect(metrics.byRole()).toEqual([
      { role: "reviewer", runs: 3, tokens: 9, costMicros: 200 + 300 + 60 },
      { role: "dev", runs: 3, tokens: 9, costMicros: 100 + 100 + 50 },
    ]);
    expect(metrics.byRole({ projectId: projectB })).toEqual([
      { role: "reviewer", runs: 1, tokens: 3, costMicros: 60 },
      { role: "dev", runs: 1, tokens: 3, costMicros: 50 },
    ]);
    expect(metrics.byRole({ from: Date.UTC(2027, 0, 2), to: Date.UTC(2027, 0, 3) })).toEqual([
      { role: "reviewer", runs: 1, tokens: 3, costMicros: 300 },
      { role: "dev", runs: 1, tokens: 3, costMicros: 100 },
    ]);
    expect(metrics.byModel()).toEqual([
      { model: "sonnet", tokens: 9, costMicros: 560 },
      { model: "opus", tokens: 9, costMicros: 250 },
    ]);
  });

  test("`imported` separa las corridas que trajo `import legacy` (las de `source_key`) de las que corrió Yard", async () => {
    const { metrics, store, a1 } = await seeded();
    store.tx((tx) => tx.db.update(runs).set({ sourceKey: "legacy:metrics:x:ENG-1:t" }).where(eq(runs.id, a1)).run());

    expect(metrics.byRole({ imported: true })).toEqual([
      { role: "reviewer", runs: 1, tokens: 3, costMicros: 200 },
      { role: "dev", runs: 1, tokens: 3, costMicros: 100 },
    ]);
    expect(metrics.byRole({ imported: false })).toEqual([
      { role: "reviewer", runs: 2, tokens: 6, costMicros: 360 },
      { role: "dev", runs: 2, tokens: 6, costMicros: 150 },
    ]);
    expect(metrics.byModel({ imported: true })).toEqual([
      { model: "sonnet", tokens: 3, costMicros: 200 },
      { model: "opus", tokens: 3, costMicros: 100 },
    ]);
    expect(metrics.byDay({ imported: false }).map((d) => d.runs)).toEqual([1, 1]);
  });

  test("byDay agrupa por día de cierre en la zona pedida", async () => {
    const { metrics } = await seeded();

    expect(metrics.byDay()).toEqual([
      { day: "2027-01-01", runs: 1, costMicros: 300 },
      { day: "2027-01-02", runs: 1, costMicros: 400 },
      { day: "2027-01-03", runs: 1, costMicros: 110 },
    ]);
    expect(metrics.byDay({ utcOffsetMinutes: -180 })).toEqual([
      { day: "2027-01-01", runs: 2, costMicros: 700 },
      { day: "2027-01-02", runs: 1, costMicros: 110 },
    ]);
  });

  test("summary: totales, rondas por contador y costo por rol del proyecto", async () => {
    // a1: review pide cambios una vez (dev, review, dev, review); a2 aprueba de una (dev, review).
    const h = team(scripted([100, 200, 300, 400, 10, 20, 7, 8], ["changes", "ok", "ok", "ok"]));
    const a1 = await h.startIn(projectA, "ENG-1");
    const a2 = await h.startIn(projectA, "ENG-2");
    await h.startIn(projectB, "ENG-3");
    h.closeAt(a1, 1_000);
    h.closeAt(a2, 5_000);

    const summary = h.metrics.summary(projectA);

    const minutes = [a1, a2].map((id) => h.store.db.select().from(runMetrics).where(eq(runMetrics.runId, id)).get()?.minutes ?? 0);
    expect(summary).toEqual({
      runs: 2,
      results: [{ result: "done", count: 2 }],
      costMicros: 1030,
      avgCostMicros: 515,
      minutes: minutes[0]! + minutes[1]!,
      avgMinutes: (minutes[0]! + minutes[1]!) / 2,
      rounds: [{ counter: "review", total: 1, perRun: 0.5 }],
      byRole: [
        { role: "reviewer", runs: 2, tokens: 9, costMicros: 200 + 400 + 20 },
        { role: "dev", runs: 2, tokens: 9, costMicros: 100 + 300 + 10 },
      ],
      firstAt: 1_000,
      lastAt: 5_000,
    });
  });

  test("el costo de una corrida hija cuenta en los totales, pero la hija no es una corrida más", async () => {
    const h = team(scripted([100, 200, 30]));
    h.save({
      schema: 1,
      id: "child",
      name: "Hija",
      trigger: { type: "subflow" },
      start: "work",
      nodes: { work: { type: "agent", role: "dev", mode: "plan", brief: {}, on: { ok: "@done", changes: "@failed" } } },
    });
    h.save({
      schema: 1,
      id: "parent",
      name: "Padre",
      trigger: { type: "manual" },
      start: "sub",
      nodes: { sub: { type: "flow", flow: "child", params: {}, on: { done: "@done", blocked: "@blocked", failed: "@failed" } } },
    });
    await h.startIn(projectA, "ENG-1");
    const parent = h.flows.start("parent", { type: "issue", id: "ENG-2" }, {}, { profile: "default", projectId: projectA });
    await h.finished(parent);

    const summary = h.metrics.summary(projectA);

    expect(summary).toMatchObject({ runs: 2, costMicros: 330 });
    expect(summary.byRole).toEqual([
      { role: "reviewer", runs: 1, tokens: 3, costMicros: 200 },
      { role: "dev", runs: 2, tokens: 6, costMicros: 130 },
    ]);
    expect(h.metrics.byDay().map((d) => d.runs)).toEqual([2]);
  });

  test("summary de un proyecto sin corridas cerradas", () => {
    const h = team(scripted([]));

    expect(h.metrics.summary(projectA)).toEqual({
      runs: 0,
      results: [],
      costMicros: 0,
      avgCostMicros: null,
      minutes: 0,
      avgMinutes: null,
      rounds: [],
      byRole: [],
      firstAt: null,
      lastAt: null,
    });
  });
});
