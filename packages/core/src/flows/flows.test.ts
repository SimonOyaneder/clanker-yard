import { FlowDef } from "@clanker/api";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { createAgents } from "../agents/agents";
import type { AgentRuntime } from "../agents/runtime";
import { createArtifacts } from "../artifacts/artifacts";
import { createDefs, type Defs } from "../defs/defs";
import { openStore, type Store } from "../store/store";
import type { RoleInfo } from "./catalog";
import { createFlows, FlowValidationError, type Flows } from "./flows";

const open: Store[] = [];
afterEach(() => {
  for (const store of open.splice(0)) store.close();
});

/** Estas pruebas solo validan y guardan: ningún paso corre, así que el runtime nunca se usa. */
const unusedRuntime: AgentRuntime = {
  id: "fake",
  capabilities: { structuredOutput: true, costPerTurn: true, resume: true, fork: false, steer: false },
  start: () => Promise.reject(new Error("no se usa")),
  resume: () => Promise.reject(new Error("no se usa")),
};

const anyArgs = z.record(z.string(), z.unknown());
const okOnly = ["ok"];

function setup(): { defs: Defs; flows: Flows } {
  const store = openStore({ path: ":memory:" });
  open.push(store);
  const defs = createDefs(store);
  const modes = (outcomes: string[], payload?: z.ZodType) => ({ outcomes, payload });
  const roles: Record<string, RoleInfo> = {
    dev: { modes: { plan: modes(okOnly), implement: modes(okOnly), fix: modes(okOnly) } },
    "plan-check": { modes: { check: modes(["ok", "changes"]) } },
    "review-bugs": {
      modes: {
        review: modes(["ok", "changes"], z.object({ ws: z.string(), previous: z.string().optional() })),
        "re-review": modes(["ok", "changes"]),
      },
    },
    "review-tests": { modes: { review: modes(["ok", "changes"]), "re-review": modes(["ok", "changes"]) } },
    "review-patterns": { modes: { review: modes(["ok", "changes"]) } },
    "review-lore": { modes: { review: modes(["ok", "changes"]) } },
    committer: { modes: { plan: modes(okOnly), route: modes(okOnly) } },
    triage: { modes: { bot: modes(["fix", "reply"]), ci: modes(["fix", "foreign"]) } },
  };
  const flows = createFlows({
    store,
    defs,
    agents: createAgents({ store, defs, runtime: unusedRuntime }),
    artifacts: createArtifacts({ store, dir: "sin-uso" }),
    roles: (id) => roles[id],
  });
  const action = (name: string, outcomes: string[], effects: "local" | "remote", args: z.ZodType = anyArgs) =>
    flows.registerAction({ name, outcomes, effects, args, run: () => Promise.reject(new Error("no se usa")) });
  action("workspace.acquire", okOnly, "local");
  action("workspace.syncBase", ["same", "rebased", "conflict"], "local");
  action("recipe.check", ["ok", "fail"], "local", z.object({ ws: z.unknown(), scope: z.enum(["changed", "all"]) }));
  action("review.requestBot", ["ok", "none"], "remote");
  action("pr.publish", ["ok", "replan"], "remote");
  action("pr.pushFixups", ["ok", "route"], "remote");
  action("pr.reply", okOnly, "remote");
  flows.registerWait({ name: "pr.botReview", outcomes: ["lgtm", "findings"], args: anyArgs });
  flows.registerWait({ name: "pr.ci", outcomes: ["ok", "fail"], args: anyArgs });
  return { defs, flows };
}

/** Copia `def` y aplica `edits` por ruta con puntos; un valor `undefined` borra la clave. */
function edit(def: unknown, edits: Record<string, unknown>): unknown {
  const copy = structuredClone(def);
  for (const [path, value] of Object.entries(edits)) {
    const keys = path.split(".");
    const last = keys.pop() as string;
    let target = copy as Record<string, unknown>;
    for (const key of keys) target = target[key] as Record<string, unknown>;
    if (value === undefined) delete target[last];
    else target[last] = value;
  }
  return copy;
}

