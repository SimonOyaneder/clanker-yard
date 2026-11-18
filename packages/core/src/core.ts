import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Profile, Role, type PrRef, type PrState } from "@clanker/api";
import { createAgents } from "./agents/agents";
import { createBriefs } from "./agents/brief";
import { createStepBriefs } from "./agents/step-brief";
import { type AgentRuntime, createRuntimeRegistry, type RuntimeRegistry } from "./agents/runtime";
import { describeRuntimes } from "./agents/runtime-options";
import { createArtifacts } from "./artifacts/artifacts";
import { installBuiltins, type BuiltinTemplate } from "./builtin/install";
import { commitsApplyAction } from "./commits/apply";
import type { Connections } from "./connections/connections";
import { CLAUDE_RUNTIME_ID } from "./agents/claude/models";
import { createBreakers, repoOfScope, runtimeScope } from "./breakers/breakers";
import { environmentProbe } from "./breakers/probes";
import { createDecisions } from "./decisions/decisions";
import { createLearnings } from "./learnings/learnings";
import { createDefs, type Defs } from "./defs/defs";
import { createFlows } from "./flows/flows";
import { createAskpass } from "./git/askpass";
import { createLegacyImporter } from "./import/legacy";
import { createGitRemote } from "./git/remote";
import { ciFailureReportAction, councilThreadsAction, prBotThreadsAction, prCommentAction, prReplyAction, prResolveThreadAction, reviewRequestBotAction } from "./github/actions/pr-feedback";
import { createPrCache, type PrRow } from "./github/pr-cache";
import { prWaits, signalPr } from "./github/pr-waits";
import { createMergeScope } from "./github/merge-scope";
import { createPrs } from "./github/prs";
import { prPublishAction } from "./github/actions/publish";
import { prPromoteAction, prSaveLocalAction } from "./github/actions/promote";
import { stackRestackAction, stackRestackRewrittenAction } from "./github/actions/restack";
import { prPushFixupsAction } from "./github/actions/push-fixups";
import { prReplayAction, prSupersedeAction } from "./github/actions/replay-supersede";
import { createPrRepublisher } from "./github/republisher";
import {
  prPushLeaseAction,
  prRebaseApprovalAction,
  workspaceRebaseAction,
} from "./github/actions/rebase-pr";
import { workspaceCommitAfterRebaseAction, workspaceRebaseAbortAction } from "./workspaces/rebase-actions";
import { prRequestRebaseAction, workspaceCombinedBaseMergeAction } from "./workspaces/combined-base-actions";
import { createGitIdentityOf } from "./git/identity";
import { githubRemote } from "./github/remote-config";
import { createPacks } from "./packs/packs";
import { createLinearTracker } from "./linear/tracker";
import { createTrackers } from "./tracker/trackers";
import { createTrackerProjects } from "./tracker/tracker-projects";
import { createProcs, KILL_GROUP_AFTER_MS, type Procs } from "./procs/procs";
import { createProjectConfigs } from "./projects/config";
import { createProjects } from "./projects/projects";
import { createRepoConfigExporter } from "./repo-config/export";
import { createRepoConfigSyncer, startRepoConfigSync } from "./repo-config/sync";
import { createRunStarter } from "./projects/start-run";
import { createLaneSettings } from "./scheduler/lanes";
import { createProjectQueue } from "./scheduler/project-queue";
import { createScheduler } from "./scheduler/scheduler";
import { createStaleRoots } from "./scheduler/stale-roots";
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
import { createErrorReporter } from "./errors/reporter";
import { createTrackerChanges } from "./watch/tracker-changes";
import { startTriggers } from "./watch/triggers";
import { createWatch } from "./watch/watch";
import { startCleanup } from "./workspaces/cleanup";
import { createRepos } from "./repos/repos";
import {
  createWorkspaces,
  workspaceAcquireAction,
  workspaceAttachAction,
  workspaceCombineBaseAction,
  workspaceDiscardAction,
  workspaceReleaseAction,
  workspaceSyncBaseAction,
} from "./workspaces/workspaces";

