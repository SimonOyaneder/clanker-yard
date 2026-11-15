import type { Role } from "@clanker/api";
import { afterEach, describe, expect, test, vi } from "vitest";
import { harness as createHarness, okReport, reportSchema, type AgentCall } from "./harness";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const reviewer = (name: string): Role => ({
  prompt: `Eres ${name}.`,
  context: [],
  modes: { review: { instructions: "Revisa.", report: reportSchema, outcomes: ["ok", "changes"], session: "new" } },
});
const merger: Role = {
  prompt: "Consolidas.",
  context: [],
  modes: { merge: { instructions: "Junta.", report: reportSchema, outcomes: ["ok", "changes"], session: "new" } },
};
const roles = { "rv-bugs": reviewer("bugs"), "rv-tests": reviewer("tests"), merger };

interface Finding {
  id: string;
  severity: "red" | "yellow" | "white";
  path: string;
  line: number;
  claim: string;
  fix: string;
  trivial?: boolean;
}
const finding = (id: string, severity: Finding["severity"], path: string, line: number, claim: string, extra: Partial<Finding> = {}): Finding => ({
  id,
  severity,
  path,
  line,
  claim,
  fix: `arreglar ${claim}`,
  ...extra,
});

/** Lo que responde cada rol, una respuesta por llamada, en orden. Un rol sin respuestas pendientes da ok sin hallazgos. */
type Reply = { findings?: Finding[]; outcome?: string; fail?: string };
function replies(byRole: Record<string, Reply[]>) {
  return (call: AgentCall): Promise<Record<string, unknown>> => {
    const reply = byRole[call.spec?.role ?? ""]?.shift() ?? {};
    if (reply.fail) return Promise.resolve({ status: "error", message: reply.fail });
    const findings = reply.findings ?? [];
    return Promise.resolve(okReport({ findings }, reply.outcome ?? (findings.length > 0 ? "changes" : "ok")));
  };
}

function harness(script: ReturnType<typeof replies>, options: { maxAgents?: number } = {}) {
  const h = createHarness({ roles, script, maxAgents: options.maxAgents });
  cleanups.push(h.cleanup);
  /** Los args con que corrió cada acción `fix` (lo que el dev recibe de los reviewers). */
  const fixInputs: { findings: (Finding & { branch: string })[] }[] = [];
  const reported: unknown[] = [];
  h.action("fix", ["ok"], (args) => {
    fixInputs.push(args.input as { findings: (Finding & { branch: string })[] });
    return { outcome: "ok" };
  });
  h.action("report", ["ok"], (args) => {
    reported.push(args.result);
    return { outcome: "ok" };
  });
  return { ...h, fixInputs, reported };
}

const mergeJoin = { fn: "items.merge", args: { items: "findings", rank: "severity", changesIf: ["red", "yellow"], idKeys: ["branch", "path", "claim"] } };

/** El flujo de reviews de "Techlead clásico": reviewers en paralelo, items.merge y vuelta al dev mientras haya 🔴/🟡. */
const reviewsFlow = (parallel: Record<string, unknown> = {}, branchNode: Record<string, unknown> = {}) => ({
  schema: 1,
  id: "reviews-flow",
  name: "Reviews",
  trigger: { type: "manual" },
  start: "reviews",
  nodes: {
    reviews: {
      type: "parallel",
      branches: ["rv-a", "rv-b"],
      join: mergeJoin,
      on: {
        ok: "report",
        changes: { to: "fix", counter: "review", maxRounds: 3, exhausted: "@failed" },
      },
      ...parallel,
    },
    "rv-a": { type: "agent", role: "rv-bugs", mode: "review", brief: { previous: "$self" }, ...branchNode },
    "rv-b": { type: "agent", role: "rv-tests", mode: "review", brief: { previous: "$self" }, ...branchNode },
    fix: { type: "action", action: "fix", args: { input: "$prev" }, on: { ok: "reviews" } },
    report: { type: "action", action: "report", args: { result: "$reviews" }, on: { ok: "@done" } },
  },
});

