import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Role, type PrRef, type PrState, type RunId } from "@clanker/api";
import { createAgents } from "./agents/agents";
import { createBriefs } from "./agents/brief";
import { createStepBriefs } from "./agents/step-brief";
import { type AgentRuntime, selectRuntime } from "./agents/runtime";
import { createArtifacts } from "./artifacts/artifacts";
import { installBuiltins } from "./builtin/install";
import { commitsApplyAction } from "./commits/apply";
import type { Connections } from "./connections/connections";
import { createBreakers } from "./breakers/breakers";
import { environmentProbe } from "./breakers/probes";
import { createDecisions } from "./decisions/decisions";
import { createLearnings } from "./learnings/learnings";
import { createDefs, type Defs } from "./defs/defs";
import { createFlows } from "./flows/flows";
import { createAskpass } from "./git/askpass";
import { createLegacyImporter } from "./import/legacy";
import { createGitRemote } from "./git/remote";
import { councilThreadsAction, prCommentAction, prReplyAction, prResolveThreadAction, reviewRequestBotAction } from "./github/pr-feedback";
import { createPrCache, type PrRow } from "./github/pr-cache";
import { prWaits, signalPr } from "./github/pr-waits";
import { createMergeScope } from "./github/merge-scope";
import { createPrs } from "./github/prs";
import { prPublishAction } from "./github/publish";
import { stackRestackAction, stackRestackRewrittenAction } from "./github/restack";
import { prPushFixupsAction } from "./github/push-fixups";
import {
  prPushLeaseAction,
  prRebaseApprovalAction,
  workspaceCommitAfterRebaseAction,
  workspaceRebaseAbortAction,
  workspaceRebaseAction,
} from "./github/rebase-pr";
import { githubRemote } from "./github/remote-config";
import { createPacks } from "./packs/packs";
import { createLinearTracker } from "./linear/tracker";
import { createProcs, type Procs } from "./procs/procs";
import { createProjects } from "./projects/projects";
import { createRunStarter } from "./projects/start-run";
import { createLaneSettings } from "./scheduler/lanes";
import { createProjectQueue } from "./scheduler/project-queue";
import { createScheduler } from "./scheduler/scheduler";
import { createRecipes, readRecipe, type ScriptedRecipe } from "./recipe/recipe";
import { createRecipeTester } from "./recipe/recipe-test";
import { createSlots } from "./slots/slots";
import { startServer, type CoreServer, type StartServerOptions } from "./server/server";
import { newId } from "./store/conventions";
import type { Store } from "./store/store";
import { createIssues } from "./tracker/issues";
import { createLocalTracker } from "./tracker/local";
import { createPrEvents } from "./watch/events";
import { startMergeReactions } from "./watch/merge-reactions";
import { createErrorReporter } from "./watch/report";
import { createTrackerChanges } from "./watch/tracker-changes";
import { startTriggers } from "./watch/triggers";
import { createWatch } from "./watch/watch";
import { startCleanup } from "./workspaces/cleanup";
import { createRepos } from "./workspaces/repos";
import {
  createWorkspaces,
  workspaceAcquireAction,
  workspaceAttachAction,
  workspaceCombineBaseAction,
  workspaceReleaseAction,
  workspaceSyncBaseAction,
} from "./workspaces/workspaces";

/** Cuánto espera un apagado con `drain` a las acciones en curso antes de abortarlas (`docs/design.html#d-data`). */
const DRAIN_MS = 60_000;
/** De SIGTERM a SIGKILL sobre los procesos que lanzó el core. */
const KILL_AFTER_MS = 10_000;
/** Lo que tarda en soltarse un paso después de SIGKILL; pasado esto se deja atrás y el próximo arranque lo recupera. */
const SETTLE_MS = 5_000;

/** Con Watch encendido, cada cuánto se sondea un wait además de sus señales: la reconciliación de 10 min del diseño. */
const WATCH_SAFETY_PROBE_SEC = 600;

/** Autor y committer de lo que el core hace con git en un worktree. */
const GIT_IDENTITY = { name: "Clanker Yard", email: "clanker@localhost" };

