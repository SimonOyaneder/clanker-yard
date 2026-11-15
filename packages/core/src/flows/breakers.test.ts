import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createBreakers, GITHUB_SCOPE, repoScope, runtimeScope, type Breakers } from "../breakers/breakers";
import { runs } from "../store/schema";
import type { Store } from "../store/store";
import { EnvironmentError } from "./catalog";
import { harness as createHarness, okReport, type AgentScript } from "./harness";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Un motor con breakers reales; `down` es lo que las pruebas ven caído. Los sujetos `a-*` son del repo `a` y los `b-*` del `b`. */
function setup(script?: AgentScript, options: { maxAgents?: number } = {}) {
  const down = new Set<string>();
  const probes: string[] = [];
  let breakers!: Breakers;
  let store!: Store;
  const h = createHarness({
    script,
    ...options,
    environment: (s) => {
      store = s;
      breakers = createBreakers({
        store: s,
        runtime: "fake",
        probe: (scope) => {
          probes.push(scope);
          return Promise.resolve(down.has(scope) ? "sigue caído" : undefined);
        },
      });
      breakers.start();
      return { breakers, runtime: "fake" };
    },
    workspaceOf: (runId) => {
      const subject = store.db.select({ id: runs.subjectId }).from(runs).where(eq(runs.id, runId)).get()?.id ?? "";
      return { path: "/work/tree", base: "main", repoId: subject.startsWith("a-") ? "a" : "b" };
    },
  });
  cleanups.push(() => breakers.close(), h.cleanup);
  return { ...h, breakers, down, probes, store };
}

const flow = (id: string, nodes: Record<string, unknown>, start: string) => ({ schema: 1, id, name: id, trigger: { type: "manual" }, start, nodes });
const subject = (id: string) => ({ type: "issue" as const, id });

describe("un repo caído", () => {
  const checkFlow = flow("check", { check: { type: "action", action: "check", args: {}, on: { ok: "@done" } } }, "check");

  function repoDown() {
    const t = setup();
    const checked: string[] = [];
    t.action(
      "check",
      ["ok"],
      (_args, ctx) => {
        const repo = t.store.db.select({ id: runs.subjectId }).from(runs).where(eq(runs.id, ctx.runId)).get()!.id.startsWith("a-") ? "a" : "b";
        checked.push(repo);
        if (t.down.has(repoScope(repo))) throw new EnvironmentError(repoScope(repo), "No responde: Postgres.");
        return { outcome: "ok" };
      },
      { needsRepoEnv: true },
    );
    t.save(checkFlow);
    return { ...t, checked };
  }

  test("no frena a otro repo, espera sin gastar intento y sigue solo cuando la prueba pasa", async () => {
    vi.useFakeTimers();
    const t = repoDown();
    t.down.add(repoScope("a"));

    const a = t.start("check", subject("a-1"));
    const b = t.start("check", subject("b-1"));
    await vi.advanceTimersByTimeAsync(0);

    expect(t.flows.getRun(b)).toMatchObject({ status: "done" });
    expect(t.flows.getRun(a)).toMatchObject({ status: "running" });
    expect(t.flows.getRun(a).steps[0]).toMatchObject({ status: "pending", error: "No responde: Postgres." });
    expect(t.breakers.list().map((x) => x.scope)).toEqual(["repo:a"]);
    expect(t.store.events.since(0, { types: ["breaker.opened"] })[0]?.payload).toMatchObject({ scope: "repo:a", cause: "environment" });

    // Pasa la primera prueba (1 min) y sigue caído: el breaker lo mantiene en pausa, aunque el paso ya podría correr.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.probes).toEqual(["repo:a"]);
    expect(t.checked).toEqual(["a", "b"]);
    expect(t.flows.getRun(a).steps[0]).toMatchObject({ status: "pending" });

    t.down.clear();
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(t.breakers.list()).toEqual([]);
    expect(t.flows.getRun(a)).toMatchObject({ status: "done" });
    // El intento 1 lo gastó la espera del entorno y no cuenta: nunca hubo `error` ni park.
    expect(t.flows.getRun(a).steps[0]).toMatchObject({ outcome: "ok", attempt: 2 });
    expect(t.store.events.since(0, { types: ["breaker.closed"] })).toHaveLength(1);
  });

  test("un agente del repo en pausa tampoco se despacha, pero el de otro repo sí", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.save(flow("plan", { plan: { type: "agent", role: "dev", mode: "plan", brief: {}, on: { ok: "@done", changes: "@failed" } } }, "plan"));
    t.breakers.trip({ scope: repoScope("a"), cause: "environment", reason: "Postgres caído" });

    const a = t.start("plan", subject("a-1"));
    const b = t.start("plan", subject("b-1"));
    await vi.advanceTimersByTimeAsync(0);

    expect(t.flows.getRun(b)).toMatchObject({ status: "done" });
    expect(t.calls.map((c) => c.subject)).toEqual(["b-1"]);
    expect(t.flows.getRun(a).steps[0]).toMatchObject({ status: "pending", attempt: 0 });
  });
});

