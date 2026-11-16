import { describe, expect, test } from "vitest";
import { Edge, FlowDef, isRef, Node } from "./index";

const minimal = {
  schema: 1,
  id: "mini",
  name: "Mini",
  trigger: { type: "manual" },
  start: "run-it",
  nodes: { "run-it": { type: "action", action: "x.y", args: { a: "$run.params.a" }, on: { ok: "@done" } } },
};

describe("FlowDef", () => {
  test("acepta un flujo mínimo", () => {
    expect(FlowDef.safeParse(minimal).success).toBe(true);
  });

  test.each([
    ["schema distinto de 1", { ...minimal, schema: 2 }],
    ["un trigger desconocido", { ...minimal, trigger: { type: "cron" } }],
    ["una clave que el formato no tiene", { ...minimal, colour: "red" }],
    ["un id de nodo con punto, que un ref no podría navegar", { ...minimal, nodes: { "a.b": minimal.nodes["run-it"] } }],
  ])("rechaza %s", (_name, def) => {
    expect(FlowDef.safeParse(def).success).toBe(false);
  });
});

describe("Node y Edge", () => {
  test("seis tipos de nodo, ninguno más", () => {
    const nodes = [
      { type: "agent", role: "dev", mode: "plan", brief: {} },
      { type: "action", action: "a", args: {} },
      { type: "parallel", branches: ["a"] },
      { type: "gate", question: "?", options: [{ id: "go", label: "Seguir" }] },
      { type: "wait", event: "pr.ci", args: {} },
      { type: "flow", flow: "pr-feedback", params: {} },
    ];
    expect(nodes.map((n) => Node.safeParse(n).success)).toEqual(nodes.map(() => true));
    expect(Node.safeParse({ type: "loop" }).success).toBe(false);
  });

  test("un agente puede pedir otra entrada del perfil, con el mismo formato que la de escalada", () => {
    const agent = { type: "agent", role: "review-bugs", mode: "review", brief: {} };
    expect(Node.safeParse({ ...agent, profileRole: "review-bugs-opencode" }).success).toBe(true);
    expect(Node.safeParse({ ...agent, profileRole: "review bugs" }).success).toBe(false);
  });

  test("un edge es un nodo, un fin o un objeto con to", () => {
    expect(Edge.safeParse("next").success).toBe(true);
    expect(Edge.safeParse("@done").success).toBe(true);
    expect(Edge.safeParse({ to: "next", maxRounds: "$run.params.rounds", exhausted: { to: "@failed", note: "n" } }).success).toBe(true);
    expect(Edge.safeParse({ maxRounds: 2 }).success).toBe(false);
    expect(Edge.safeParse("@nope").success).toBe(false);
  });
});

test("isRef distingue un ref de un string cualquiera", () => {
  expect(["$plan", "$plan.files", "$run.params.base", "$bot-wait.items"].map(isRef)).toEqual([true, true, true, true]);
  expect(["plan", "$", "$5", "$a b", "costs $5", 3].map(isRef)).toEqual([false, false, false, false, false, false]);
});