const mini = {
  schema: 1,
  id: "mini",
  name: "Mini",
  trigger: { type: "manual" },
  params: { ws: "Workspace", rounds: { type: "number", default: 2 } },
  start: "check",
  nodes: {
    check: {
      type: "action",
      action: "recipe.check",
      args: { ws: "$run.params.ws", scope: "changed" },
      on: { ok: "@done", fail: { to: "fix", maxRounds: "$run.params.rounds", exhausted: "@failed" } },
    },
    fix: { type: "agent", role: "dev", mode: "fix", brief: { input: "$prev" }, on: { ok: "check" } },
  },
};

const linear = {
  schema: 1,
  id: "linear",
  name: "Lineal",
  trigger: { type: "manual" },
  start: "first",
  nodes: {
    first: { type: "action", action: "workspace.acquire", args: {}, on: { ok: "second" } },
    second: { type: "action", action: "workspace.acquire", args: { ws: "$first" }, on: { ok: "@done" } },
  },
};

const techlead = FlowDef.parse({
  schema: 1,
  id: "techlead-clasico",
  version: 1,
  name: "Techlead clásico",
  trigger: { type: "issue.queued" },
  lane: "dev",
  params: {
    repo: "RepoRef",
    base: "string",
    reviewRounds: { type: "number", default: 3 },
    checkRounds: { type: "number", default: 3 },
    externalRounds: { type: "number", default: 3 },
  },
  limits: { maxCostUsd: null, maxSteps: 200 },
  start: "ws",
  nodes: {
    ws: {
      type: "action",
      action: "workspace.acquire",
      args: { repo: "$run.params.repo", base: "$run.params.base", issue: "$run.subject" },
      on: { ok: "plan" },
    },
    plan: { type: "agent", role: "dev", mode: "plan", brief: { issue: "$run.subject", ws: "$ws" }, on: { ok: "plan-check" } },
    "plan-check": {
      type: "agent",
      role: "plan-check",
      mode: "check",
      when: "$plan.issueDoubts",
      brief: { plan: "$plan" },
      on: { ok: "implement", changes: { to: "plan", maxRounds: 2, exhausted: "implement" } },
    },
    implement: {
      type: "agent",
      role: "dev",
      mode: "implement",
      resumeFrom: "plan",
      brief: { plan: "$plan", notes: "$plan-check" },
      on: { ok: "checks" },
    },
    checks: {
      type: "action",
      action: "recipe.check",
      args: { ws: "$ws", scope: "changed" },
      on: {
        ok: "reviews",
        fail: {
          to: "fix",
          maxRounds: "$run.params.checkRounds",
          exhausted: { to: "reviews", note: "Tests o lint siguen rojos" },
        },
      },
    },
    fix: {
      type: "agent",
      role: "dev",
      mode: "fix",
      resumeFrom: "implement",
      brief: { plan: "$plan", input: "$prev" },
      escalate: { counter: "review", from: 2, profileRole: "dev-escala" },
      on: { ok: "checks" },
    },
    reviews: {
      type: "parallel",
      branches: ["rv-bugs", "rv-tests", "rv-patterns", "rv-lore"],
      rerun: "not-ok",
      onBranchError: "ignore",
      join: { fn: "items.merge", args: { items: "findings", rank: "severity", changesIf: ["red", "yellow"] } },
      on: {
        ok: "sync",
        changes: {
          to: "fix",
          counter: "review",
          maxRounds: "$run.params.reviewRounds",
          exhausted: { to: "sync", note: "Quedan 🔴/🟡 tras las rondas de review" },
        },
      },
    },
    "rv-bugs": { type: "agent", role: "review-bugs", mode: "review", brief: { ws: "$ws", plan: "$plan", previous: "$self" } },
    "rv-tests": { type: "agent", role: "review-tests", mode: "review", brief: { ws: "$ws", plan: "$plan", previous: "$self" } },
    "rv-patterns": { type: "agent", role: "review-patterns", mode: "review", brief: { ws: "$ws", plan: "$plan", previous: "$self" } },
    "rv-lore": { type: "agent", role: "review-lore", mode: "review", brief: { ws: "$ws", plan: "$plan", previous: "$self" } },
    sync: {
      type: "action",
      action: "workspace.syncBase",
      args: { ws: "$ws" },
      on: {
        same: "commit",
        rebased: { to: "checks", maxRounds: 3, exhausted: "commit" },
        conflict: { to: "fix", maxRounds: 2, exhausted: "@failed" },
      },
    },
    commit: {
      type: "agent",
      role: "committer",
      mode: "plan",
      brief: { ws: "$ws", cuts: "$implement.cuts", issue: "$run.subject" },
      on: { ok: "publish" },
    },
    publish: {
      type: "action",
      action: "pr.publish",
      args: { ws: "$ws", plan: "$commit", draft: true },
      on: { ok: "feedback", replan: { to: "commit", maxRounds: 2, exhausted: "@failed" } },
    },
    feedback: {
      type: "flow",
      flow: "pr-feedback",
      params: { ws: "$ws", pr: "$publish.pr", externalRounds: "$run.params.externalRounds" },
      on: { done: "@done", blocked: "@blocked", failed: "@failed" },
    },
  },
});

