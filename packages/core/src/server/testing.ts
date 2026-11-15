// Solo para tests de la API que no corren agentes: arma los módulos que el router necesita con un
// runtime que rechaza cualquier sesión.
import { join } from "node:path";
import { createAgents } from "../agents/agents";
import type { AgentRuntime } from "../agents/runtime";
import { createArtifacts } from "../artifacts/artifacts";
import { createDefs } from "../defs/defs";
import { createFlows } from "../flows/flows";
import { createProjects } from "../projects/projects";
import type { Store } from "../store/store";
import type { RouterDeps } from "./router";

const noRuntime: AgentRuntime = {
  id: "fake",
  capabilities: { structuredOutput: true, costPerTurn: true, resume: true, fork: false, steer: false },
  start: () => Promise.reject(new Error("este test no corre agentes")),
  resume: () => Promise.reject(new Error("este test no corre agentes")),
};

export function apiDeps(store: Store, dataDir: string): Pick<RouterDeps, "projects" | "flows" | "artifacts"> {
  const defs = createDefs(store);
  const artifacts = createArtifacts({ store, dir: join(dataDir, "artifacts") });
  const flows = createFlows({
    store,
    defs,
    agents: createAgents({ store, defs, runtime: noRuntime }),
    artifacts,
    roles: () => undefined,
  });
  return { projects: createProjects(store, defs), flows, artifacts };
}
