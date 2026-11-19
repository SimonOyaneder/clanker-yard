import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { harness, okReport } from "../../testing/flows-harness";

const migration = readFileSync(new URL("../../../migrations/20261118235414_codex_62_prices/migration.sql", import.meta.url), "utf8");

test("recupera el costo de cada paso de una sesión retomada y las métricas sin duplicar montos", async () => {
  const h = harness({
    resumeKeepsSession: true,
    script: async () => ({
      ...okReport(),
      usage: { turns: 1, tokensIn: 100, tokensOut: 10, tokensCacheRead: 0, tokensCacheWrite: 0, costMicros: 0, costSource: "estimate" },
    }),
  });
  try {
    h.save({
      schema: 1, id: "resumed", name: "Retomado", trigger: { type: "manual" }, start: "plan",
      nodes: {
        plan: { type: "agent", role: "dev", mode: "plan", brief: {}, on: { ok: "implement", changes: "@failed" } },
        implement: { type: "agent", role: "dev", mode: "implement", resumeFrom: "plan", brief: {}, on: { ok: "@done", changes: "@failed" } },
      },
    });
    const run = h.start("resumed");
    await h.finished(run);
    const db = h.store.db.$client;
    const model = "gpt-6.2-sol";
    db.prepare("UPDATE agent_sessions SET runtime = 'codex', model = ?, cost_source = 'estimate'").run(model);
    const session = db.prepare("SELECT id FROM agent_sessions").get()?.id;
    if (typeof session !== "string") throw new Error("Falta la sesión retomada");
    const steps = h.flows.getRun(run).steps;
    for (const [index, step] of steps.entries()) {
      const turn = index + 1;
      db.prepare(`INSERT INTO agent_turns (session_id, seq, ts, model, tokens_in, tokens_out, tokens_cache_read,
        tokens_cache_write, tokens_cache_write_1h, cost_micros) VALUES (?, ?, ?, ?, 100, ?, 0, 0, 0, 0)`)
        .run(session, turn, Date.UTC(2026, 10, 19), model, 10 * turn);
      db.prepare("INSERT INTO events (ts, type, origin, run_id, step_run_id, payload) VALUES (0, 'agent.usage', 'core', ?, ?, ?)")
        .run(run, step.id, JSON.stringify({ sessionId: session, turn }));
    }

    for (let pass = 0; pass < 2; pass++) {
      db.exec(migration);
      expect(h.flows.getRun(run).steps.map((s) => s.costMicros)).toEqual([300, 400]);
      expect(h.flows.getRun(run).costMicros).toBe(700);
      expect(db.prepare("SELECT cost_micros FROM step_usage ORDER BY cost_micros").all()).toEqual([{ cost_micros: 300 }, { cost_micros: 400 }]);
      for (const table of ["agent_sessions", "run_metrics", "run_role_costs"]) {
        expect(db.prepare(`SELECT cost_micros FROM ${table}`).all()).toEqual([{ cost_micros: 700 }]);
      }
    }
  } finally {
    await h.cleanup();
  }
});
