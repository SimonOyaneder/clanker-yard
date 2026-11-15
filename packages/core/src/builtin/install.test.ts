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

function setup() {
  store = openStore({ path: ":memory:" });
  const defs = createDefs(store);
  const flows = createFlows({
    store,
    defs,
    agents: createAgents({ store, defs, runtime: unusedRuntime }),
    artifacts: createArtifacts({ store, dir: "sin-uso" }),
    roles: (id) => (defs.resolve("role", id) ? { modes: { saludar: { outcomes: ["ok"] } } } : undefined),
  });
  for (const name of ["workspace.acquire", "workspace.release"]) {
    flows.registerAction({ name, outcomes: ["ok"], effects: "local", args: z.record(z.string(), z.unknown()), run: () => Promise.reject(new Error("no se usa")) });
  }
  return { defs, flows };
}

const builtin = (defs: Defs, kind: "role" | "flow") => defs.list(kind, { includeArchived: true }).find((d) => d.scope === "builtin" && d.slug === "juguete")!;

test.each(["role", "flow"] as const)("con su %s archivado, el arranque deja la plantilla fuera en vez de lanzar", (kind) => {
  const { defs, flows } = setup();
  installBuiltins({ defs, flows });
  defs.archive(kind, builtin(defs, kind).id, "ui");

  expect(() => installBuiltins({ defs, flows })).not.toThrow();
  expect(builtin(defs, kind).archivedAt).not.toBeNull();
  expect(defs.resolve(kind, "juguete")).toBeUndefined();
});
