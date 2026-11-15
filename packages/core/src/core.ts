import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Role } from "@clanker/api";
import { createAgents } from "./agents/agents";
import { createBriefs } from "./agents/brief";
import { createStepBriefs } from "./agents/step-brief";
import { type AgentRuntime, selectRuntime } from "./agents/runtime";
import { createArtifacts } from "./artifacts/artifacts";
import { installBuiltins } from "./builtin/install";
import { commitsApplyAction } from "./commits/apply";
import type { Connections } from "./connections/connections";
import { createDecisions } from "./decisions/decisions";
import { createDefs, type Defs } from "./defs/defs";
import { createFlows } from "./flows/flows";
import { createAskpass } from "./git/askpass";
import { createGitRemote } from "./git/remote";
import { prCommentAction, prReplyAction, prResolveThreadAction, reviewRequestBotAction } from "./github/pr-feedback";
import { prWaits } from "./github/pr-waits";
import { createPrs } from "./github/prs";
import { prPublishAction } from "./github/publish";
import { prPushFixupsAction } from "./github/push-fixups";
import { githubRemote } from "./github/remote-config";
import { createPacks } from "./packs/packs";
import { createLinearTracker } from "./linear/tracker";
import { createProcs } from "./procs/procs";
import { createProjects } from "./projects/projects";
import { createRunStarter } from "./projects/start-run";
import { createProjectQueue } from "./scheduler/project-queue";
import { createRecipes, readRecipe, type ScriptedRecipe } from "./recipe/recipe";
import { createRecipeTester } from "./recipe/recipe-test";
import { createSlots } from "./slots/slots";
import { startServer, type CoreServer, type StartServerOptions } from "./server/server";
import { newId } from "./store/conventions";
import type { Store } from "./store/store";
import { createIssues } from "./tracker/issues";
import { createLocalTracker } from "./tracker/local";
import { createRepos } from "./workspaces/repos";
import { createWorkspaces, workspaceAcquireAction, workspaceReleaseAction, workspaceSyncBaseAction } from "./workspaces/workspaces";

/** Cuánto espera el cierre a que terminen los pasos en curso antes de dejarlos atrás. */
const DRAIN_MS = 10_000;

/** Autor y committer de lo que el core hace con git en un worktree. */
const GIT_IDENTITY = { name: "Clanker Yard", email: "clanker@localhost" };

export interface StartCoreOptions extends Pick<StartServerOptions, "coreVersion" | "onShutdown" | "allowedOrigins"> {
  store: Store;
  dataDir: string;
  /** Quien arma los runtimes la comparte: `claude-sdk` pide a `claudeCredentials` su credencial en cada run. */
  connections: Connections;
  /** Los runtimes de agentes que este core conoce; `CORE_RUNTIME` elige entre ellos. */
  runtimes: readonly AgentRuntime[];
  /** De aquí sale `CORE_RUNTIME`. Por defecto, `process.env`. */
  env?: Record<string, string | undefined>;
  /** Carpeta de packs instalados (una subcarpeta por pack). Por defecto, `<dataDir>/packs`. */
  packsDir?: string;
  /** La URL de git de un repo de GitHub `owner/name`. Por defecto `https://github.com/<repo>.git`; un test la apunta a un bare local. */
  gitUrl?: (repo: string) => string;
  /** El GraphQL de Linear. Por defecto el real; un test lo apunta a `startFakeLinear`. */
  linearEndpoint?: string;
}

export interface Core {
  server: CoreServer;
  /** Cierra el servidor, deja de despachar pasos y espera un momento a los que están corriendo. No cierra el store. */
  close(): Promise<void>;
}

/**
 * Arma el core sobre un store ya abierto: Defs, Agents con el runtime elegido, Workspaces, Flows con
 * sus acciones y plantillas builtin, y la API. No toma el lock ni escribe `core.json`: eso es de
 * `runCore`, así un test levanta un core en proceso con el runtime fake.
 */