/** Cuánto espera un apagado con `drain` a las acciones en curso antes de abortarlas (`docs/design.html#d-data`). */
const DRAIN_MS = 60_000;
/** Lo que tarda en soltarse un paso después de SIGKILL; pasado esto se deja atrás y el próximo arranque lo recupera. */
const SETTLE_MS = 5_000;

/** Con Watch encendido, cada cuánto se sondea un wait además de sus señales: la reconciliación de 10 min del diseño. */
const WATCH_SAFETY_PROBE_SEC = 600;

export interface StartCoreOptions extends Pick<StartServerOptions, "coreVersion" | "onShutdown" | "allowedOrigins" | "uiKeyHash" | "dev"> {
  store: Store;
  dataDir: string;
  /** Quien arma los runtimes la comparte: `claude-sdk` pide a `claudeCredentials` su credencial en cada run. */
  connections: Connections;
  /** Los runtimes de agentes que este core conoce: cada entrada de perfil elige el suyo y `CORE_RUNTIME` los fuerza a uno. */
  runtimes: readonly AgentRuntime[];
  /** Plantillas extra como builtin, solo para demos y tests (p. ej. `JUGUETE_TEMPLATE`): producción no pasa ninguna. */
  builtins?: readonly BuiltinTemplate[];
  /**
   * Solo tests y demo: `recipe.check` no corre los checks y consume `run.<check>` del guion del runtime fake (sus
   * `requires` sí corren: son el entorno real del repo). Producción no lo pasa.
   */
  recipeResults?: ScriptedRecipe;
  /** De aquí sale `CORE_RUNTIME`. Por defecto, `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * Quien lanza el core crea `procs` cuando un runtime necesita registrar sus procesos (`createClaudeRuntime`).
   * Sin él, el core crea el suyo.
   */
  procs?: Procs;
  /** Carpeta de packs instalados (una subcarpeta por pack). Por defecto, `<dataDir>/packs`. */
  packsDir?: string;
  /** Carpeta de packs que vienen con la app (una subcarpeta por pack). Sin ella, solo rigen los instalados. */
  factoryPacksDir?: string;
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
  /** Cómo se espera entre dos escrituras a GitHub y entre las relecturas de `mergeable` (1 s y 10 s); un test lo reemplaza para no esperar. */
  pause?: (ms: number) => Promise<void>;
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
  const runtimes = createRuntimeRegistry(opts.runtimes, opts.env);
  const defs = createDefs({ store });
  const packs = createPacks({ defs, installedDir: opts.packsDir ?? join(dataDir, "packs"), factoryDir: opts.factoryPacksDir });
  const repos = createRepos({ store, remote: githubRemote(opts.connections, opts.gitUrl) });
  const identityOf = createGitIdentityOf({ repoConfig: repos.config, connections: opts.connections });
  const agents = createAgents({ store, defs, runtimes, packs, remoteOf: (repoId) => repos.get(repoId)?.remote, identityOf });
  const artifacts = createArtifacts({ store, dir: join(dataDir, "artifacts") });
  const slots = createSlots({ store });
  const askpass = createAskpass();
  const gitRemote = createGitRemote({ askpass, connections: opts.connections, procs });
  const workspaces = createWorkspaces({
    store,
    dataDir,
    repoConfig: repos.config,
    identityOf,
    procs,
    remote: gitRemote,
    worktreeSetup: (dir) => readRecipe(dir)?.setup?.worktree ?? [],
  });
  const local = createLocalTracker({ store });
  const issues = createIssues({ store, local });
  const projects = createProjects({ store, defs });
  const trackers = createTrackers({
    local,
    connections: opts.connections,
    linear: (account) =>
      createLinearTracker({
        connections: opts.connections,
        account,
        endpoint: opts.linearEndpoint,
        statusMapping: (ref) => projects.list().find((p) => p.tracker === "linear" && p.trackerRef === ref)?.statusMapping,
      }),
  });
  const trackerProjects = createTrackerProjects({
    connections: opts.connections,
    linear: (account) => createLinearTracker({ connections: opts.connections, account, endpoint: opts.linearEndpoint }),
    projects,
  });
  const lanes = createLaneSettings({ store });
  // Un solo dedupe para todo el core; lo de Watch (y los triggers y reacciones que cuelgan de sus eventos) va bajo `watch.`.
  const reporter = createErrorReporter({ store });
  const breakers = createBreakers({
    store,
    errors: reporter,
    runtimes: runtimes.all.map((r) => r.id),
    probe: environmentProbe({ connections: opts.connections, repos, runtimes: runtimes.all }),
    ...(opts.breakerBackoffMs && { backoffMs: opts.breakerBackoffMs }),
    label: (scope) => {
      const repoId = repoOfScope(scope);
      return repoId ? `repo ${repos.get(repoId)?.name ?? scope}` : scope;
    },
  });
  // Antes de despachar nada: un breaker que dejó un corte sigue pausando lo suyo.
  breakers.start();
  // Un run real que encuentra el login de Claude vencido deja la cuenta `claude` en rojo, como un `testClaude`.
  const stopMarkingLogin = store.events.subscribe(
    ({ payload }) => {
      if (payload.scope === runtimeScope(CLAUDE_RUNTIME_ID) && payload.cause === "login_expired") opts.connections.markClaudeLoginLost("core");
    },
    { types: ["breaker.opened"] },
  );
  // El filtro de learnings pide un modelo barato de Claude: corre en `claude-sdk` salvo que `CORE_RUNTIME` fuerce otro.
  const learnings = createLearnings({ store, runtime: runtimes.forced ?? runtimes.all.find((r) => r.id === CLAUDE_RUNTIME_ID) ?? runtimes.default });
  const flows = createFlows({
    store,
    environment: { breakers, runtimeOf: runtimes.idFor },
    laneCapacity: lanes.capacity,
    defs,
    agents,
    artifacts,
    roles: roleInfoOf(defs),
    workspaceOf: workspaces.held,
    handOverWorkspaces: workspaces.handOver,
    briefFor: createStepBriefs({ store, workspaces, briefs: createBriefs({ workspaces, artifacts }), artifacts, issues, learnings, trackers, projects }),
    bootId,
    // Con Watch avisando por `signal`, el sondeo de un wait es solo la red de seguridad (cuesta GraphQL).
    ...(opts.watch && { probeEverySec: WATCH_SAFETY_PROBE_SEC }),
    onClockJump: () => {
      workspaces.extendLeases();
      slots.extendLeases();
    },
    errors: reporter,
  });
  // Antes que nada pueda terminar una corrida o soltar un worktree (también `flows.recover()`, más abajo): una corrida
  // que termina no se lleva el worktree, porque el flujo puede no haberlo soltado (`@done` no lo hace).
  const stopReleasing = store.events.subscribe(
    ({ runId }) => {
      if (runId) workspaces.releaseHeldBy(runId);
    },
    { types: ["run.finished"] },
  );
  // Un worktree cuyo PR terminó se archiva en cuanto nadie lo tiene: al soltarse el último lease (`pr.merged` y los
  // cierres sin merge llegan por `onPrChange`), y a los 7 días se borra.
  const cleanup = startCleanup({ workspaces, errors: reporter, initialPass: false });
  const stopCleaningOnRelease = store.events.subscribe(
    ({ payload }) => {
      if (payload.resource === "workspace") cleanup.request();
    },
    { types: ["lease.released"] },
  );
  const prs = createPrs({ connections: opts.connections, packs, merge: createMergeScope({ store, repos, connections: opts.connections }) });
  const watchErrors = reporter.within("watch");
  const prEvents = createPrEvents({ store, repos, workspaces, errors: watchErrors });
  /** Un PR cambió (Watch o `prs.refresh`): los waits que lo esperan y los eventos con su dedupe. */
  const onPrChange = (ref: PrRef, state: PrState, row: PrRow) => {
    signalPr(flows.signal, ref, state);
    prEvents.observe(ref, state, row);
    if (state.state === "merged" || state.state === "closed") cleanup.request();
  };
  const prCache = createPrCache({ store, repos, packs, prs, onChange: onPrChange });
  const recipes = createRecipes({ store, defs, workspaces, artifacts, slots, fake: opts.recipeResults });
  flows.registerAction(workspaceAcquireAction(workspaces));
  flows.registerAction(workspaceAttachAction(workspaces));
  flows.registerAction(workspaceReleaseAction(workspaces));
  flows.registerAction(workspaceDiscardAction(workspaces));
  flows.registerAction(workspaceSyncBaseAction(workspaces));
  flows.registerAction(workspaceCombineBaseAction(workspaces));
  flows.registerAction(recipes.checkAction);
  flows.registerAction(commitsApplyAction({ workspaces, recipes }));
  flows.registerAction(prPublishAction({ store, workspaces, recipes, repoConfig: repos.config, connections: opts.connections, packs }));
  flows.registerAction(prPromoteAction({ store, workspaces, repoConfig: repos.config, connections: opts.connections }));
  flows.registerAction(prSaveLocalAction({ store, workspaces, repoConfig: repos.config }));
  flows.registerAction(workspaceCombinedBaseMergeAction({ store, workspaces, repoConfig: repos.config }));
  flows.registerAction(prRequestRebaseAction({ store, repoConfig: repos.config }));
  flows.registerAction(prPushFixupsAction({ store, workspaces, repoConfig: repos.config, prs }));
  flows.registerAction(prReplayAction({ workspaces }));
  flows.registerAction(prSupersedeAction({ store, connections: opts.connections }));
  const rebasePr = { store, workspaces, repoConfig: repos.config, prs };
  flows.registerAction(workspaceRebaseAction(rebasePr));
  flows.registerAction(prPushLeaseAction(rebasePr));
  flows.registerAction(prRebaseApprovalAction(rebasePr));
  flows.registerAction(workspaceCommitAfterRebaseAction(workspaces));
  flows.registerAction(workspaceRebaseAbortAction(workspaces));
  const gap: { pause?: NonNullable<StartCoreOptions["pause"]> } = opts.pause ? { pause: opts.pause } : {};
  const restackDeps = { store, workspaces, repoConfig: repos.config, prs, connections: opts.connections, ...gap };
  flows.registerAction(stackRestackAction(restackDeps));
  flows.registerAction(stackRestackRewrittenAction(restackDeps));
  const feedback = { connections: opts.connections, packs, ...gap };
  for (const action of [ciFailureReportAction, councilThreadsAction, prBotThreadsAction, prCommentAction, prReplyAction, prResolveThreadAction, reviewRequestBotAction]) flows.registerAction(action(feedback));
  const headSeen = ({ repo, number }: PrRef) => {
    const registered = repos.byRemote(repo);
    const row = registered && prCache.row(registered.id, number);
    return row?.headSha && row.headChangedAt != null ? { sha: row.headSha, at: row.headChangedAt } : undefined;
  };
  for (const wait of Object.values(prWaits(prs, { headSeen }))) flows.registerWait(wait);
  installBuiltins({ defs, flows, extra: opts.builtins });
  // Los flujos de un pack citan acciones y waits, así que se cargan con todo registrado. Un pack roto no tumba el arranque.
  for (const error of (await packs.reload()).errors) reporter.report("packs.load", error);
  // Un flujo de fábrica puede no validar contra el rol que un pack guardó antes (uno viejo): con los packs ya
  // recargados se reintenta, y lo que siga sin validar queda como error, sin tumbar el arranque.
  for (const error of installBuiltins({ defs, flows, extra: opts.builtins })) reporter.report("builtins.install", error);