export interface StartCoreOptions extends Pick<StartServerOptions, "coreVersion" | "onShutdown" | "allowedOrigins" | "uiKeyHash"> {
  store: Store;
  dataDir: string;
  /** Quien arma los runtimes la comparte: `claude-sdk` pide a `claudeCredentials` su credencial en cada run. */
  connections: Connections;
  /** Los runtimes de agentes que este core conoce; `CORE_RUNTIME` elige entre ellos. */
  runtimes: readonly AgentRuntime[];
  /** De aquí sale `CORE_RUNTIME`. Por defecto, `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * Quien lanza el core crea `procs` cuando un runtime necesita registrar sus procesos (`createClaudeRuntime`).
   * Sin él, el core crea el suyo.
   */
  procs?: Procs;
  /** Carpeta de packs instalados (una subcarpeta por pack). Por defecto, `<dataDir>/packs`. */
  packsDir?: string;
  /** La URL de git de un repo de GitHub `owner/name`. Por defecto `https://github.com/<repo>.git`; un test la apunta a un bare local. */
  gitUrl?: (repo: string) => string;
  /**
   * El Scheduler lanza solo las issues de la cola de cada proyecto (`docs/design.html#d-ops`). Con `false`
   * un test lanza las corridas a mano con `runs.start`. Por defecto `true`.
   */
  scheduler?: boolean;
  /** El GraphQL de Linear. Por defecto el real; un test lo apunta a `startFakeLinear`. */
  linearEndpoint?: string;
  /**
   * Enciende Watch, el polling de PRs (`watch.start()`). Es lo que corre el core real (`runCore`); por defecto
   * está apagado para que un test que levanta el core contra el GitHub simulado no reciba requests que no pidió.
   */
  watch?: boolean;
  /** Los ms entre las pruebas de un circuit breaker (por defecto 1, 5, 15 y 30 min): un test los acorta para no esperar un minuto. */
  breakerBackoffMs?: readonly number[];
}

export interface Core {
  server: CoreServer;
  /**
   * El apagado limpio (`docs/design.html#d-data`): deja de despachar, interrumpe a los agentes, con `drain`
   * espera hasta 60 s a las acciones en curso (sin él las aborta de una vez), manda SIGTERM al grupo de cada
   * proceso que lanzó el core y SIGKILL a los 10 s, devuelve los pasos cortados a pending con su sesión,
   * y recién entonces cierra el servidor. El servidor sigue contestando mientras tanto, así un cliente
   * que consulta ve un core vivo y no uno que se fue sin avisar. No cierra el store.
   */
  close(opts?: { drain: boolean }): Promise<void>;
}

/**
 * Arma el core sobre un store ya abierto: Defs, Agents con el runtime elegido, Workspaces, Flows con
 * sus acciones y plantillas builtin, y la API. No toma el lock ni escribe `core.json`: eso es de
 * `runCore`, así un test levanta un core en proceso con el runtime fake.
 */
