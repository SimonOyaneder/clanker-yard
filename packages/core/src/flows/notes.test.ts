import { afterEach, describe, expect, test } from "vitest";
import { harness as createHarness } from "./harness";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function harness(options: Parameters<typeof createHarness>[0] = {}) {
  const h = createHarness(options);
  cleanups.push(h.cleanup);
  return h;
}

describe("notas que no bloquean", () => {
  test("un edge exhausted con note deja una decisión pending y la corrida sigue a su destino", async () => {
    const h = harness();
    h.action("check", ["ok", "fail"], () => ({ outcome: "fail" }));
    h.action("fix", ["ok"]);
    h.action("after", ["ok"]);
    h.save({
      schema: 1,
      id: "exhausts",
      name: "Rondas agotadas",
      trigger: { type: "manual" },
      start: "check",
      nodes: {
        check: {
          type: "action",
          action: "check",
          args: {},
          on: { ok: "@done", fail: { to: "fix", maxRounds: 1, exhausted: { to: "after", note: "Tests rojos tras las rondas" } } },
        },
        fix: { type: "action", action: "fix", args: {}, on: { ok: "check" } },
        after: { type: "action", action: "after", args: {}, on: { ok: "@done" } },
      },
    });

    const runId = h.start("exhausts");
    await h.finished(runId);

    expect(h.flows.getRun(runId)).toMatchObject({ status: "done", outcome: "done" });
    expect(h.nodes(runId)).toEqual(["check", "fix", "check", "after"]);
    const [note, ...rest] = h.decisions.list({ runId });
    expect(rest).toEqual([]);
    expect(note).toMatchObject({
      kind: "review_note",
      status: "pending",
      title: "Tests rojos tras las rondas",
      runId,
      subject: { type: "issue", id: "ENG-1" },
      resolution: null,
    });
    expect(note?.stepRunId).toBe(h.flows.getRun(runId).steps[2]?.id);
    const opened = h.store.events.since(0, { runId, types: ["decision.opened"] });
    expect(opened.map((e) => e.payload)).toEqual([{ decisionId: note?.id, kind: "review_note", title: "Tests rojos tras las rondas" }]);
  });

  test("el note de un edge normal también va a la bandeja", async () => {
    const h = harness();
    h.action("check", ["ok", "fail"], () => ({ outcome: "fail" }));
    h.save({
      schema: 1,
      id: "noted",
      name: "Con nota",
      trigger: { type: "manual" },
      start: "check",
      nodes: { check: { type: "action", action: "check", args: {}, on: { ok: "@done", fail: { to: "@done", note: "CI rojo ajeno" } } } },
    });

    const runId = h.start("noted");
    await h.finished(runId);

    expect(h.decisions.list({ runId }).map((d) => [d.kind, d.title, d.status])).toEqual([["review_note", "CI rojo ajeno", "pending"]]);
  });

  test("resolver una nota la deja answered con lo que se eligió, sin tocar la corrida", async () => {
    const h = harness();
    h.action("check", ["ok", "fail"], () => ({ outcome: "fail" }));
    h.save({
      schema: 1,
      id: "noted",
      name: "Con nota",
      trigger: { type: "manual" },
      start: "check",
      nodes: { check: { type: "action", action: "check", args: {}, on: { ok: "@done", fail: { to: "@done", note: "CI rojo ajeno" } } } },
    });
    const runId = h.start("noted");
    await h.finished(runId);
    const [note] = h.decisions.list({ runId });

    h.flows.resolveGate(note?.id as never, "visto, no es mío", "ui");

    expect(h.decisions.get(note?.id as never)).toMatchObject({ status: "answered", resolution: { option: "visto, no es mío" }, resolvedBy: "ui" });
    expect(h.flows.getRun(runId)).toMatchObject({ status: "done", outcome: "done" });
    expect(h.store.events.since(0, { runId, types: ["decision.resolved"] })).toHaveLength(1);
    expect(() => h.flows.resolveGate(note?.id as never, "otra vez", "ui")).toThrow(/ya está answered/);
  });

  test("las decisions del reporte de un agente quedan en la bandeja y la corrida sigue", async () => {
    const h = harness({
      script: () =>
        Promise.resolve({
          structured: {
            outcome: "ok",
            summary: "listo",
            decisions: [
              { title: "Dejé el timeout en 30s", body: "El issue no lo define." },
              { title: "No toqué el README", body: "Fuera del scope." },
            ],
            payload: { n: 1 },
          },
        }),
    });
    h.save({
      schema: 1,
      id: "agent-notes",
      name: "Agente con notas",
      trigger: { type: "manual" },
      start: "plan",
      nodes: { plan: { type: "agent", role: "dev", mode: "plan", brief: {}, on: { ok: "@done", changes: "@done" } } },
    });

    const runId = h.start("agent-notes");
    await h.finished(runId);

    expect(h.flows.getRun(runId)).toMatchObject({ status: "done", outcome: "done" });
    expect(h.decisions.list({ runId, status: ["pending"] }).map((d) => [d.kind, d.title, d.body])).toEqual([
      ["review_note", "No toqué el README", "Fuera del scope."],
      ["review_note", "Dejé el timeout en 30s", "El issue no lo define."],
    ]);
    expect(h.store.events.since(0, { runId, types: ["decision.opened"] })).toHaveLength(2);
  });

  test("una rama de un parallel también deja sus decisions", async () => {
    const h = harness({
      script: () =>
        Promise.resolve({
          structured: { outcome: "ok", summary: "", decisions: [{ title: "Duda de la rama", body: "x" }], payload: { n: 1 } },
        }),
    });
    h.save({
      schema: 1,
      id: "branches",
      name: "Ramas",
      trigger: { type: "manual" },
      start: "reviews",
      nodes: {
        reviews: {
          type: "parallel",
          branches: ["rv"],
          join: "worst",
          on: { ok: "@done", changes: "@done", fail: "@done" },
        },
        rv: { type: "agent", role: "dev", mode: "plan", brief: {} },
      },
    });

    const runId = h.start("branches");
    await h.finished(runId);

    expect(h.flows.getRun(runId).status).toBe("done");
    expect(h.decisions.list({ runId }).map((d) => d.title)).toEqual(["Duda de la rama"]);
  });
});
