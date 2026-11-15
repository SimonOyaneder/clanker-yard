import { Role } from "@clanker/api";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { createAgents } from "../agents/agents";
import type { AgentRuntime } from "../agents/runtime";
import { createArtifacts } from "../artifacts/artifacts";
import { createDefs, type Defs } from "../defs/defs";
import { createFlows } from "../flows/flows";
import { openStore, type Store } from "../store/store";
import { installBuiltins } from "./install";

let store: Store | undefined;
afterEach(() => store?.close());

/** Solo se guardan defs: ningún paso corre. */
const unusedRuntime: AgentRuntime = {
  id: "fake",
  capabilities: { structuredOutput: true, costPerTurn: true, resume: true, fork: false, steer: false },
  start: () => Promise.reject(new Error("no se usa")),
  resume: () => Promise.reject(new Error("no se usa")),
};

/** Las acciones y los waits que citan las plantillas, con los outcomes de su diseño. */
const ACTIONS = {
  "workspace.acquire": ["ok"],
  "workspace.release": ["ok"],
  "workspace.syncBase": ["same", "rebased", "conflict"],
  "recipe.check": ["ok", "fail"],
  "pr.publish": ["ok", "replan"],
  "pr.pushFixups": ["ok", "route"],
  "workspace.attach": ["ok"],
  "workspace.rebase": ["clean", "conflict", "error"],
  "workspace.rebaseAbort": ["ok"],
  "workspace.commitAfterRebase": ["ok"],
  "pr.pushLease": ["draft", "ready"],
  "pr.rebaseApproval": ["proceed", "ask"],
  "pr.reply": ["ok"],
  "review.requestBot": ["ok", "none"],
  "stack.restackRewritten": ["ok", "conflict"],
};
const WAITS = { "pr.botReview": ["lgtm", "findings"], "pr.ci": ["ok", "fail"] };

function setup() {
  store = openStore({ path: ":memory:" });
  const defs = createDefs(store);
  const flows = createFlows({
    store,
    defs,
    agents: createAgents({ store, defs, runtime: unusedRuntime }),
    artifacts: createArtifacts({ store, dir: "sin-uso" }),
    roles: (id) => {
      const def = defs.resolve("role", id);
      if (!def) return undefined;
      const { modes } = Role.parse(def.body);
      return { modes: Object.fromEntries(Object.entries(modes).map(([name, { outcomes }]) => [name, { outcomes }])) };
    },
  });
  const args = z.record(z.string(), z.unknown());
  for (const [name, outcomes] of Object.entries(ACTIONS)) {
    flows.registerAction({ name, outcomes, effects: "local", args, run: () => Promise.reject(new Error("no se usa")) });
  }
  for (const [name, outcomes] of Object.entries(WAITS)) {
    flows.registerWait({ name, outcomes, args, key: () => name, match: () => undefined, probe: () => Promise.reject(new Error("no se usa")) });
  }
  return { defs, flows };
}

const builtin = (defs: Defs, kind: "role" | "flow", slug: string) =>
  defs.list(kind, { includeArchived: true }).find((d) => d.scope === "builtin" && d.slug === slug)!;

test("instala juguete y el equipo clanker-loop (sus roles, perfiles y los flujos techlead-clasico, pr-feedback, rebase-conflicto y restack-rewritten) y repetirlo no suma versiones", () => {
  const { defs, flows } = setup();

  installBuiltins({ defs, flows });
  const versions = store!.events.since(0, { types: ["def.versioned"] }).length;
  installBuiltins({ defs, flows });

  expect(defs.resolve("flow", "techlead-clasico")).toMatchObject({ scope: "builtin" });
  expect(defs.resolve("flow", "pr-feedback")).toMatchObject({ scope: "builtin" });
  expect(defs.resolve("flow", "rebase-conflicto")).toMatchObject({ scope: "builtin" });
  expect(defs.resolve("flow", "restack-rewritten")).toMatchObject({ scope: "builtin" });
  expect(defs.resolve("flow", "juguete")).toMatchObject({ scope: "builtin" });
  expect(defs.resolve("role", "committer")).toMatchObject({ scope: "builtin" });
  expect(defs.resolve("profile", "eco")).toMatchObject({ scope: "builtin" });
  expect(store!.events.since(0, { types: ["def.versioned"] })).toHaveLength(versions);
});

test.each([
  ["role", "juguete"],
  ["flow", "juguete"],
  ["role", "committer"],
  ["flow", "pr-feedback"],
] as const)("con su %s %s archivado, el arranque deja esa plantilla fuera en vez de lanzar", (kind, slug) => {
  const { defs, flows } = setup();
  installBuiltins({ defs, flows });
  defs.archive(kind, builtin(defs, kind, slug).id, "ui");

  expect(() => installBuiltins({ defs, flows })).not.toThrow();
  expect(builtin(defs, kind, slug).archivedAt).not.toBeNull();
  expect(defs.resolve(kind, slug)).toBeUndefined();
});