describe("GitHub en rojo", () => {
  const mixed = flow(
    "mixed",
    {
      check: { type: "action", action: "check", args: {}, on: { ok: "plan" } },
      plan: { type: "agent", role: "dev", mode: "plan", brief: {}, on: { ok: "publish", changes: "@failed" } },
      publish: { type: "action", action: "publish", args: {}, on: { ok: "@done" } },
    },
    "check",
  );

  test("deja correr los agentes y los checks, y solo espera lo que publica", async () => {
    vi.useFakeTimers();
    const t = setup();
    const published: string[] = [];
    t.action("check", ["ok"], () => ({ outcome: "ok" }), { needsRepoEnv: true });
    t.action("publish", ["ok"], () => (published.push("pr"), { outcome: "ok" }), { effects: "remote" });
    t.save(mixed);
    t.breakers.trip({ scope: GITHUB_SCOPE, cause: "connection_lost", reason: "GitHub revocado" });

    const runId = t.start("mixed", subject("a-1"));
    await vi.advanceTimersByTimeAsync(0);

    expect(t.flows.getRun(runId).steps.map((s) => [s.nodeId, s.status])).toEqual([
      ["check", "done"],
      ["plan", "done"],
      ["publish", "pending"],
    ]);
    expect(published).toEqual([]);

    await vi.advanceTimersByTimeAsync(2 * 60_000);

    expect(published).toEqual(["pr"]);
    expect(t.flows.getRun(runId)).toMatchObject({ status: "done" });
  });

  test("un 401 que abre el breaker mientras el paso publica no gasta sus reintentos", async () => {
    vi.useFakeTimers();
    const t = setup();
    let calls = 0;
    t.action(
      "publish",
      ["ok"],
      () => {
        calls++;
        if (calls === 1) {
          // El cliente de GitHub deja la cuenta revocada antes de lanzar, como `markRevoked`.
          t.store.tx((tx) => tx.emit({ type: "connection.changed", origin: "core", payload: { provider: "github", account: "simon", status: "revoked" } }));
          throw new Error("GitHub rechazó el token");
        }
        return { outcome: "ok" };
      },
      { effects: "remote" },
    );
    t.save(flow("publish", { publish: { type: "action", action: "publish", args: {}, on: { ok: "@done" } } }, "publish"));

    const runId = t.start("publish", subject("a-1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.breakers.list()).toMatchObject([{ scope: "github", cause: "connection_lost" }]);
    expect(t.flows.getRun(runId).steps[0]).toMatchObject({ status: "pending" });

    // Reconectar prueba ya, sin esperar al backoff.
    t.store.tx((tx) => tx.emit({ type: "connection.changed", origin: "ui", payload: { provider: "github", account: "simon", status: "active" } }));
    await vi.advanceTimersByTimeAsync(2 * 60_000);

    expect(t.breakers.list()).toEqual([]);
    expect(calls).toBe(2);
    expect(t.flows.getRun(runId)).toMatchObject({ status: "done" });
  });
});

describe("el runtime de los agentes", () => {
  const plan = flow("plan", { plan: { type: "agent", role: "dev", mode: "plan", brief: {}, on: { ok: "@done", changes: "@failed" } } }, "plan");

  test("sin cuota abre runtime:<id> hasta el reset y pausa a todos los agentes, también los que no lo encontraron", async () => {
    vi.useFakeTimers();
    const resetsAt = Date.now() + 3_600_000;
    let first = true;
    const t = setup(() => {
      if (!first) return Promise.resolve(okReport());
      first = false;
      return Promise.resolve({ status: "quota_exhausted", message: "sin cuota", resetsAt });
    }, { maxAgents: 1 });
    t.save(plan);

    const one = t.start("plan", subject("a-1"));
    const two = t.start("plan", subject("b-1"));
    await vi.advanceTimersByTimeAsync(0);

    expect(t.breakers.open(runtimeScope("fake"))).toBe("sin cuota");
    expect(t.store.events.since(0, { types: ["breaker.opened"] })[0]?.payload).toMatchObject({ scope: "runtime:fake", cause: "quota_exhausted", retryAt: resetsAt });
    expect(t.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(3_599_000);
    expect(t.probes).toEqual([]);
    expect(t.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.probes).toEqual(["runtime:fake"]);
    expect(t.flows.getRun(one)).toMatchObject({ status: "done" });
    expect(t.flows.getRun(two)).toMatchObject({ status: "done" });
  });
});