export async function startCore(opts: StartCoreOptions): Promise<Core> {
  const { store, dataDir } = opts;
  const procs = opts.procs ?? createProcs({ store, bootId: newId("boot") });
  const { bootId } = procs;
  const runtime = selectRuntime(opts.runtimes, opts.env);
  const defs = createDefs(store);
  const packs = createPacks({ defs });
  const repos = createRepos(store, { remote: githubRemote(opts.connections, opts.gitUrl) });
  const agents = createAgents({ store, defs, runtime, packs, remoteOf: (repoId) => repos.get(repoId)?.remote });
  const artifacts = createArtifacts({ store, dir: join(dataDir, "artifacts") });
  const slots = createSlots({ store });
  const askpass = createAskpass();
  const gitRemote = createGitRemote({ askpass, connections: opts.connections, procs });
  const workspaces = createWorkspaces({
    store,
    dataDir,
    repos: repos.config,
    identity: GIT_IDENTITY,
    procs,
    remote: gitRemote,
    worktreeSetup: (dir) => readRecipe(dir)?.setup?.worktree ?? [],
  });
  const local = createLocalTracker(store);
  const issues = createIssues(store, local);
  const projects = createProjects(store, defs);
  const trackers = {
    local,
    linear: createLinearTracker({
      connections: opts.connections,
      endpoint: opts.linearEndpoint,
      statusMapping: (ref) => projects.list().find((p) => p.tracker === "linear" && p.trackerRef === ref)?.statusMapping,
    }),
  };
  const lanes = createLaneSettings(store);
  const breakers = createBreakers({
    store,
    runtime: runtime.id,
    probe: environmentProbe({ connections: opts.connections, repos, runtime: runtime.id }),
    ...(opts.breakerBackoffMs && { backoffMs: opts.breakerBackoffMs }),
    label: (scope) => (scope.startsWith("repo:") ? `repo ${repos.get(scope.slice("repo:".length))?.name ?? scope}` : scope),
  });
  // Antes de despachar nada: un breaker que dejó un corte sigue pausando lo suyo.
  breakers.start();
  // Un run real que encuentra el login de Claude vencido deja la cuenta `claude` en rojo, como un `testClaude`.
  const stopMarkingLogin = store.events.subscribe(
    ({ payload }) => {
      if (runtime.id === "claude-sdk" && payload.cause === "login_expired") opts.connections.markClaudeLoginLost("core");
    },
    { types: ["breaker.opened"] },
  );
  const learnings = createLearnings(store);
  const flows = createFlows({
    store,
    environment: { breakers, runtime: runtime.id },
    laneCapacity: lanes.capacity,
    defs,
    agents,
    artifacts,
    roles: roleInfoOf(defs),
    workspaceOf: workspaces.held,
    handOverWorkspaces: workspaces.handOver,
    briefFor: createStepBriefs({ store, workspaces, briefs: createBriefs({ workspaces, artifacts }), artifacts, issues, learnings, trackers }),
    bootId,
    // Con Watch avisando por `signal`, el sondeo de un wait es solo la red de seguridad (cuesta GraphQL).
    ...(opts.watch && { probeEverySec: WATCH_SAFETY_PROBE_SEC }),
    onClockJump: () => {
      workspaces.extendLeases();
      slots.extendLeases();
    },
  });
  const prs = createPrs({ connections: opts.connections, packs, merge: createMergeScope({ store, repos, connections: opts.connections }) });
  const watchErrors = createErrorReporter(store);
  const prEvents = createPrEvents({ store, repos, workspaces, errors: watchErrors });
  /** Un PR cambió (Watch o `prs.refresh`): los waits que lo esperan y los eventos con su dedupe. */
  const onPrChange = (ref: PrRef, state: PrState, row: PrRow) => {
    signalPr(flows.signal, ref, state);
    prEvents.observe(ref, state, row);
    if (state.state === "merged" || state.state === "closed") cleanup.request();
  };
  const prCache = createPrCache({ store, repos, packs, prs, onChange: onPrChange });
  const recipes = createRecipes({ store, defs, workspaces, artifacts, slots, fake: isScripted(runtime) ? runtime : undefined });
  flows.registerAction(workspaceAcquireAction(workspaces));
  flows.registerAction(workspaceAttachAction(workspaces));
  flows.registerAction(workspaceReleaseAction(workspaces));
  flows.registerAction(workspaceSyncBaseAction(workspaces));
  flows.registerAction(workspaceCombineBaseAction(workspaces));
  flows.registerAction(recipes.checkAction);
  flows.registerAction(commitsApplyAction({ workspaces, recipes }));
  flows.registerAction(prPublishAction({ store, workspaces, recipes, repos: repos.config, connections: opts.connections, packs }));
  flows.registerAction(prPushFixupsAction({ store, workspaces, repos: repos.config, prs }));
  const rebasePr = { store, workspaces, repos: repos.config, prs };
  flows.registerAction(workspaceRebaseAction(rebasePr));
  flows.registerAction(prPushLeaseAction(rebasePr));
  flows.registerAction(prRebaseApprovalAction(rebasePr));
  flows.registerAction(workspaceCommitAfterRebaseAction(rebasePr));
  flows.registerAction(workspaceRebaseAbortAction(rebasePr));
  const restackDeps = { store, workspaces, repos: repos.config, prs, connections: opts.connections };
  flows.registerAction(stackRestackAction(restackDeps));
  flows.registerAction(stackRestackRewrittenAction(restackDeps));
  const feedback = { connections: opts.connections, packs };
  for (const action of [councilThreadsAction, prCommentAction, prReplyAction, prResolveThreadAction, reviewRequestBotAction]) flows.registerAction(action(feedback));
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
  // Un worktree cuyo PR terminó se archiva en cuanto nadie lo tiene: al soltarse el último lease (`pr.merged` y los
  // cierres sin merge llegan por `onPrChange`), y a los 7 días se borra.
  const cleanup = startCleanup({ workspaces, errors: watchErrors });
  const stopCleaningOnRelease = store.events.subscribe(
    ({ payload }) => {
      if (payload.resource === "workspace") cleanup.request();
    },
    { types: ["lease.released"] },
  );
  // Al devolver un sujeto prestado la branch pudo moverse: la dueña relee su `head_sha` antes de seguir.
  const stopRereading = store.events.subscribe(
    ({ payload }) => {
      workspaces.reread(payload.fromRunId as RunId).catch((error: unknown) => {
        store.tx((tx) => tx.emit({ type: "error", origin: "core", payload: { scope: "workspaces.reread", message: String(error) } }));
      });
    },
    { types: ["run.returned"] },
  );
  const runs = createRunStarter({ store, defs, projects, repos, issues, flows, trackers });
  const scheduler = createScheduler({
    store,
    projects,
    issues,
    repos,
    trackers,
    flows,
    runs,
    queue: createProjectQueue({ store, projects, issues, repos, trackers, prs }),
    workspaces,
    lanes,
    runtime: runtime.id,
    breakers,
  });
  const stopTriggers = startTriggers({ store, defs, projects, repos, flows, errors: watchErrors });
  const mergeReactions = startMergeReactions({ store, repos, packs, prs, connections: opts.connections, errors: watchErrors });
  const watch = createWatch({
    store,
    connections: opts.connections,
    repos,
    cache: prCache,
    remote: gitRemote,
    waitKeys: flows.waitKeys,
    events: prEvents,
    errors: watchErrors,
    // Con el Scheduler apagado (los tests que lanzan a mano) un cambio del tracker no lanza nada.
    ...(opts.scheduler !== false && {
      trackers: createTrackerChanges({ projects, trackers, issues, onChanges: () => void scheduler.tick(), errors: watchErrors }),
    }),
  });
  if (opts.watch) watch.start();
  const server = await startServer({
    store,
    connections: opts.connections,
    issues,
    projects,
    packs,
    repos,
    recipeTester: createRecipeTester({ store, repos, slots, dataDir, procs }),
    runs,
    queue: scheduler.queue,
    scheduler,
    lanes,
    breakers,
    flows,
    onPrChange,
    artifacts,
    decisions: createDecisions(store),
    learnings,
    defs,
    legacyImport: createLegacyImporter({ store, defs }),
    bootId,
    coreVersion: opts.coreVersion,
    dataDir,
    onShutdown: opts.onShutdown,
    allowedOrigins: opts.allowedOrigins,
    uiKeyHash: opts.uiKeyHash,
  });
  if (opts.scheduler !== false) scheduler.start();

  return {
    server,
    async close({ drain } = { drain: false }) {
      await watch.stop();
      // Como el Scheduler: un cierre no abre corridas nuevas.
      stopTriggers();
      mergeReactions.stop();
      const graceMs = drain ? DRAIN_MS : 0;
      // Antes de apagar el motor: un cierre no abre corridas nuevas.
      await scheduler.close();
      breakers.close();
      stopMarkingLogin();
      const stopped = flows.close({ graceMs });
      // Con `drain`, hasta que las acciones terminen solas; sin él, el SIGTERM sale de inmediato.
      await Promise.race([stopped, delay(graceMs, undefined, { ref: false })]);
      await procs.stop(KILL_AFTER_MS);
      await Promise.race([stopped, delay(SETTLE_MS, undefined, { ref: false })]);
      await server.close();
      stopReleasing();
      stopRereading();
      stopCleaningOnRelease();
      await cleanup.stop();
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