  // Antes de aceptar trabajo, en este orden: sin procesos de un core anterior que sigan escribiendo,
  // con los worktrees de las corridas vivas todavía suyos, y recién entonces los pasos se reabren.
  const orphans = procs.killOrphans();
  const leases = workspaces.recover() + slots.recover();
  const steps = flows.recover();
  if (orphans + leases + steps > 0) {
    store.tx((tx) => tx.emit({ type: "core.recovered", origin: "core", payload: { steps, leases, orphans } }));
  }
  // La primera pasada de limpieza, ya con los worktrees de las corridas vivas recuperados.
  cleanup.request();
  // Al devolver un sujeto prestado la branch pudo moverse: la dueña relee su `head_sha` antes de seguir.
  const stopRereading = store.events.subscribe(
    ({ payload }) => {
      workspaces.reread(payload.fromRunId).catch((error: unknown) => reporter.report("workspaces.reread", error));
    },
    { types: ["run.returned"] },
  );
  const runs = createRunStarter({ store, defs, projects, repos, issues, flows, trackers, binding: trackerProjects.binding });
  const scheduler = createScheduler({
    store,
    projects,
    issues,
    repos,
    trackers,
    binding: trackerProjects.binding,
    flows,
    runs,
    queue: createProjectQueue({ store, projects, issues, repos, trackers, prs }),
    workspaces,
    rebaseStaleRoots: createStaleRoots({ store, repos }),
    lanes,
    runtimesOf: (project) => profileRuntimes(defs, runtimes, project.defaultProfileId),
    breakers,
    errors: reporter,
  });
  const repoConfigSync = createRepoConfigSyncer({ defs, flows, repos });
  const stopRepoConfigSync = startRepoConfigSync({ syncer: repoConfigSync, repos, errors: reporter });
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
      trackers: createTrackerChanges({ projects, trackers, issues, binding: trackerProjects.binding, onChanges: () => void scheduler.tick(), errors: watchErrors }),
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
    repoConfigSync,
    repoConfigExport: createRepoConfigExporter({ store, defs, repos, config: repos.config, remote: gitRemote, connections: opts.connections, dataDir, identityOf }),
    projectConfigs: createProjectConfigs({ projects, repos, defs }),
    recipeTester: createRecipeTester({ store, repos, slots, dataDir, procs }),
    runs,
    queue: scheduler.queue,
    trackerProjects,
    // Con el Scheduler apagado (los tests que lanzan a mano, el core de demo) `system.setLanes` no lanza nada.
    scheduler: opts.scheduler === false ? { ...scheduler, tick: () => Promise.resolve() } : scheduler,
    lanes,
    breakers,
    flows,
    prs,
    prCache,
    artifacts,
    decisions: createDecisions({ store }),
    learnings,
    defs,
    agentOptions: () => describeRuntimes(runtimes),
    legacyImport: createLegacyImporter({ store, defs, artifacts }),
    republisher: createPrRepublisher({ store, repos, issues, projects, flows, connections: opts.connections, prs, fetchRepo: workspaces.fetch }),
    bootId,
    coreVersion: opts.coreVersion,
    dataDir,
    onShutdown: opts.onShutdown,
    allowedOrigins: opts.allowedOrigins,
    uiKeyHash: opts.uiKeyHash,
    dev: opts.dev,
  });
  if (opts.scheduler !== false) scheduler.start();

  return {
    server,
    async close({ drain } = { drain: false }) {
      // Primero lo que abre corridas (Watch y sus triggers, el Scheduler): un cierre no abre corridas nuevas.
      await watch.stop();
      stopTriggers();
      await stopRepoConfigSync.stop();
      mergeReactions.stop();
      const graceMs = drain ? DRAIN_MS : 0;
      await scheduler.close();
      breakers.close();
      stopMarkingLogin();
      const stopped = flows.close({ graceMs });
      // Con `drain`, hasta que las acciones terminen solas; sin él, el SIGTERM sale de inmediato.
      await Promise.race([stopped, delay(graceMs, undefined, { ref: false })]);
      await procs.stop(KILL_GROUP_AFTER_MS);
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

/**
 * Los runtimes que usan los agentes del perfil por defecto de un proyecto (su breaker pausa sus lanzamientos). Sin
 * perfil, o uno que no se lee, el runtime por defecto.
 */
function profileRuntimes(defs: Defs, runtimes: RuntimeRegistry, profileSlug: string | null): string[] {
  const body = profileSlug === null ? undefined : defs.resolve("profile", profileSlug)?.body;
  const profile = Profile.safeParse(body);
  if (!profile.success) return [runtimes.idFor(undefined)];
  return [...new Set(Object.values(profile.data.roles).map((entry) => runtimes.idFor(entry.runtime)))];
}

