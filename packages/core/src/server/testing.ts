// Solo para tests de la API que no corren agentes: arma los módulos que el router necesita con un
// runtime que rechaza cualquier sesión.
import { join } from "node:path";
import { createAgents } from "../agents/agents";
import type { AgentRuntime } from "../agents/runtime";
import { createArtifacts } from "../artifacts/artifacts";
import { createDecisions } from "../decisions/decisions";
import { createLearnings } from "../learnings/learnings";
import { createDefs } from "../defs/defs";
import { createFlows, type Flows } from "../flows/flows";
import { createLegacyImporter } from "../import/legacy";
import { createPacks } from "../packs/packs";
import { createProjects } from "../projects/projects";
import { createRunStarter } from "../projects/start-run";
import { createLaneSettings } from "../scheduler/lanes";
import { createProjectQueue } from "../scheduler/project-queue";
import { createScheduler } from "../scheduler/scheduler";
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
): Pick<RouterDeps, "projects" | "packs" | "repos" | "recipeTester" | "runs" | "queue" | "scheduler" | "lanes" | "breakers" | "artifacts" | "decisions" | "learnings" | "defs" | "legacyImport"> & { flows: Flows } {
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
  const issues = createIssues(store, local);
  const runs = createRunStarter({ store, defs, projects, repos, issues, flows, trackers: { local } });
  const lanes = createLaneSettings(store);
  const scheduler = createScheduler({
    store,
    projects,
    issues,
    repos,
    trackers: { local },
    flows,
    runs,
    queue: createProjectQueue({
      store,
      projects,
      issues,
      repos,
      trackers: { local },
      prs: { get: () => Promise.reject(new Error("este test no lee PRs")) },
    }),
    // Sin repos git: este core de pruebas no arma bases combinadas.
    workspaces: { combineBase: () => Promise.reject(new Error("este core de pruebas no tiene workspaces")), dissolveBase: () => Promise.resolve() },
    lanes,
    runtime: noRuntime.id,
  });
  return {
    projects,
    packs: createPacks({ defs }),
    repos,
    recipeTester: createRecipeTester({ store, repos, slots: createSlots({ store }), dataDir }),
    runs,
    queue: scheduler.queue,
    scheduler,
    lanes,
    breakers: { list: () => [] },
    flows,
    artifacts,
    decisions: createDecisions(store),
    learnings: createLearnings(store),
    defs,
    legacyImport: createLegacyImporter({ store, defs, artifacts }),
  };
}