describe("parallel con ramas fijas", () => {
  test("el padre espera a sus ramas y el join se evalúa al cerrar la última, en su misma transacción", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const script = replies({});
    const h = harness((call) => (call.spec?.role === "rv-tests" ? gate.then(() => script(call)) : script(call)));
    h.save(reviewsFlow());

    const runId = h.start("reviews-flow");
    await vi.waitFor(() => expect(h.calls.map((c) => c.spec?.role).sort()).toEqual(["rv-bugs", "rv-tests"]));
    await vi.waitFor(() => expect(h.flows.getRun(runId).steps.find((s) => s.nodeId === "rv-a")?.status).toBe("done"));

    // Las dos ramas corrieron a la vez; una ya cerró y el padre sigue esperando.
    expect(h.flows.getRun(runId).steps.map((s) => [s.nodeId, s.status])).toEqual([
      ["reviews", "waiting"],
      ["rv-a", "done"],
      ["rv-b", "running"],
    ]);

    release();
    await h.finished(runId);

    expect(h.flows.getRun(runId)).toMatchObject({ status: "done", outcome: "done" });
    const events = h.store.events.since(0, { runId, types: ["step.finished"] });
    const finished = events.map((e) => (e.payload as { nodeId: string }).nodeId);
    expect(finished).toEqual(["rv-a", "rv-b", "reviews", "report"]);
    // Nada entre el cierre de la última rama y el del padre: es la misma transacción.
    const all = h.store.events.since(0, { runId }).map((e) => `${e.type}:${(e.payload as { nodeId?: string }).nodeId ?? ""}`);
    const last = all.indexOf("step.finished:rv-b");
    expect(all.slice(last, last + 3)).toEqual(["step.finished:rv-b", "step.finished:reviews", "step.started:report"]);
  });

  test("items.merge junta hallazgos duplicados entre reviewers: gana el de mayor severidad y salen 🔴 → 🟡 → ⚪", async () => {
    const h = harness(
      replies({
        "rv-bugs": [
          {
            findings: [
              finding("f1", "yellow", "a.ts", 10, "null deref"),
              finding("f2", "white", "a.ts", 40, "nombre largo"),
              finding("f3", "white", "b.ts", 5, "typo", { trivial: true }),
            ],
          },
          {},
        ],
        "rv-tests": [{ findings: [finding("g1", "red", "a.ts", 12, "falta test del nil"), finding("g2", "yellow", "c.ts", 1, "sin cobertura")] }, {}],
      }),
    );
    h.save(reviewsFlow());

    const runId = h.start("reviews-flow");
    await h.finished(runId);

    expect(h.fixInputs).toHaveLength(1);
    const merged = h.fixInputs[0]?.findings ?? [];
    expect(merged.map(({ branch, path, line, severity }) => [branch, path, line, severity])).toEqual([
      ["rv-b", "a.ts", 12, "red"],
      ["rv-b", "c.ts", 1, "yellow"],
      ["rv-a", "b.ts", 5, "white"],
    ]);
    expect(merged.every((f) => /^[0-9a-f]{12}$/.test(f.id))).toBe(true);
    expect(new Set(merged.map((f) => f.id)).size).toBe(3);
    expect(h.flows.getRun(runId).rounds).toEqual({ review: 1 });
  });

  test("solo ⚪ sin trivial no pide cambios", async () => {
    const h = harness(replies({ "rv-bugs": [{ findings: [finding("f1", "white", "a.ts", 1, "nit")], outcome: "changes" }] }));
    h.save(reviewsFlow());

    const runId = h.start("reviews-flow");
    await h.finished(runId);

    expect(h.fixInputs).toHaveLength(0);
    expect(h.reported).toEqual([{ findings: [] }]);
  });

  test("los ids son estables entre rondas: el mismo hallazgo con otro id local y unas líneas más abajo", async () => {
    const h = harness(
      replies({
        "rv-bugs": [
          { findings: [finding("f1", "yellow", "a.ts", 10, "null deref")] },
          { findings: [finding("f7", "yellow", "a.ts", 12, "null deref"), finding("f8", "yellow", "a.ts", 30, "otro")] },
          {},
        ],
      }),
    );
    h.save(reviewsFlow());

    const runId = h.start("reviews-flow");
    await h.finished(runId);

    const [first, second] = h.fixInputs.map((input) => input.findings);
    const nullDeref = (list: typeof first) => list?.find((f) => f.claim === "null deref")?.id;
    expect(nullDeref(first)).toBeDefined();
    expect(nullDeref(second)).toBe(nullDeref(first));
    expect(second?.map((f) => f.claim)).toEqual(["null deref", "otro"]);
    expect(new Set(second?.map((f) => f.id)).size).toBe(2);
  });

  test("rerun not-ok relanza solo las ramas con changes y el join usa lo último de las que no corrieron", async () => {
    const h = harness(
      replies({
        "rv-bugs": [{ findings: [finding("f1", "yellow", "a.ts", 10, "null deref")] }, {}],
        "rv-tests": [{ findings: [finding("g1", "white", "b.ts", 2, "typo", { trivial: true })], outcome: "ok" }],
      }),
    );
    h.save(reviewsFlow({ rerun: "not-ok" }));

    const runId = h.start("reviews-flow");
    await h.finished(runId);

    expect(h.calls.map((c) => c.spec?.role)).toEqual(["rv-bugs", "rv-tests", "rv-bugs"]);
    const view = h.flows.getRun(runId);
    expect(view.steps.map((s) => `${s.nodeId}#${s.visit}`)).toEqual([
      "reviews#1",
      "rv-a#1",
      "rv-b#1",
      "fix#1",
      "reviews#2",
      "rv-a#2",
      "report#1",
    ]);
    expect(view.status).toBe("done");
    // rv-b no corrió en la ronda 2 y su hallazgo trivial sigue en el resultado.
    expect(h.reported).toHaveLength(1);
    expect((h.reported[0] as { findings: Finding[] }).findings.map((f) => f.claim)).toEqual(["typo"]);
  });

  test("rerun not-ok sin ramas que correr evalúa el join al reentrar, con lo último de cada una", async () => {
    const h = harness(replies({ "rv-bugs": [{ findings: [finding("f1", "white", "a.ts", 1, "typo", { trivial: true })], outcome: "ok" }] }));
    let visits = 0;
    h.action("again", ["again", "done"], () => ({ outcome: ++visits === 1 ? "again" : "done" }));
    const flow = reviewsFlow({
      rerun: "not-ok",
      on: { ok: "again", changes: "@failed" },
    });
    Object.assign(flow.nodes, {
      again: { type: "action", action: "again", args: {}, on: { again: { to: "reviews", maxRounds: 1, exhausted: "@failed" }, done: "report" } },
    });
    delete (flow.nodes as Record<string, unknown>).fix;
    h.save(flow);

    const runId = h.start("reviews-flow");
    await h.finished(runId);

    expect(h.calls).toHaveLength(2);
    expect(h.flows.getRun(runId).steps.map((s) => `${s.nodeId}#${s.visit}:${s.status}`)).toEqual([
      "reviews#1:done",
      "rv-a#1:done",
      "rv-b#1:done",
      "again#1:done",
      "reviews#2:done",
      "again#2:done",
      "report#1:done",
    ]);
    expect((h.reported[0] as { findings: Finding[] }).findings.map((f) => f.claim)).toEqual(["typo"]);
  });

  test("sin rerun not-ok, cada ronda corre todas las ramas", async () => {
    const h = harness(replies({ "rv-bugs": [{ findings: [finding("f1", "yellow", "a.ts", 10, "x")] }, {}] }));
    h.save(reviewsFlow());

    const runId = h.start("reviews-flow");
    await h.finished(runId);

    expect(h.calls.map((c) => c.spec?.role)).toEqual(["rv-bugs", "rv-tests", "rv-bugs", "rv-tests"]);
  });

  test("$self le da a cada reviewer su reporte de la ronda anterior", async () => {
    const h = harness(replies({ "rv-bugs": [{ findings: [finding("f1", "yellow", "a.ts", 10, "null deref")] }, {}] }));
    h.save(reviewsFlow());

    const runId = h.start("reviews-flow");
    await h.finished(runId);

    const prompts = h.calls.filter((c) => c.spec?.role === "rv-bugs").map((c) => c.spec?.prompt ?? "");
    expect(prompts[0]).not.toContain("null deref");
    expect(prompts[1]).toContain("null deref");
  });

  describe("una rama con error", () => {
    const noRetry = { retry: { max: 0, backoffSec: [] } };

    test("con onBranchError ignore se ignora y el join sigue con las demás", async () => {
      const h = harness(
        replies({ "rv-tests": [{ fail: "el runtime se cayó" }], "rv-bugs": [{ findings: [finding("f1", "red", "a.ts", 1, "bug")] }, {}] }),
      );
      h.save(reviewsFlow({ onBranchError: "ignore" }, noRetry));

      const runId = h.start("reviews-flow");
      await h.finished(runId);

      const view = h.flows.getRun(runId);
      expect(view.steps.find((s) => s.nodeId === "rv-b")).toMatchObject({ status: "failed", outcome: "error", error: "el runtime se cayó" });
      expect(h.fixInputs[0]?.findings.map((f) => f.claim)).toEqual(["bug"]);
      expect(view.steps.find((s) => s.nodeId === "reviews")).toMatchObject({ status: "done", outcome: "changes" });
    });

    test("por defecto el parallel termina en error y, sin edge, la corrida queda parked en él", async () => {
      const h = harness(replies({ "rv-tests": [{ fail: "el runtime se cayó" }] }));
      h.save(reviewsFlow({}, noRetry));

      const runId = h.start("reviews-flow");
      await h.finished(runId);

      const view = h.flows.getRun(runId);
      expect(view).toMatchObject({ status: "parked", parkReason: "needs_human" });
      const parent = view.steps.find((s) => s.nodeId === "reviews");
      expect(parent).toMatchObject({ status: "failed", outcome: "error" });
      expect(parent?.error).toContain("rv-b: el runtime se cayó");
    });

    test("un edge error del parallel lo maneja", async () => {
      const h = harness(replies({ "rv-tests": [{ fail: "boom" }] }));
      h.save(reviewsFlow({ on: { ok: "report", changes: { to: "fix", maxRounds: 2, exhausted: "@failed" }, error: "report" } }, noRetry));

      const runId = h.start("reviews-flow");
      await h.finished(runId);

      expect(h.flows.getRun(runId).status).toBe("done");
    });

    test("si todas las ramas fallan, ignore no alcanza: el parallel termina en error", async () => {
      const h = harness(replies({ "rv-bugs": [{ fail: "a" }], "rv-tests": [{ fail: "b" }] }));
      h.save(reviewsFlow({ onBranchError: "ignore" }, noRetry));

      const runId = h.start("reviews-flow");
      await h.finished(runId);

      expect(h.flows.getRun(runId).steps.find((s) => s.nodeId === "reviews")).toMatchObject({ status: "failed", outcome: "error" });
    });

    test("rerun not-ok reintenta la rama que falló", async () => {
      const h = harness(replies({ "rv-tests": [{ fail: "boom" }], "rv-bugs": [{ findings: [finding("f1", "red", "a.ts", 1, "bug")] }, {}] }));
      h.save(reviewsFlow({ onBranchError: "ignore", rerun: "not-ok" }, noRetry));

      const runId = h.start("reviews-flow");
      await h.finished(runId);

      expect(h.calls.map((c) => c.spec?.role)).toEqual(["rv-bugs", "rv-tests", "rv-bugs", "rv-tests"]);
      expect(h.flows.getRun(runId).status).toBe("done");
    });
  });

  test("worst elige error > fail > changes > ok y deja lo que dio cada rama", async () => {
    const h = harness(replies({ "rv-bugs": [{ outcome: "ok" }], "rv-tests": [{ outcome: "changes" }] }));
    const flow = reviewsFlow({ join: "worst", on: { ok: "@failed", changes: "report", fail: "@failed" } });
    delete (flow.nodes as Record<string, unknown>).fix;
    h.save(flow);

    const runId = h.start("reviews-flow");
    await h.finished(runId);

    expect(h.flows.getRun(runId).status).toBe("done");
    expect(h.reported).toEqual([{ branches: { "rv-a": { outcome: "ok", output: { findings: [] } }, "rv-b": { outcome: "changes", output: { findings: [] } } } }]);
  });

  test("un consolidador que lanza deja al parallel en error con el motivo", async () => {
    const h = harness(replies({ "rv-bugs": [{ findings: [finding("f1", "orange" as "red", "a.ts", 1, "x")] }] }));
    h.save(reviewsFlow());

    const runId = h.start("reviews-flow");
    await h.finished(runId);

    const parent = h.flows.getRun(runId).steps.find((s) => s.nodeId === "reviews");
    expect(parent).toMatchObject({ status: "failed", outcome: "error" });
    expect(parent?.error).toContain('severity "orange"');
  });

  test("las ramas respetan el máximo global de agentes", async () => {
    let running = 0;
    let peak = 0;
    const script = replies({});
    const h = harness(
      async (call) => {
        running++;
        peak = Math.max(peak, running);
        await Promise.resolve();
        running--;
        return script(call);
      },
      { maxAgents: 1 },
    );
    h.save(reviewsFlow());

    const runId = h.start("reviews-flow");
    await h.finished(runId);

    expect(peak).toBe(1);
    expect(h.flows.getRun(runId).status).toBe("done");
  });
});

