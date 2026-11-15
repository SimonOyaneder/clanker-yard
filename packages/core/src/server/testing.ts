// Solo para tests de la API que no corren agentes: arma los módulos que el router necesita con un
// runtime que rechaza cualquier sesión.
import { join } from "node:path";
import { createAgents } from "../agents/agents";
import type { AgentRuntime } from "../agents/runtime";
import { createArtifacts } from "../artifacts/artifacts";
import { createDecisions } from "../decisions/decisions";
import { createDefs } from "../defs/defs";
import { createFlows } from "../flows/flows";
import { createPacks } from "../packs/packs";
import { createProjects } from "../projects/projects";
import { createRunStarter } from "../projects/start-run";
import { createRecipeTester } from "../recipe/recipe-test";
import { createSlots } from "../slots/slots";
import type { Store } from "../store/store";
import { createIssues } from "../tracker/issues";
import { createLocalTracker } from "../tracker/local";
import { createRepos } from "../workspaces/repos";
import type { RouterDeps } from "./router";

const noRuntime: AgentRuntime = {
  id: "fake",
  capabilities: { structuredOutput: true, costPerTurn: true, resume: true, fork: false, steer: false },
  start: () => Promise.reject(new Error("este test no corre agentes")),
  resume: () => Promise.reject(new Error("este test no corre agentes")),
};

export function apiDeps(
  store: Store,
  dataDir: string,
): Pick<RouterDeps, "projects" | "packs" | "repos" | "recipeTester" | "runs" | "flows" | "artifacts" | "decisions"> {
  const defs = createDefs(store);
  const artifacts = createArtifacts({ store, dir: join(dataDir, "artifacts") });
  const flows = createFlows({
    store,
    defs,
    agents: createAgents({ store, defs, runtime: noRuntime }),
    artifacts,
    roles: () => undefined,
  });
  const projects = createProjects(store, defs);
  const repos = createRepos(store);
  const local = createLocalTracker(store);
  return {
    projects,
    packs: createPacks({ defs }),
    repos,
    recipeTester: createRecipeTester({ store, repos, slots: createSlots({ store }), dataDir }),
    runs: createRunStarter({ store, defs, projects, repos, issues: createIssues(store, local), flows, trackers: { local } }),
    flows,
    artifacts,
    decisions: createDecisions(store),
  };
}