const prFeedback = FlowDef.parse({
  schema: 1,
  id: "pr-feedback",
  version: 1,
  trigger: { type: "subflow" },
  name: "Feedback del PR",
  params: { ws: "Workspace", pr: "PrRef", externalRounds: { type: "number", default: 3 } },
  start: "bot-req",
  nodes: {
    "bot-req": {
      type: "action",
      action: "review.requestBot",
      args: { pr: "$run.params.pr" },
      on: { ok: "bot-wait", none: "ci-wait" },
    },
    "bot-wait": {
      type: "wait",
      event: "pr.botReview",
      args: { pr: "$run.params.pr", after: "$prev.requestedAt" },
      timeoutSec: 540,
      on: { lgtm: "ci-wait", findings: "triage", timeout: { to: "ci-wait", note: "El bot no respondió" } },
    },
    triage: {
      type: "agent",
      role: "triage",
      mode: "bot",
      brief: { items: "$bot-wait.items" },
      on: {
        fix: {
          to: "fix",
          counter: "external",
          maxRounds: "$run.params.externalRounds",
          exhausted: { to: "reply", note: "Sin LGTM tras las rondas externas" },
        },
        reply: "reply",
      },
    },
    // `implement` es un nodo del flujo padre: un subflow ve los nodos de sus padres.
    fix: { type: "agent", role: "dev", mode: "fix", resumeFrom: "implement", brief: { input: "$prev" }, on: { ok: "checks" } },
    checks: {
      type: "action",
      action: "recipe.check",
      args: { ws: "$run.params.ws", scope: "changed" },
      on: { ok: "light", fail: { to: "fix", maxRounds: 2, exhausted: "light" } },
    },
    light: {
      type: "parallel",
      branches: ["lr-bugs", "lr-tests"],
      join: { fn: "items.merge", args: { items: "findings", rank: "severity", changesIf: ["red", "yellow"] } },
      on: { ok: "fixups", changes: { to: "fix", maxRounds: 1, exhausted: "fixups" } },
    },
    "lr-bugs": { type: "agent", role: "review-bugs", mode: "re-review", brief: { ws: "$run.params.ws" } },
    "lr-tests": {
      type: "agent",
      role: "review-tests",
      mode: "re-review",
      when: "$checks.specsChanged",
      brief: { ws: "$run.params.ws" },
    },
    fixups: {
      type: "action",
      action: "pr.pushFixups",
      args: { ws: "$run.params.ws" },
      on: { ok: "reply-fixed", route: { to: "route", maxRounds: 1, exhausted: "@failed" } },
    },
    route: { type: "agent", role: "committer", mode: "route", brief: { hunks: "$fixups.unrouted" }, on: { ok: "fixups" } },
    "reply-fixed": {
      type: "action",
      action: "pr.reply",
      args: { pr: "$run.params.pr", triage: "$triage", shas: "$fixups.byItem", rerequestBot: true },
      on: { ok: "bot-wait" },
    },
    reply: { type: "action", action: "pr.reply", args: { pr: "$run.params.pr", triage: "$triage" }, on: { ok: "ci-wait" } },
    "ci-wait": {
      type: "wait",
      event: "pr.ci",
      args: { pr: "$run.params.pr" },
      timeoutSec: 5400,
      on: { ok: "@done", fail: "ci-triage", timeout: { to: "@done", note: "CI sigue corriendo" } },
    },
    "ci-triage": {
      type: "agent",
      role: "triage",
      mode: "ci",
      brief: { items: "$ci-wait.failures" },
      on: {
        fix: {
          to: "fix",
          counter: "external",
          maxRounds: "$run.params.externalRounds",
          exhausted: { to: "@done", note: "CI rojo por el cambio" },
        },
        foreign: { to: "@done", note: "CI rojo ajeno o flaky" },
      },
    },
  },
});

