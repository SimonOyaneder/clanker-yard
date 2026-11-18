import { createRuntimeRegistry } from "../agents/runtime";
// Solo para tests de la API que no corren agentes: arma los módulos que el router necesita con un
// runtime que rechaza cualquier sesión.
import { storedBinding } from "../tracker/tracker-projects";
import { trackersByKind } from "../tracker/trackers";
import { join } from "node:path";
import { createAgents } from "../agents/agents";
import type { AgentRuntime } from "../agents/runtime";
import { describeRuntimes } from "../agents/runtime-options";
import { createArtifacts } from "../artifacts/artifacts";
import { createDecisions } from "../decisions/decisions";
import { createLearnings } from "../learnings/learnings";
import { createDefs } from "../defs/defs";
import { createFlows, type Flows } from "../flows/flows";
import { createLegacyImporter } from "../import/legacy";
import { createPacks } from "../packs/packs";
import { createProjectConfigs } from "../projects/config";
import { createProjects } from "../projects/projects";
import { createRepoConfigSyncer } from "../repo-config/sync";
import { createRunStarter } from "../projects/start-run";
import { createLaneSettings } from "../scheduler/lanes";
import { createProjectQueue } from "../scheduler/project-queue";
import { createScheduler } from "../scheduler/scheduler";
import { createRecipeTester } from "../recipe/recipe-test";
import { createSlots } from "../slots/slots";
import type { Store } from "../store/store";
import { createIssues } from "../tracker/issues";
import { createLocalTracker } from "../tracker/local";
import { createRepos } from "../repos/repos";
import { createMergeScope } from "../github/merge-scope";
import { createPrCache } from "../github/pr-cache";
import { createPrs } from "../github/prs";
import type { Connections } from "../connections/connections";
import type { Packs } from "../packs/packs";
import type { Repos } from "../repos/repos";
import type { RouterDeps } from "../server/router";

const noRuntime: AgentRuntime = {
  id: "fake",
  capabilities: { costPerTurn: true },
  start: () => Promise.reject(new Error("este test no corre agentes")),
  resume: () => Promise.reject(new Error("este test no corre agentes")),
};

export function apiDeps(
  store: Store,
  dataDir: string,
): Pick<RouterDeps, "projects" | "packs" | "repos" | "repoConfigSync" | "repoConfigExport" | "projectConfigs" | "recipeTester" | "queue" | "trackerProjects" | "scheduler" | "lanes" | "breakers" | "artifacts" | "decisions" | "learnings" | "defs" | "legacyImport" | "republisher" | "agentOptions" | "workspaces"> & { flows: Flows } {
  const defs = createDefs({ store });
  const artifacts = createArtifacts({ store, dir: join(dataDir, "artifacts") });
  const flows = createFlows({
    store,
    defs,
    agents: createAgents({ store, defs, runtimes: createRuntimeRegistry([noRuntime], {}) }),
    artifacts,
    roles: () => undefined,
  });
  const projects = createProjects({ store, defs });
  const repos = createRepos({ store });
  const local = createLocalTracker({ store });
  const issues = createIssues({ store, local });
  const runs = createRunStarter({ store, defs, projects, repos, issues, flows, trackers: trackersByKind({ local }) });
  const lanes = createLaneSettings({ store });
  const scheduler = createScheduler({
    store,
    projects,
    issues,
    repos,
    trackers: trackersByKind({ local }),
    flows,
    runs,
    queue: createProjectQueue({
      store,
      projects,
      issues,
      repos,
      trackers: trackersByKind({ local }),
      prs: { get: () => Promise.reject(new Error("este test no lee PRs")) },
    }),
    // Sin repos git: este core de pruebas no arma bases combinadas.
    workspaces: { combineBase: () => Promise.reject(new Error("este core de pruebas no tiene workspaces")), dissolveBase: () => Promise.resolve() },
    lanes,
    runtimesOf: () => [noRuntime.id],
  });
  return {
    projects,
    packs: createPacks({ defs }),
    repos,
    workspaces: {
      fetch: () => Promise.reject(new Error("este test no trae commits del remoto")),
      fetchPr: () => Promise.reject(new Error("este test no trae commits del PR")),
    },
    repoConfigSync: createRepoConfigSyncer({ defs, flows, repos }),
    // Sin remoto ni cuenta de GitHub: este core de pruebas no exporta.
    repoConfigExport: { exportDef: () => Promise.reject(new Error("este core de pruebas no exporta al repo")) },
    projectConfigs: createProjectConfigs({ projects, repos, defs }),
    recipeTester: createRecipeTester({ store, repos, slots: createSlots({ store }), dataDir }),
    queue: scheduler.queue,
    // Sin Linear: los trackerRef se guardan tal cual, como los tests de proyectos los escriben.
    trackerProjects: { list: () => Promise.reject(new Error("este core de pruebas no lista proyectos")), resolve: (_tracker, ref) => Promise.resolve(ref), normalize: (id) => Promise.resolve(projects.get(id)!), binding: storedBinding },
    scheduler,
    lanes,
    breakers: { list: () => [], retry: () => Promise.resolve(undefined) },
    flows,
    artifacts,
    decisions: createDecisions({ store }),
    learnings: createLearnings({ store }),
    defs,
    legacyImport: createLegacyImporter({ store, defs, artifacts }),
    republisher: {
      republish: () => Promise.reject(new Error("este core de pruebas no republica PRs")),
      progress: () => Promise.reject(new Error("este core de pruebas no republica PRs")),
    },
    agentOptions: () => describeRuntimes(createRuntimeRegistry([noRuntime], {})),
  };
}

/**
 * Completa las deps del router con `prs` y `prCache` armados sobre los mismos `repos`, `connections` y `packs`
 * que recibe (como hace `startCore`), así un test que pisa alguno de ellos lee los PRs con el suyo.
 */
export function withPrs<T extends { store: Store; repos: Repos; connections: Connections; packs: Packs }>(deps: T): T & Pick<RouterDeps, "prs" | "prCache"> {
  const { store, repos, connections, packs } = deps;
  const prs = createPrs({ connections, packs, merge: createMergeScope({ store, repos, connections }) });
  return { ...deps, prs, prCache: createPrCache({ store, repos, packs, prs }) };
}