export async function startCore(opts: StartCoreOptions): Promise<Core> {
  const { store, dataDir } = opts;
  const bootId = newId("boot");
  const runtime = selectRuntime(opts.runtimes, opts.env);
  const defs = createDefs(store);
  const packs = createPacks({ defs });
  const repos = createRepos(store, { remote: githubRemote(opts.connections, opts.gitUrl) });
  const agents = createAgents({ store, defs, runtime, packs, remoteOf: (repoId) => repos.get(repoId)?.remote });
  const artifacts = createArtifacts({ store, dir: join(dataDir, "artifacts") });
  const procs = createProcs({ store, bootId });
  const slots = createSlots({ store });
  const askpass = createAskpass();
  const workspaces = createWorkspaces({
    store,
    dataDir,
    repos: repos.config,
    identity: GIT_IDENTITY,
    procs,
    remote: createGitRemote({ askpass, connections: opts.connections }),
    worktreeSetup: (dir) => readRecipe(dir)?.setup?.worktree ?? [],
  });
  const local = createLocalTracker(store);
  const issues = createIssues(store, local);
  const projects = createProjects(store, defs);
  const trackers = { local, linear: createLinearTracker({ connections: opts.connections, endpoint: opts.linearEndpoint }) };
  const flows = createFlows({
    store,
    defs,
    agents,
    artifacts,
    roles: roleInfoOf(defs),
    workspaceOf: workspaces.held,
    briefFor: createStepBriefs({ store, workspaces, briefs: createBriefs({ workspaces, artifacts }), artifacts, issues, trackers }),
    bootId,
    onClockJump: () => {
      workspaces.extendLeases();
      slots.extendLeases();
    },
  });
  const prs = createPrs({ connections: opts.connections, packs });
  const recipes = createRecipes({ store, defs, workspaces, artifacts, slots, fake: isScripted(runtime) ? runtime : undefined });
  flows.registerAction(workspaceAcquireAction(workspaces));
  flows.registerAction(workspaceReleaseAction(workspaces));
  flows.registerAction(workspaceSyncBaseAction(workspaces));
  flows.registerAction(recipes.checkAction);
  flows.registerAction(commitsApplyAction({ workspaces, recipes }));
  flows.registerAction(prPublishAction({ store, workspaces, recipes, repos: repos.config, connections: opts.connections, packs }));
  flows.registerAction(prPushFixupsAction({ store, workspaces, repos: repos.config, prs }));
  const feedback = { connections: opts.connections, packs };
  for (const action of [prCommentAction, prReplyAction, prResolveThreadAction, reviewRequestBotAction]) flows.registerAction(action(feedback));
  for (const wait of Object.values(prWaits(prs))) flows.registerWait(wait);
  installBuiltins({ defs, flows });
  // Los flujos de un pack citan acciones y waits, así que se cargan con todo registrado. Un pack roto no tumba el arranque.
  const { errors } = await packs.loadAll(opts.packsDir ?? join(dataDir, "packs"));
  for (const error of errors) {
    store.tx((tx) => tx.emit({ type: "error", origin: "core", payload: { scope: "packs.load", message: error.message } }));
  }

  // Antes de aceptar trabajo, en este orden: sin procesos de un core anterior que sigan escribiendo,
  // con los worktrees de las corridas vivas todavía suyos, y recién entonces los pasos se reabren.
  const orphans = procs.killOrphans();
  const leases = workspaces.recover() + slots.recover();
  const steps = flows.recover();
  if (orphans + leases + steps > 0) {
    store.tx((tx) => tx.emit({ type: "core.recovered", origin: "core", payload: { steps, leases, orphans } }));
  }
  // Una corrida que termina no se lleva el worktree: el flujo puede no haberlo soltado (`@done` no lo hace).
  const stopReleasing = store.events.subscribe(
    ({ runId }) => {
      if (runId) workspaces.releaseHeldBy(runId);
    },
    { types: ["run.finished"] },
  );
  const server = await startServer({
    store,
    connections: opts.connections,
    issues,
    projects,
    packs,
    repos,
    recipeTester: createRecipeTester({ store, repos, slots, dataDir, procs }),
    runs: createRunStarter({ store, defs, projects, repos, issues, flows, trackers }),
    queue: createProjectQueue({ store, projects, issues, repos, trackers, prs }),
    flows,
    artifacts,
    decisions: createDecisions(store),
    defs,
    bootId,
    coreVersion: opts.coreVersion,
    dataDir,
    onShutdown: opts.onShutdown,
    allowedOrigins: opts.allowedOrigins,
  });

  return {
    server,
    async close() {
      await server.close();
      await Promise.race([flows.close(), delay(DRAIN_MS, undefined, { ref: false })]);
      stopReleasing();
      await askpass.close();
    },
  };
}

/** Lo que Flows necesita saber de un rol para validar los agentes que lo usan. */
function roleInfoOf(defs: Defs) {
  return (id: string) => {
    const def = defs.resolve("role", id);
    if (!def) return undefined;
    const { modes } = Role.parse(def.body);
    return { modes: Object.fromEntries(Object.entries(modes).map(([name, { outcomes }]) => [name, { outcomes }])) };
  };
}

/** El runtime `fake` entrega los resultados de la receta desde su guion; los demás no tienen `nextRecipeResult`. */
function isScripted(runtime: AgentRuntime): runtime is AgentRuntime & ScriptedRecipe {
  return "nextRecipeResult" in runtime && typeof runtime.nextRecipeResult === "function";
}