describe("flujos de ejemplo", () => {
  test("la plantilla Techlead clásico y su subflujo pr-feedback validan sin errores ni avisos", () => {
    const { flows } = setup();

    expect(flows.validate(prFeedback)).toEqual({ errors: [], warnings: [] });
    flows.save(prFeedback);
    expect(flows.validate(techlead)).toEqual({ errors: [], warnings: [] });
  });

  test("el flujo válido guarda la versión 1 y al re-guardarlo sigue en 1", () => {
    const { defs, flows } = setup();
    flows.save(prFeedback);

    const first = flows.save(techlead);
    const again = flows.save(techlead);

    expect(first).toMatchObject({ version: 1, changed: true, warnings: [] });
    expect(again).toEqual({ id: first.id, version: 1, changed: false, warnings: [] });
    expect(defs.get("flow", first.id)?.body).not.toHaveProperty("version");
  });

  test("un cambio de contenido crea la versión 2, aunque el `version` del flujo diga otra cosa", () => {
    const { flows } = setup();
    flows.save(prFeedback);
    const v1 = flows.save({ ...techlead, version: 7 });

    const v2 = flows.save({ ...techlead, name: "Techlead v2" });

    expect(v1.version).toBe(1);
    expect(v2).toMatchObject({ id: v1.id, version: 2, changed: true });
  });
});

