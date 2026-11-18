import type { PrChats } from "../chats/chats";
import { API_MAJOR, type AgentOptions, type ClientOrigin, contract, type ProjectId, type RunId, type StepRunId } from "@clanker/api";
import { ORPCError, implement, withEventMeta } from "@orpc/server";
import { githubPatForm } from "../github/pat";
import type { PrCache } from "../github/pr-cache";
import { createPrCommands} from "../github/pr-commands";
import { createPrDetails } from "../github/pr-detail";
import { createLocalPublish } from "../github/local-publish";
import type { Workspaces } from "../workspaces/workspaces";
import type { Prs } from "../github/prs";
import type { PrRepublisher } from "../github/republisher";
import { type Connections } from "../connections/connections";
import { createTranscripts} from "../agents/transcripts";
import type { Breakers } from "../breakers/breakers";
import type { Artifacts } from "../artifacts/artifacts";
import type { Decisions } from "../decisions/decisions";
import { LearningNotFoundError, type Learnings } from "../learnings/learnings";
import type { Engine } from "../flows/engine";
import type { Flows } from "../flows/flows";
import { DecisionNotFoundError } from "../flows/engine-shared";
import { createStepDetails} from "../flows/step-detail";
import { type LegacyImporter } from "../import/legacy";
import { createMetrics } from "../metrics/metrics";
import { type Packs } from "../packs/packs";
import { type Defs } from "../defs/defs";
import { createDefWriter} from "../defs/write";
import { ProjectNotFoundError, type Projects } from "../projects/projects";
import type { ProjectConfigs } from "../projects/config";
import { type RepoConfigExporter } from "../repo-config/export";
import type { RepoConfigSyncer } from "../repo-config/sync";
import type { LaneSettings } from "../scheduler/lanes";
import { type ProjectQueue } from "../scheduler/project-queue";
import { type Scheduler } from "../scheduler/scheduler";
import { type RecipeTester } from "../recipe/recipe-test";
import { readSchemaVersion } from "../store/migrate";
import type { Store } from "../store/store";
import type { Issues } from "../tracker/issues";
import { TrackerProjectsError, type TrackerProjects } from "../tracker/tracker-projects";
import { defaultLogDir } from "../workspaces/exec";
import { type Repos } from "../repos/repos";
import { isMergeOffer } from "../watch/merge-reactions";
import { eventsAfter } from "./event-stream";
import { mapApiErrors } from "./api-errors";
import { requireUiOrigin } from "../errors/domain";

/** Lo que cada llamada trae consigo, venga por HTTP o en proceso (`createRouterClient`, MCP). */
export interface CoreContext {
  origin: ClientOrigin;
  /** La request trajo la llave de la app (el servidor ya la verificó). Solo `system.health` lo informa. */
  uiKey?: boolean;
}

export interface RouterDeps {
  store: Store;
  /** El chat de cada PR (`chats/chats.ts`); sin él, `chats.*` responde que no está disponible. */
  chats?: PrChats;
  connections: Connections;
  issues: Issues;
  projects: Projects;
  packs: Packs;
  repos: Repos;
  /** `repos.syncConfig`. */
  repoConfigSync: RepoConfigSyncer;
  /** `defs.exportToRepo`. */
  repoConfigExport: RepoConfigExporter;
  /** `projects.exportConfig` y `projects.importConfig`. */
  projectConfigs: ProjectConfigs;
  recipeTester: RecipeTester;
  /** `projects.queue`. */
  queue: ProjectQueue;
  /** `trackers.projects`. */
  trackerProjects: TrackerProjects;
  /** `projects.skipIssue`, y el tick que `system.setLanes` pide para repartir el cupo que liberó. */
  scheduler: Pick<Scheduler, "runNow" | "skipIssue" | "boostIssue" | "tick">;
  /** `system.lanes` y `system.setLanes`. */
  lanes: LaneSettings;
  /** `system.breakers` y `system.retryBreaker`. */
  breakers: Pick<Breakers, "list" | "retry">;
  flows: Flows;
  /** `prs.get` y lo que leen las acciones sobre un PR: el mismo que usan los waits del core. */
  prs: Prs;
  /** `prs.list` y `prs.refresh`: el caché del core, que avisa a los waits y a los eventos de Watch cuando un PR cambia. */
  prCache: PrCache;
  workspaces: Pick<Workspaces, "fetch" | "fetchPr">;
  artifacts: Artifacts;
  decisions: Decisions;
  learnings: Learnings;
  defs: Defs;
  /** `defs.agentOptions`: lo que cada runtime ofrece a un perfil (`describeRuntimes`). */
  agentOptions(): Promise<AgentOptions>;
  /** `imports.legacy`. */
  legacyImport: LegacyImporter;
  /** `prs.republish`. */
  republisher: PrRepublisher;
  coreVersion: string;
  bootId: string;
  /** ms epoch */
  startedAt: number;
  dataDir: string;
  /** Quien lanzó el core decide cómo apagarlo; `system.shutdown` solo lo pide. */
  onShutdown(opts: { drain: boolean }): void;
}

