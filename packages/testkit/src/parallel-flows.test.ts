import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileJsonSchema, FlowDef, Role, type RunId } from "@clanker/api";
import {
  clankerLoopTemplate,
  createAgents,
  createArtifacts,
  createDefs,
  createFlows,
  openStore,
  type Flows,
  type Store,
  createRuntimeRegistry,
} from "@clanker/core";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { createFakeRuntime } from "./fake-runtime";

// Los reviews en paralelo de "De issue a PR" con los roles de la plantilla clanker-loop y el
// runtime fake: el parallel, items.merge y rerun not-ok de punta a punta.

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/runs/parallel-reviews");

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** El tramo de reviews de "De issue a PR": checks → reviews (4 en paralelo) → fix → checks. */
const reviewsFlow = {
  schema: 1,
  id: "reviews",
  name: "Reviews",
  trigger: { type: "manual" },
  params: { reviewRounds: { type: "number", default: 3 } },
  start: "checks",
  nodes: {
    checks: {
      type: "action",
      action: "recipe.check",
      args: {},
      on: { ok: { to: "reviews", counter: "pass", maxRounds: 10, exhausted: "@failed" }, fail: "@failed" },
    },
    reviews: {
      type: "parallel",
      branches: ["rv-bugs", "rv-tests", "rv-patterns", "rv-lore"],
      rerun: "not-ok",
      onBranchError: "ignore",
      join: { fn: "items.merge", args: { items: "findings", rank: "severity", changesIf: ["red", "yellow"] } },
      on: {
        ok: "@done",
        changes: {
          to: "fix",
          counter: "review",
          maxRounds: "$run.params.reviewRounds",
          exhausted: { to: "@done", note: "Quedan 🔴/🟡 tras las rondas de review" },
        },
      },
    },
    ...Object.fromEntries(
      ["bugs", "tests", "patterns", "lore"].map((focus) => [
        `rv-${focus}`,
        { type: "agent", role: `review-${focus}`, mode: "review", brief: { previous: "$self" } },
      ]),
    ),
    fix: { type: "agent", role: "dev", mode: "fix", brief: { input: "$prev" }, on: { ok: "checks" } },
  },
};

function setup(): { flows: Flows; store: Store; startedRoles: string[]; prompts: Map<string, string[]> } {
  const store = openStore({ path: ":memory:" });
  const dir = mkdtempSync(join(tmpdir(), "clanker-parallel-"));
  const defs = createDefs({ store });
  const runtime = createFakeRuntime({ fixtures, speed: Infinity });
  // `createAgents` registra el validador de roles y perfiles: va antes de guardarlos.
  const agents = createAgents({ store, defs, runtimes: createRuntimeRegistry([runtime], {}) });
  for (const [slug, body] of Object.entries(clankerLoopTemplate.roles)) {
    defs.save({ kind: "role", slug, scope: "user", body, source: "ui" });
  }
  defs.save({ kind: "profile", slug: "eco", scope: "user", body: clankerLoopTemplate.profiles.eco!, source: "ui" });

  const startedRoles: string[] = [];
  const prompts = new Map<string, string[]>();
  const start = runtime.start.bind(runtime);
  runtime.start = (spec) => {
    startedRoles.push(spec.role);
    prompts.set(spec.role, [...(prompts.get(spec.role) ?? []), spec.prompt]);
    return start(spec);
  };

  const flows = createFlows({
    store,
    defs,
    agents,
    artifacts: createArtifacts({ store, dir: join(dir, "artifacts") }),
    roles: (id) => {
      const def = defs.resolve("role", id);
      if (!def) return undefined;
      const role = Role.parse(def.body);
      return {
        modes: Object.fromEntries(
          Object.entries(role.modes).map(([name, m]) => [
            name,
            { outcomes: m.outcomes, payload: m.payload ? compileJsonSchema(m.payload) : undefined },
          ]),
        ),
      };
    },
    workspaceOf: () => ({ path: dir, base: "main" }),
  });
  flows.registerAction({
    name: "recipe.check",
    args: z.object({}),
    outcomes: ["ok", "fail"],
    effects: "local",
    run: () => Promise.resolve({ outcome: "ok" }),
  });
  cleanups.push(async () => {
    await flows.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { flows, store, startedRoles, prompts };
}

function finished(store: Store, runId: RunId): Promise<void> {
  const filter = { runId, types: ["run.finished" as const, "run.parked" as const] };
  return new Promise((resolve) => {
    if (store.events.since(0, filter).length > 0) return resolve();
    const off = store.events.subscribe(() => {
      off();
      resolve();
    }, filter);
  });
}

describe("reviews en paralelo con los roles de la plantilla y el runtime fake", () => {
  test("cuatro reviewers a la vez, un solo hallazgo consolidado para el dev y en la ronda 2 solo corren los que pidieron cambios", async () => {
    const { flows, store, startedRoles, prompts } = setup();
    flows.save(FlowDef.parse(reviewsFlow));

    const runId = flows.start("reviews", { type: "issue", id: "CLA-1" }, {}, { profile: "eco" });
    await finished(store, runId);

    const view = flows.getRun(runId);
    expect(view).toMatchObject({ status: "done", outcome: "done" });
    // Ronda 1: los cuatro; ronda 2: solo bugs y tests, que dieron changes. Patterns y lore no tienen guion r2.
    expect(startedRoles.slice(0, 4).sort()).toEqual(["review-bugs", "review-lore", "review-patterns", "review-tests"]);
    expect(startedRoles.slice(4, 5)).toEqual(["dev"]);
    expect(startedRoles.slice(5).sort()).toEqual(["review-bugs", "review-tests"]);

    // El dev recibe un solo hallazgo, el rojo de tests: el amarillo de bugs es el mismo y pierde, el nit sin trivial se descarta.
    const [devPrompt = ""] = prompts.get("dev") ?? [];
    expect(devPrompt).toContain("El monto negativo no tiene test");
    expect(devPrompt).not.toContain("Falta validar el monto");
    expect(devPrompt).not.toContain("Nombre poco claro");
    // El ⚪ trivial de lore pasa el consolidador: viaja con su id estable.
    expect(devPrompt).toContain("Typo");
    expect(devPrompt.indexOf("El monto negativo")).toBeLessThan(devPrompt.indexOf("Typo"));

    expect(view.rounds).toEqual({ pass: 2, review: 1 });
    expect(view.steps.filter((s) => s.nodeId === "reviews").map((s) => s.outcome)).toEqual(["changes", "ok"]);
  });
});