describe("flujos inválidos: una regla por caso, con su ruta", () => {
  const invalid: [string, Record<string, unknown>, string[]][] = [
    ["esquema: un nodo con tipo desconocido", { "nodes.fix.type": "teleport" }, ["nodes.fix.type"]],
    ["esquema: una clave que no existe en el formato", { "nodes.fix.colour": "red" }, ["nodes.fix"]],
    ["el nodo inicial no existe", { start: "nope" }, ["start", "nodes.check", "nodes.fix"]],
    ["un edge apunta a un nodo que no existe", { "nodes.check.on.ok": "nowhere" }, ["nodes.check.on.ok"]],
    ["el destino de exhausted no existe", { "nodes.check.on.fail.exhausted": "nowhere" }, ["nodes.check.on.fail.exhausted"]],
    ["el rol no existe", { "nodes.fix.role": "ghost" }, ["nodes.fix.role"]],
    ["el modo no existe en el rol", { "nodes.fix.mode": "ghost" }, ["nodes.fix.mode"]],
    ["la acción no está registrada", { "nodes.check.action": "ghost" }, ["nodes.check.action"]],
    ["los args de la acción no validan", { "nodes.check.args.scope": "everything" }, ["nodes.check.args.scope"]],
    ["falta un arg obligatorio de la acción", { "nodes.check.args.scope": undefined }, ["nodes.check.args.scope"]],
    ["el brief no valida con el payload del modo", { "nodes.fix.role": "review-bugs", "nodes.fix.mode": "review", "nodes.fix.brief": { ws: 5 } }, ["nodes.fix.brief.ws", "nodes.fix.on.changes"]],
    ["un ref a un nodo que no existe", { "nodes.fix.brief.input": "$ghost.out" }, ["nodes.fix.brief.input"]],
    ["un nodo se refiere a sí mismo", { "nodes.fix.brief.input": "$fix" }, ["nodes.fix.brief.input"]],
    ["un ref a un param que no está declarado", { "nodes.check.args.ws": "$run.params.ghost" }, ["nodes.check.args.ws"]],
    ["$prev en el nodo inicial", { "nodes.check.args.ws": "$prev" }, ["nodes.check.args.ws"]],
    ["$item fuera de un forEach", { "nodes.fix.brief.input": "$item" }, ["nodes.fix.brief.input"]],
    ["resumeFrom apunta a un nodo que no es agent", { "nodes.fix.resumeFrom": "check" }, ["nodes.fix.resumeFrom"]],
    ["falta el edge de un outcome posible", { "nodes.check.on.fail": undefined }, ["nodes.check.on.fail", "nodes.fix"]],
    ["un edge de un outcome que el nodo no tiene", { "nodes.check.on.weird": "@done" }, ["nodes.check.on.weird"]],
    ["un ciclo sin maxRounds ni exhausted", { "nodes.check.on.fail": "fix" }, ["nodes.check"]],
    ["maxRounds sin exhausted", { "nodes.check.on.fail.exhausted": undefined }, ["nodes.check.on.fail.exhausted", "nodes.check"]],
    ["exhausted sin maxRounds", { "nodes.check.on.fail.maxRounds": undefined }, ["nodes.check.on.fail.maxRounds", "nodes.check"]],
    ["maxRounds que no es un param", { "nodes.check.on.fail.maxRounds": "$prev" }, ["nodes.check.on.fail.maxRounds"]],
    ["maxRounds con un param que no existe", { "nodes.check.on.fail.maxRounds": "$run.params.ghost" }, ["nodes.check.on.fail.maxRounds"]],
    ["un nodo que no es alcanzable", { "nodes.orphan": { type: "action", action: "pr.reply", args: {}, on: { ok: "@done" } } }, ["nodes.orphan"]],
    ["un nodo que no llega a ningún fin", { "nodes.fix.on.ok": undefined }, ["nodes.fix.on.ok", "nodes.fix"]],
    ["un id de nodo reservado para refs", { "nodes.run": { type: "action", action: "pr.reply", args: {}, on: { ok: "@done" } }, "nodes.check.on.ok": "run" }, ["nodes.run"]],
    ["un gate con un default que no es opción", { "nodes.fix": { type: "gate", question: "?", options: [{ id: "go", label: "Seguir" }], default: "stop", timeoutSec: 60, on: { go: "check" } } }, ["nodes.fix.default"]],
    ["un gate con opciones repetidas", { "nodes.fix": { type: "gate", question: "?", options: [{ id: "go", label: "A" }, { id: "go", label: "B" }], timeoutSec: 60, on: { go: "check" } } }, ["nodes.fix.options.1.id"]],
    ["un wait que no está registrado", { "nodes.fix": { type: "wait", event: "ghost", args: {}, on: { ok: "check" } } }, ["nodes.fix.event"]],
    ["un subflujo que no existe", { "nodes.fix": { type: "flow", flow: "ghost", params: {}, on: { done: "check", blocked: "@blocked", failed: "@failed" } } }, ["nodes.fix.flow"]],
    ["un flujo que se llama a sí mismo", { "nodes.fix": { type: "flow", flow: "mini", params: {}, on: { done: "check", blocked: "@blocked", failed: "@failed" } } }, ["nodes.fix.flow"]],
  ];

  test.each(invalid)("%s", (_name, edits, expected) => {
    const { flows } = setup();

    const { errors } = flows.validate(edit(mini, edits));

    expect(errors.map((e) => e.path)).toEqual(expected);
  });

  test.each<[string, Record<string, unknown>, string[]]>([
    ["la base lineal es válida", {}, []],
    ["un ref a un nodo que no es anterior", { "nodes.first.args.ws": "$second" }, ["nodes.first.args.ws"]],
    ["when con un ref a un nodo posterior", { "nodes.first.when": "$second.go" }, ["nodes.first.when"]],
    ["un nodo que se refiere a sí mismo en when", { "nodes.first.when": "$first.x" }, ["nodes.first.when"]],
  ])("refs: %s", (_name, edits, expected) => {
    const { flows } = setup();

    const { errors } = flows.validate(edit(linear, edits));

    expect(errors.map((e) => e.path)).toEqual(expected);
  });

  const parallelMini = {
    ...mini,
    nodes: {
      ...mini.nodes,
      fix: { ...mini.nodes.fix, on: { ok: "par" } },
      par: { type: "parallel", branches: ["b1", "b2"], on: { ok: "check", changes: "@failed", fail: "@failed", error: "@failed" } },
      b1: { type: "agent", role: "review-tests", mode: "review", brief: {} },
      b2: { type: "agent", role: "review-lore", mode: "review", brief: {} },
    },
  };

  const parallelCases: [string, Record<string, unknown>, string[]][] = [
    ["la base con un parallel es válida", {}, []],
    ["una rama de parallel que no existe", { "nodes.par.branches": ["b1", "b2", "ghost"] }, ["nodes.par.branches.2"]],
    ["una rama de parallel con on", { "nodes.b1.on": { ok: "@done" } }, ["nodes.b1.on"]],
    ["una rama de parallel que es destino de un edge", { "nodes.check.on.ok": "b1" }, ["nodes.check.on.ok"]],
    ["una rama que lo es de dos parallel", { "nodes.par2": { type: "parallel", branches: ["b1"], on: { ok: "@done", changes: "@done", fail: "@done", error: "@done" } }, "nodes.check.on.ok": "par2" }, ["nodes.par2.branches.0"]],
    ["un consolidador que no está registrado", { "nodes.par.join": "ghost" }, ["nodes.par.join"]],
    ["los args del consolidador no validan", { "nodes.par.join": { fn: "items.merge", args: { items: 3 } } }, ["nodes.par.join.args.items", "nodes.par.join.args.rank", "nodes.par.join.args.changesIf", "nodes.par.on.fail"]],
    ["falta el edge de un outcome del consolidador", { "nodes.par.on.fail": undefined }, ["nodes.par.on.fail"]],
    ["rerun not-ok con un forEach", { "nodes.par.rerun": "not-ok", "nodes.par.branches": { forEach: "$check.items", branch: { type: "agent", role: "review-lore", mode: "review", brief: {} } }, "nodes.b1": undefined, "nodes.b2": undefined }, ["nodes.par.rerun"]],
    ["un forEach con una rama que usa el output de su parallel", { "nodes.par.branches": { forEach: "$check.items", branch: { type: "agent", role: "review-lore", mode: "review", brief: { x: "$par.out" } } }, "nodes.b1": undefined, "nodes.b2": undefined }, ["nodes.par.branches.branch.brief.x"]],
  ];

  test.each(parallelCases)("parallel: %s", (_name, edits, expected) => {
    const { flows } = setup();

    const { errors } = flows.validate(edit(parallelMini, edits));

    expect(errors.map((e) => e.path)).toEqual(expected);
  });

  test("parallel: la rama de un forEach ve $item y los nodos anteriores al parallel", () => {
    const { flows } = setup();
    const def = edit(parallelMini, {
      "nodes.par.branches": {
        forEach: "$check.items",
        branch: { type: "agent", role: "review-lore", mode: "review", brief: { item: "$item", ws: "$check" } },
      },
      "nodes.b1": undefined,
      "nodes.b2": undefined,
    });

    expect(flows.validate(def).errors).toEqual([]);
  });

  test("effects local rechaza una acción que publica y acepta las locales", () => {
    const { flows } = setup();
    const publishing = edit(mini, {
      effects: "local",
      "nodes.check.on.ok": "pub",
      "nodes.pub": { type: "action", action: "pr.reply", args: {}, on: { ok: "@done" } },
    });

    expect(flows.validate(edit(mini, { effects: "local" })).errors).toEqual([]);
    expect(flows.validate(publishing).errors).toEqual([
      { path: "nodes.pub.action", message: expect.stringContaining("publica") },
    ]);
  });

  test("un subflujo recibe solo los params que declara y todos los obligatorios", () => {
    const { flows } = setup();
    flows.save(prFeedback);
    const call = (params: unknown) =>
      edit(mini, {
        "nodes.fix": { type: "flow", flow: "pr-feedback", params, on: { done: "check", blocked: "@blocked", failed: "@failed" } },
      });

    expect(flows.validate(call({ ws: "$run.params.ws", pr: "x" })).errors.map((e) => e.path)).toEqual([]);
    expect(flows.validate(call({ ws: "$run.params.ws", pr: "x", ghost: 1 })).errors.map((e) => e.path)).toEqual(["nodes.fix.params.ghost"]);
    expect(flows.validate(call({ ws: "$run.params.ws" })).errors.map((e) => e.path)).toEqual(["nodes.fix.params"]);
    expect(flows.validate(edit(call("$run.params"), {})).errors.map((e) => e.path)).toEqual([]);
  });

  test("un subflujo que llama de vuelta al flujo (recursión indirecta) se rechaza con la cadena", () => {
    const { defs, flows } = setup();
    const callBack = (id: string, target: string) =>
      FlowDef.parse({
        schema: 1,
        id,
        name: id,
        trigger: { type: "subflow" },
        start: "call",
        nodes: { call: { type: "flow", flow: target, params: {}, on: { done: "@done", blocked: "@blocked", failed: "@failed" } } },
      });
    // `b` ya existe y llama a `a`; guardar `a` llamando a `b` cierra el círculo.
    defs.save({ kind: "flow", slug: "b", scope: "user", source: "ui", body: callBack("b", "a") });

    const { errors } = flows.validate(callBack("a", "b"));

    expect(errors).toEqual([{ path: "nodes.call.flow", message: "recursión de flujos: a → b → a" }]);
  });

  test("un flujo que no cumple el esquema se rechaza con la ruta del campo", () => {
    const { flows } = setup();

    const { errors } = flows.validate(edit(mini, { "nodes.check.on.ok": 42 }));

    expect(errors.map((e) => e.path)).toEqual(["nodes.check.on.ok"]);
    expect(flows.validate("no soy un flujo").errors).toHaveLength(1);
  });

  test("save no guarda nada si hay errores", () => {
    const { defs, flows } = setup();
    const broken = FlowDef.parse(edit(mini, { "nodes.check.on.ok": "nowhere" }));

    expect(() => flows.save(broken)).toThrow(FlowValidationError);
    expect(defs.list("flow")).toEqual([]);
  });
});