const os = implement(contract).$context<CoreContext>().use(mapApiErrors);

export function createRouter(deps: RouterDeps) {
  const { store } = deps;
  const schemaVersion = readSchemaVersion(store.db.$client);
  const { artifacts, flows, projects, repos, recipeTester } = deps;
  const metrics = createMetrics({ store });
  const defWriter = createDefWriter({ defs: deps.defs, flows: deps.flows });
  const stepDetails = createStepDetails({ store, logDir: defaultLogDir(deps.dataDir) });
  const transcripts = createTranscripts({ store, home: deps.dataDir });
  const { prs, prCache } = deps;
  const chatsOf = () => {
    if (!deps.chats) throw new ORPCError("NOT_IMPLEMENTED", { message: "Este core no tiene el chat de PRs." });
    return deps.chats;
  };
  const prDetails = createPrDetails({ store, repoConfig: (id) => repos.config(id), connections: deps.connections, workspaces: deps.workspaces });
  const prCommands = createPrCommands({ store, repos, connections: deps.connections, packs: deps.packs, prs, cache: prCache, flows, projects });
  const localPublish = createLocalPublish({ store, repos, flows });
  const projectOrNotFound = (id: ProjectId) => {
    const project = projects.get(id);
    if (!project) throw new ProjectNotFoundError(id);
    return project;
  };
  /** `runs.pause|resume|cancel|interrupt`: el comando y la corrida como quedó. */
  const controlRun = (id: RunId, cmd: "pause" | "resume" | "cancel", by: ClientOrigin, now?: boolean) => {
    flows.control(id, cmd, by, { now });
    return flows.getRun(id);
  };
  /** `runs.retryStep|steerStep|forceOutcome`: el comando y la corrida del paso como quedó. */
  const commandStep = (stepId: StepRunId, cmd: Parameters<Engine["stepCommand"]>[1], by: ClientOrigin) =>
    flows.getRun(flows.stepCommand(stepId, cmd, by));
  const platform = process.platform;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    throw new Error(
      `Plataforma no soportada: ${platform}. El core corre en macOS, Linux y Windows.`,
    );
  }

  return os.router({
    system: {
      health: os.system.health.handler(({ context }) => ({
        coreVersion: deps.coreVersion,
        apiMajor: API_MAJOR,
        schemaVersion,
        bootId: deps.bootId,
        // Las que están trabajando o por trabajar, sin las que esperan a una persona (`parked`, `paused`).
        activeRuns: flows.listRuns({ status: ["queued", "running", "waiting"] }).length,
        uiKey: context.uiKey === true,
      })),
      info: os.system.info.handler(() => ({
        pid: process.pid,
        startedAt: deps.startedAt,
        dataDir: deps.dataDir,
        platform,
        linearClientId: deps.connections.linearClientId,
        githubApp: deps.connections.githubAppConfigured,
      })),
      lanes: os.system.lanes.handler(() => deps.lanes.usage()),
      breakers: os.system.breakers.handler(() => deps.breakers.list()),
      retryBreaker: os.system.retryBreaker.handler(async ({ input }) => (await deps.breakers.retry(input.scope)) ?? null),
      setLanes: os.system.setLanes.handler(({ input, context }) => {
        deps.lanes.set(input, context.origin);
        void deps.scheduler.tick();
        return deps.lanes.usage();
      }),
      shutdown: os.system.shutdown.handler(({ input, context }) => {
        store.tx((tx) =>
          tx.emit({
            type: "core.stopping",
            origin: context.origin,
            payload: { reason: "system.shutdown" },
          }),
        );
        deps.onShutdown({ drain: input.drain });
      }),
    },
    connections: {
      list: os.connections.list.handler(() => deps.connections.list()),
      setPat: os.connections.setPat.handler(({ input, context }) => deps.connections.setPat(input.token, context.origin)),
      githubPatForm: os.connections.githubPatForm.handler(() => githubPatForm()),
      startDeviceFlow: os.connections.startDeviceFlow.handler(({ context }) => deps.connections.startDeviceFlow(context.origin)),
      githubInstallations: os.connections.githubInstallations.handler(() => deps.connections.githubInstallations()),
      // `done` no se espera: el resultado llega como `connection.changed`, y un fallo se le muestra al usuario en la pestaña del navegador.
      linearAuth: os.connections.linearAuth.handler(async ({ context }) =>
        ({ url: (await deps.connections.linearAuth(context.origin)).url }),
      ),
      testClaude: os.connections.testClaude.handler(({ input, context }) => deps.connections.testClaude(input.mode, context.origin)),
      testCodex: os.connections.testCodex.handler(({ context }) => deps.connections.testCodex(context.origin)),
      codexStatus: os.connections.codexStatus.handler(() => deps.connections.codexStatus() ?? null),
      setClaudeApiKey: os.connections.setClaudeApiKey.handler(({ input, context }) =>
        deps.connections.setClaudeApiKey(input.key, context.origin),
      ),
      disconnect: os.connections.disconnect.handler(async ({ input, context }) => {
        await deps.connections.disconnect(input.provider, input.account, context.origin);
      }),
    },
    artifacts: {
      get: os.artifacts.get.handler(({ input }) => {
        const artifact = artifacts.get(input.hash);
        if (!artifact) {
          throw new ORPCError("NOT_FOUND", { message: `No existe el artefacto ${input.hash}.` });
        }
        const { content, ...meta } = artifact;
        return { ...meta, content: new Blob([content], { type: artifact.mime }) };
      }),
    },
    issues: {
      list: os.issues.list.handler(({ input: { withBody, ...filter } }) => {
        const list = deps.issues.list(filter);
        return withBody ? list : list.map((issue) => ({ ...issue, body: "" }));
      }),
      get: os.issues.get.handler(({ input }) => {
        const issue = deps.issues.get(input.id);
        if (!issue) throw new ORPCError("NOT_FOUND", { message: `No hay una issue ${input.id} en el caché.` });
        return issue;
      }),
      createLocal: os.issues.createLocal.handler(({ input, context }) => {
        const project = projectOrNotFound(input.projectId);
        if (project.tracker !== "local") {
          throw new ORPCError("BAD_REQUEST", {
            message: `El proyecto ${project.slug} es de ${project.tracker}: solo un proyecto local guarda sus issues en el core.`,
          });
        }
        return deps.issues.createLocal(input, context.origin);
      }),
    },
    trackers: {
      projects: os.trackers.projects.handler(({ input }) => deps.trackerProjects.list(input.tracker)),
    },
    projects: {
      list: os.projects.list.handler(() => projects.list()),
      get: os.projects.get.handler(({ input }) => projectOrNotFound(input.id)),
      create: os.projects.create.handler(async ({ input, context }) =>
        projects.create(
          input.trackerRef === undefined ? input : { ...input, trackerRef: await deps.trackerProjects.resolve(input.tracker, input.trackerRef) },
          context.origin,
        ),
      ),
      defaults: os.projects.defaults.handler(() => projects.defaults()),
      setDefaults: os.projects.setDefaults.handler(({ input, context }) => projects.setDefaults(input, context.origin)),
      update: os.projects.update.handler(async ({ input: { id, ...patch }, context }) => {
        const { tracker } = projectOrNotFound(id);
        const trackerRef = patch.trackerRef === undefined ? undefined : await deps.trackerProjects.resolve(tracker, patch.trackerRef);
        // Elegir de nuevo el mismo proyecto de Linear que guarda su identificador no cambia su cola: se normaliza antes.
        // Si no se puede resolver el ref guardado no se sabe si es el mismo proyecto y rige la regla de `update`.
        if (trackerRef !== undefined) {
          await deps.trackerProjects.normalize(id, context.origin).catch((error: unknown) => {
            if (!(error instanceof TrackerProjectsError)) throw error;
          });
        }
        return projects.update(id, trackerRef === undefined ? patch : { ...patch, trackerRef }, context.origin);
      }),
      archive: os.projects.archive.handler(({ input, context }) => projects.archive(input.id, context.origin)),
      exportConfig: os.projects.exportConfig.handler(({ input }) => deps.projectConfigs.export(input.id)),
      importConfig: os.projects.importConfig.handler(({ input, context }) =>
        deps.projectConfigs.import(input.id, input.config, context.origin, { dryRun: input.dryRun }),
      ),
      pause: os.projects.pause.handler(({ input, context }) => projects.pause(input.id, context.origin)),
      resume: os.projects.resume.handler(({ input, context }) => projects.resume(input.id, context.origin)),
      skipIssue: os.projects.skipIssue.handler(({ input: { id, issueId, skipped }, context }) =>
        deps.scheduler.skipIssue({ projectId: id, issueId, skipped }, context.origin),
      ),
      boostIssue: os.projects.boostIssue.handler(({ input: { id, issueId, boosted }, context }) =>
        deps.scheduler.boostIssue({ projectId: id, issueId, boosted }, context.origin),
      ),
      queue: os.projects.queue.handler(({ input }) => deps.queue.of(input.id)),
      summary: os.projects.summary.handler(({ input: { id, ...filter } }) => metrics.summary(projectOrNotFound(id).id, filter)),
    },
    packs: {
      list: os.packs.list.handler(() => deps.packs.list()),
      install: os.packs.install.handler(async ({ input, context }) => {
        const pack = await deps.packs.install(input.path);
        store.tx((tx) => tx.emit({ type: "pack.installed", origin: context.origin, payload: { packId: pack.id, version: pack.version } }));
        return pack;
      }),
      remove: os.packs.remove.handler(async ({ input, context }) => {
        await deps.packs.remove(input.id);
        store.tx((tx) => tx.emit({ type: "pack.removed", origin: context.origin, payload: { packId: input.id } }));
      }),
    },
    chats: {
      get: os.chats.get.handler(({ input }) => chatsOf().get(input.prId)),
      send: os.chats.send.handler(({ input, context }) => chatsOf().send(input, context.origin)),
      interrupt: os.chats.interrupt.handler(({ input, context }) => chatsOf().interrupt(input.chatId, context.origin)),
      reset: os.chats.reset.handler(({ input, context }) => chatsOf().reset(input.chatId, context.origin)),
      proposal: os.chats.proposal.handler(({ input }) => chatsOf().proposal(input.chatId, input.rev, input.since)),
      discard: os.chats.discard.handler(({ input, context }) => chatsOf().discard(input.chatId, context.origin)),
      apply: os.chats.apply.handler(({ input, context }) => chatsOf().apply(input, context.origin)),
    },
    prs: {
      get: os.prs.get.handler(({ input }) => prs.get(input)),
      list: os.prs.list.handler(({ input }) => prCache.list(input)),
      refresh: os.prs.refresh.handler(({ input }) => prCache.refresh(input)),
      setHold: os.prs.setHold.handler(({ input, context }) => prCommands.setHold(input.ref, input.hold, context.origin)),
      merge: os.prs.merge.handler(({ input, context }) => prCommands.merge(input, context.origin)),
      requestReview: os.prs.requestReview.handler(({ input, context }) => prCommands.requestReview(input, context.origin)),
      rebase: os.prs.rebase.handler(({ input, context }) => prCommands.rebase(input, context.origin)),
      publishLocal: os.prs.publishLocal.handler(({ input, context }) => ({ runId: prCommands.publishLocal(input.id, context.origin) })),
      detail: os.prs.detail.handler(({ input }) => prDetails.get(input.id)),
      commitDiff: os.prs.commitDiff.handler(({ input }) => prDetails.commit(input.id, input.sha, { head: input.head, base: input.base })),
      localDetail: os.prs.localDetail.handler(({ input }) => prDetails.get(input.id, true)),
      localCommitDiff: os.prs.localCommitDiff.handler(({ input }) => prDetails.commit(input.id, input.sha, undefined, true)),
      updateLocal: os.prs.updateLocal.handler(({ input, context }) => prCommands.updateLocal(input, context.origin)),
      applyLocalPatch: os.prs.applyLocalPatch.handler(({ input, context }) => ({ runId: prCommands.applyLocalPatch(input, context.origin) })),
      requestLocalPublish: os.prs.requestLocalPublish.handler(async ({ input, context }) => ({ decisionId: await localPublish.request(input.id, context.origin) })),
      republish: os.prs.republish.handler(({ input, context }) => deps.republisher.republish(input, context.origin)),
      republishProgress: os.prs.republishProgress.handler(({ input }) => deps.republisher.progress(input.id)),
    },
    repos: {
      list: os.repos.list.handler(() => repos.list()),
      overview: os.repos.overview.handler(() => repos.overview()),
      add: os.repos.add.handler(async ({ input, context }) => {
        const repo = await repos.register(input.path, input.name, context.origin);
        // Quien registra el repo recibe de una vez lo que el repo trae en `.clanker/`.
        await deps.repoConfigSync.sync(repo.id);
        return repo;
      }),
      detect: os.repos.detect.handler(({ input }) => repos.detect(input.folder)),
      testRecipe: os.repos.testRecipe.handler(({ input, context }) =>
        recipeTester.test(input.repoId, context.origin),
      ),
      syncConfig: os.repos.syncConfig.handler(({ input }) => deps.repoConfigSync.sync(input.repoId)),
    },
    runs: {
      list: os.runs.list.handler(({ input }) => flows.listRuns(input)),
      get: os.runs.get.handler(({ input }) => flows.getRun(input.id)),
      step: os.runs.step.handler(({ input }) => stepDetails.get(input.id)),
      transcript: os.runs.transcript.handler(({ input }) => transcripts.read(input)),
      start: os.runs.start.handler(({ input, context }) => deps.scheduler.runNow(input, context.origin)),
      pause: os.runs.pause.handler(({ input, context }) => controlRun(input.id, "pause", context.origin, input.now)),
      resume: os.runs.resume.handler(({ input, context }) => controlRun(input.id, "resume", context.origin)),
      cancel: os.runs.cancel.handler(({ input, context }) => controlRun(input.id, "cancel", context.origin)),
      interrupt: os.runs.interrupt.handler(({ input, context }) => controlRun(input.id, "pause", context.origin, true)),
      retryStep: os.runs.retryStep.handler(({ input, context }) => commandStep(input.stepId, { retry: true }, context.origin)),
      steerStep: os.runs.steerStep.handler(({ input, context }) => commandStep(input.stepId, { steer: input.message }, context.origin)),
      forceOutcome: os.runs.forceOutcome.handler(({ input, context }) => commandStep(input.stepId, { force: input.outcome }, context.origin)),
    },
    metrics: {
      byRole: os.metrics.byRole.handler(({ input }) => metrics.byRole(input)),
      byDay: os.metrics.byDay.handler(({ input }) => metrics.byDay(input)),
      byModel: os.metrics.byModel.handler(({ input }) => metrics.byModel(input)),
      byStep: os.metrics.byStep.handler(({ input }) => metrics.byStep(input)),
      byIssue: os.metrics.byIssue.handler(({ input }) => metrics.byIssue(input)),
    },
    imports: {
      legacy: os.imports.legacy.handler(({ input }) => deps.legacyImport.run(input)),
    },
    decisions: {
      list: os.decisions.list.handler(({ input }) => deps.decisions.list(input)),
      get: os.decisions.get.handler(({ input }) => {
        const decision = deps.decisions.get(input.id);
        if (!decision) throw new DecisionNotFoundError(input.id);
        return decision;
      }),
      resolve: os.decisions.resolve.handler(async ({ input, context }) => {
        const publication = await localPublish.resolve(input.id, input.option, context.origin);
        if (publication) return publication;
        if (isMergeOffer(store, input.id)) {
          requireUiOrigin(context.origin, "Una oferta de merge la aprueba una persona desde la app: comenta el comando de merge con tu identidad.");
        }
        deps.flows.resolveGate(input.id, input.option, context.origin);
        const decision = deps.decisions.get(input.id);
        if (!decision) throw new DecisionNotFoundError(input.id);
        return decision;
      }),
    },
    learnings: {
      list: os.learnings.list.handler(({ input }) => deps.learnings.list(input)),
      get: os.learnings.get.handler(({ input }) => {
        const learning = deps.learnings.get(input.id);
        if (!learning) throw new LearningNotFoundError(input.id);
        return learning;
      }),
      propose: os.learnings.propose.handler(({ input, context }) => deps.learnings.propose(input, context.origin)),
      approve: os.learnings.approve.handler(({ input, context }) => deps.learnings.approve(input.id, context.origin)),
      reject: os.learnings.reject.handler(({ input, context }) => deps.learnings.reject(input.id, context.origin)),
      screen: os.learnings.screen.handler(({ input }) => deps.learnings.screen(input)),
      archive: os.learnings.archive.handler(({ input, context }) => deps.learnings.archive(input.ids, context.origin)),
      update: os.learnings.update.handler(({ input, context }) => deps.learnings.update(input, context.origin)),
    },
    defs: {
      list: os.defs.list.handler(({ input }) => deps.defs.list(input.kind, { includeArchived: input.includeArchived })),
      get: os.defs.get.handler(({ input }) => {
        const def = deps.defs.get(input.kind, input.id, input.version);
        if (!def) {
          const version = input.version === undefined ? "" : ` en la versión ${input.version}`;
          throw new ORPCError("NOT_FOUND", { message: `No existe ${input.kind} ${input.id}${version}.` });
        }
        return def;
      }),
      create: os.defs.create.handler(({ input, context }) => defWriter.create(input, context.origin)),
      update: os.defs.update.handler(({ input, context }) => defWriter.update(input, context.origin)),
      archive: os.defs.archive.handler(({ input, context }) => defWriter.archive(input.kind, input.id, context.origin)),
      agentOptions: os.defs.agentOptions.handler(() => deps.agentOptions()),
      exportToRepo: os.defs.exportToRepo.handler(({ input, context }) => deps.repoConfigExport.exportDef(input, context.origin)),
      restore: os.defs.restore.handler(({ input, context }) => defWriter.restore(input.kind, input.id, context.origin)),
    },
    events: {
      list: os.events.list.handler(({ input }) =>
        store.events.since(input.after, input.filter, input.limit),
      ),
      latest: os.events.latest.handler(() => ({ seq: store.events.latestSeq() })),
      stream: os.events.stream.handler(async function* ({ input, lastEventId, signal }) {
        for await (const event of eventsAfter(
          store,
          resumeFrom(lastEventId, input.after),
          input.filter,
          signal,
        )) {
          yield withEventMeta(event, { id: String(event.seq) });
        }
      }),
    },
  });
}

export type CoreRouter = ReturnType<typeof createRouter>;

/** El `Last-Event-ID` del reconectado manda sobre `after`: es lo último que el cliente vio. */
function resumeFrom(lastEventId: string | undefined, after: number | undefined): number {
  if (lastEventId === undefined) return after ?? 0;
  const seq = Number(lastEventId);
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new ORPCError("BAD_REQUEST", {
      message: `Last-Event-ID debe ser el número de un evento (entero >= 0), llegó "${lastEventId}".`,
    });
  }
  return seq;
}