describe("parallel con forEach", () => {
  const forEachFlow = (parallel: Record<string, unknown> = {}) => ({
    schema: 1,
    id: "for-each",
    name: "forEach",
    trigger: { type: "manual" },
    start: "list",
    nodes: {
      list: { type: "action", action: "list", args: {}, on: { ok: "each" } },
      each: {
        type: "parallel",
        branches: { forEach: "$list.items", branch: { type: "agent", role: "rv-bugs", mode: "review", brief: { item: "$item", note: "$prev" } } },
        join: "worst",
        on: { ok: "report", changes: "report", fail: "@failed" },
        ...parallel,
      },
      report: { type: "action", action: "report", args: { result: "$each" }, on: { ok: "@done" } },
    },
  });

  test("corre la rama una vez por ítem con su $item y el join recibe las ramas por posición", async () => {
    const h = harness((call) => {
      const saw = /"item": \{\s*"n": 2/.test(call.spec?.prompt ?? "");
      return Promise.resolve(okReport({ saw }, saw ? "changes" : "ok"));
    });
    h.action("list", ["ok"], () => ({ outcome: "ok", output: { items: [{ n: 1 }, { n: 2 }, { n: 3 }] } }));
    h.save(forEachFlow());

    const runId = h.start("for-each");
    await h.finished(runId);

    const view = h.flows.getRun(runId);
    expect(view.steps.map((s) => s.nodeId)).toEqual(["list", "each", "each[0]", "each[1]", "each[2]", "report"]);
    const items = h.calls.map((c) => /"item": \{\s*"n": (\d)/.exec(c.spec?.prompt ?? "")?.[1]).sort();
    expect(items).toEqual(["1", "2", "3"]);
    expect(h.reported).toEqual([
      {
        branches: {
          "0": { outcome: "ok", output: { saw: false } },
          "1": { outcome: "changes", output: { saw: true } },
          "2": { outcome: "ok", output: { saw: false } },
        },
      },
    ]);
  });

  test("una lista vacía no crea ramas y el join da ok", async () => {
    const h = harness(replies({}));
    h.action("list", ["ok"], () => ({ outcome: "ok", output: { items: [] } }));
    h.save(forEachFlow());

    const runId = h.start("for-each");
    await h.finished(runId);

    expect(h.calls).toHaveLength(0);
    expect(h.flows.getRun(runId).steps.map((s) => [s.nodeId, s.outcome])).toEqual([
      ["list", "ok"],
      ["each", "ok"],
      ["report", "ok"],
    ]);
  });

  test("un forEach que no resuelve a una lista es un error del parallel", async () => {
    const h = harness(replies({}));
    h.action("list", ["ok"], () => ({ outcome: "ok", output: { items: "no es lista" } }));
    h.save(forEachFlow());

    const runId = h.start("for-each");
    await h.finished(runId);

    const each = h.flows.getRun(runId).steps.find((s) => s.nodeId === "each");
    expect(each).toMatchObject({ status: "failed", outcome: "error" });
    expect(each?.error).toContain("no resolvió a una lista");
  });

  test("al reentrar, el forEach vuelve a resolver su lista", async () => {
    const lists = [[{ n: 1 }, { n: 2 }], [{ n: 9 }]];
    const h = harness(replies({ "rv-bugs": [{ outcome: "changes" }] }));
    h.action("list", ["ok"], () => ({ outcome: "ok", output: { items: lists.shift() } }));
    h.save(forEachFlow({ on: { ok: "report", changes: { to: "list", maxRounds: 1, exhausted: "report" }, fail: "@failed" } }));

    const runId = h.start("for-each");
    await h.finished(runId);

    // En la primera visita, una rama da changes y vuelve a `list`; en la segunda hay un solo ítem.
    expect(h.flows.getRun(runId).steps.map((s) => s.nodeId)).toEqual([
      "list",
      "each",
      "each[0]",
      "each[1]",
      "list",
      "each",
      "each[0]",
      "report",
    ]);
  });
});

describe("el join como rol consolidador", () => {
  const roleJoinFlow = {
    schema: 1,
    id: "role-join",
    name: "Join con rol",
    trigger: { type: "manual" },
    start: "reviews",
    nodes: {
      reviews: {
        type: "parallel",
        branches: ["rv-a", "rv-b"],
        join: { role: "merger", mode: "merge" },
        on: { ok: "report", changes: "@failed" },
      },
      "rv-a": { type: "agent", role: "rv-bugs", mode: "review", brief: {} },
      "rv-b": { type: "agent", role: "rv-tests", mode: "review", brief: {} },
      report: { type: "action", action: "report", args: { result: "$reviews" }, on: { ok: "@done" } },
    },
  };

  test("un paso de agente recibe {rama: output} y su outcome y su output son los del parallel", async () => {
    const h = harness((call) => {
      if (call.spec?.role === "merger") return Promise.resolve(okReport({ verdict: "todo bien" }));
      return Promise.resolve(okReport({ from: call.spec?.role, text: "$self" }));
    });
    h.save(roleJoinFlow);

    const runId = h.start("role-join");
    await h.finished(runId);

    const view = h.flows.getRun(runId);
    expect(view.steps.map((s) => s.nodeId)).toEqual(["reviews", "rv-a", "rv-b", "reviews#join", "report"]);
    const prompt = h.calls.find((c) => c.spec?.role === "merger")?.spec?.prompt ?? "";
    expect(prompt).toContain('"rv-a"');
    expect(prompt).toContain('"from": "rv-bugs"');
    expect(prompt).toContain('"from": "rv-tests"');
    // Un texto que parece un ref no se resuelve al pasar por el join.
    expect(prompt).toContain('"text": "$self"');
    expect(h.reported).toEqual([{ verdict: "todo bien" }]);
    expect(view.status).toBe("done");
  });

  test("el outcome del rol elige el edge del parallel", async () => {
    const h = harness((call) => Promise.resolve(call.spec?.role === "merger" ? okReport({}, "changes") : okReport({})));
    h.save(roleJoinFlow);

    const runId = h.start("role-join");
    await h.finished(runId);

    expect(h.flows.getRun(runId)).toMatchObject({ status: "failed", outcome: "failed" });
  });

  test("si el rol consolidador falla (agotados sus reintentos), el parallel termina en error", async () => {
    vi.useFakeTimers();
    const h = harness((call) => Promise.resolve(call.spec?.role === "merger" ? { status: "error", message: "sin cuota" } : okReport({})));
    h.save(roleJoinFlow);

    const runId = h.start("role-join");
    await vi.advanceTimersByTimeAsync(10_000);
    await h.finished(runId);

    const view = h.flows.getRun(runId);
    expect(view.steps.find((s) => s.nodeId === "reviews#join")).toMatchObject({ status: "failed", outcome: "error", error: "sin cuota" });
    expect(view.steps.find((s) => s.nodeId === "reviews")).toMatchObject({ status: "failed", outcome: "error" });
    expect(view.status).toBe("parked");
  });
});