describe("avisos", () => {
  const withGate = (edits: Record<string, unknown> = {}) =>
    edit(mini, {
      "nodes.fix": { type: "gate", question: "¿Sigo?", options: [{ id: "go", label: "Seguir" }], on: { go: "check" } },
      ...edits,
    });

  test("un gate sin timeout avisa, y en un flujo dev avisa también por el carril", () => {
    const { flows } = setup();

    expect(flows.validate(withGate({ lane: "maintenance" }))).toEqual({
      errors: [],
      warnings: [{ path: "nodes.fix.timeoutSec", message: expect.stringContaining("estacionada") }],
    });
    expect(flows.validate(withGate()).warnings.map((w) => w.path)).toEqual(["nodes.fix.timeoutSec", "nodes.fix"]);
  });

  test("un gate con timeout en un flujo de mantenimiento no avisa", () => {
    const { flows } = setup();
    const def = withGate({ lane: "maintenance", "nodes.fix.timeoutSec": 3600 });

    expect(flows.validate(def)).toEqual({ errors: [], warnings: [] });
  });

  test("los avisos no impiden guardar y save los devuelve", () => {
    const { flows } = setup();

    const saved = flows.save(FlowDef.parse(withGate()));

    expect(saved).toMatchObject({ version: 1, changed: true });
    expect(saved.warnings.map((w) => w.path)).toEqual(["nodes.fix.timeoutSec", "nodes.fix"]);
  });
});

test("registrar dos veces la misma acción es un bug", () => {
  const { flows } = setup();

  expect(() =>
    flows.registerAction({
      name: "recipe.check",
      outcomes: [],
      effects: "local",
      args: anyArgs,
      run: () => Promise.resolve({ outcome: "ok" }),
    }),
  ).toThrow(/recipe\.check/);
});
