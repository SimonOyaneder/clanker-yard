import { API_MAJOR, type ClientOrigin, contract, type PrRef, type ProjectId, type RunId, type StepRunId } from "@clanker/api";
import { ORPCError, implement, withEventMeta } from "@orpc/server";
import { GitHubAuthError } from "../github/device-flow";
import { GitHubPatError, githubPatForm } from "../github/pat";
import { PrNotFoundError } from "../github/pr-query";
import { createMergeScope } from "../github/merge-scope";
import { createPrCache, type PrCacheDeps } from "../github/pr-cache";
import { createPrCommands, PrCommandError } from "../github/pr-commands";
import { createPrs } from "../github/prs";
import { LinearAuthError } from "../linear/oauth";
import { ClaudeSetupError, type Connections } from "../connections/connections";
import { CLAUDE_OPTIONS } from "../agents/claude/models";
import { createTranscripts, SessionNotFoundError } from "../agents/transcripts";
import type { Breakers } from "../breakers/breakers";
import type { Artifacts } from "../artifacts/artifacts";
import type { Decisions } from "../decisions/decisions";
import { LearningNotFoundError, LearningUpdateError, type Learnings } from "../learnings/learnings";
import type { Engine } from "../flows/engine";
import type { Flows } from "../flows/flows";
import { DecisionNotFoundError, DecisionResolveError, RunCommandError, RunNotFoundError, RunStartError } from "../flows/engine";
import { createStepDetails, StepNotFoundError } from "../flows/step-detail";
import { LegacyImportError, type LegacyImporter } from "../import/legacy";
import { createMetrics } from "../metrics/metrics";
import type { Packs } from "../packs/packs";
import { DefValidationError, type Defs } from "../defs/defs";
import { createDefWriter, DefNotFoundError, DefWriteError } from "../defs/write";
import { InvalidProjectError, ProjectNotFoundError, type Projects } from "../projects/projects";
import { IssueNotCachedError, type RunStarter } from "../projects/start-run";
import type { LaneSettings } from "../scheduler/lanes";
import { QueueUnavailableError, type ProjectQueue } from "../scheduler/project-queue";
import { IssueNotInProjectError, type Scheduler } from "../scheduler/scheduler";
import { RecipeSyntaxError } from "../recipe/recipe";
import { RecipeTestError, type RecipeTester } from "../recipe/recipe-test";
import { readSchemaVersion } from "../store/migrate";
import type { Store } from "../store/store";
import type { Issues } from "../tracker/issues";
import { TrackerProjectsError, type TrackerProjects } from "../tracker/tracker-projects";
import { defaultLogDir } from "../workspaces/exec";
import { NotAGitRepoError } from "../workspaces/inspect";
import { InvalidRepoError, RepoNotFoundError, type Repos } from "../workspaces/repos";
import { eventsAfter } from "./event-stream";

/** Lo que cada llamada trae consigo, venga por HTTP o en proceso (`createRouterClient`, MCP). */
export interface CoreContext {
  origin: ClientOrigin;
  /** La request trajo la llave de la app (el servidor ya la verificó). Solo `system.health` lo informa. */
  uiKey?: boolean;
}

export interface RouterDeps {
  store: Store;
  connections: Connections;
  issues: Issues;
  projects: Projects;
  packs: Packs;
  repos: Repos;
  recipeTester: RecipeTester;
  /** `runs.start`: reclama la issue y lanza el flujo. */
  runs: RunStarter;
  /** `projects.queue`. */
  queue: ProjectQueue;
  /** `trackers.projects`. */
  trackerProjects: TrackerProjects;
  /** `projects.skipIssue`, y el tick que `system.setLanes` y `projects.setParallel` piden para repartir el cupo que liberaron. */
  scheduler: Pick<Scheduler, "skipIssue" | "boostIssue" | "tick">;
  /** `system.lanes` y `system.setLanes`. */
  lanes: LaneSettings;
  /** `system.breakers`. */
  breakers: Pick<Breakers, "list">;
  flows: Flows;
  /** Lo que `prs.refresh` avisa cuando un PR cambió (los waits y los eventos de Watch): el core lo comparte con su propio caché. */
  onPrChange?: PrCacheDeps["onChange"];
  artifacts: Artifacts;
  decisions: Decisions;
  learnings: Learnings;
  defs: Defs;
  /** `imports.legacy`. */
  legacyImport: LegacyImporter;
  coreVersion: string;
  bootId: string;
  /** ms epoch */
  startedAt: number;
  dataDir: string;
  /** Quien lanzó el core decide cómo apagarlo; `system.shutdown` solo lo pide. */
  onShutdown(opts: { drain: boolean }): void;
}

const os = implement(contract).$context<CoreContext>();

export function createRouter(deps: RouterDeps) {
  const { store } = deps;
  const schemaVersion = readSchemaVersion(store.db.$client);
  const { artifacts, flows, projects, repos, recipeTester, runs } = deps;
  const metrics = createMetrics(store);
  const defWriter = createDefWriter({ defs: deps.defs, flows: deps.flows });
  const stepDetails = createStepDetails({ store, logDir: defaultLogDir(deps.dataDir) });
  const transcripts = createTranscripts({ store, home: deps.dataDir });
  const prs = createPrs({ connections: deps.connections, packs: deps.packs, merge: createMergeScope({ store, repos, connections: deps.connections }) });
  const prCache = createPrCache({ store, repos, packs: deps.packs, prs, onChange: deps.onPrChange });
  const prCommands = createPrCommands({ store, repos, connections: deps.connections, packs: deps.packs, prs, cache: prCache });
  const projectOrNotFound = (id: ProjectId) => {
    const project = projects.get(id);
    if (!project) throw new ORPCError("NOT_FOUND", { message: `No existe el proyecto ${id}.` });
    return project;
  };
  /** `runs.pause|resume|cancel|interrupt`: el comando y la corrida como quedó. */
  const controlRun = (id: RunId, cmd: "pause" | "resume" | "cancel", by: ClientOrigin, now?: boolean) =>
    asApiError(() => {
      flows.control(id, cmd, { by, now });
      return flows.getRun(id);
    });
  /** `runs.retryStep|steerStep|forceOutcome`: el comando y la corrida del paso como quedó. */
  const commandStep = (stepId: StepRunId, cmd: Parameters<Engine["stepCommand"]>[1], by: ClientOrigin) =>
    asApiError(() => flows.getRun(flows.stepCommand(stepId, cmd, by)));
  /** Lo que `prs.*` hace con un PR de GitHub (leerlo, mergearlo...): traduce sus errores a los de la API. */
  const readPr = async <T>(ref: PrRef, read: (ref: PrRef) => Promise<T>): Promise<T> => {
    if (!deps.connections.list().some((c) => c.provider === "github" && c.account === ref.account)) {
      throw new ORPCError("BAD_REQUEST", {
        message: `No hay una cuenta github conectada como "${ref.account}": conéctala primero.`,
      });
    }
    try {
      return await read(ref);
    } catch (error) {
      if (error instanceof PrNotFoundError) throw new ORPCError("NOT_FOUND", { message: error.message, cause: error });
      throw error;
    }
  };
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
        activeRuns: flows.listRuns({ status: ["queued", "running", "waiting"] }).length,
        uiKey: context.uiKey === true,
      })),
      info: os.system.info.handler(() => ({
        pid: process.pid,
        startedAt: deps.startedAt,
        dataDir: deps.dataDir,
        platform,
      })),
      lanes: os.system.lanes.handler(() => deps.lanes.usage()),
      breakers: os.system.breakers.handler(() => deps.breakers.list()),
      setLanes: os.system.setLanes.handler(({ input }) => {
        deps.lanes.set(input);
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
      setPat: os.connections.setPat.handler(async ({ input, context }) => {
        try {
          return await deps.connections.setPat(input.token, context.origin);
        } catch (error) {
          if (error instanceof GitHubPatError) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw error;
        }
      }),
      githubPatForm: os.connections.githubPatForm.handler(() => githubPatForm()),
      startDeviceFlow: os.connections.startDeviceFlow.handler(async ({ context }) => {
        try {
          return await deps.connections.startDeviceFlow(context.origin);
        } catch (error) {
          if (error instanceof GitHubAuthError) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw error;
        }
      }),
      githubInstallations: os.connections.githubInstallations.handler(async () => {
        try {
          return await deps.connections.githubInstallations();
        } catch (error) {
          if (error instanceof GitHubAuthError) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw error;
        }
      }),
      linearAuth: os.connections.linearAuth.handler(async ({ context }) => {
        try {
          // `done` no se espera: el resultado llega como `connection.changed`, y un fallo se le muestra
          // al usuario en la pestaña del navegador.
          const { url } = await deps.connections.linearAuth(context.origin);
          return { url };
        } catch (error) {
          if (error instanceof LinearAuthError) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw error;
        }
      }),
      testClaude: os.connections.testClaude.handler(async ({ input, context }) => {
        try {
          return await deps.connections.testClaude(input.mode, context.origin);
        } catch (error) {
          if (error instanceof ClaudeSetupError) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw error;
        }
      }),
      setClaudeApiKey: os.connections.setClaudeApiKey.handler(async ({ input, context }) => {
        try {
          return await deps.connections.setClaudeApiKey(input.key, context.origin);
        } catch (error) {
          if (error instanceof ClaudeSetupError) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw error;
        }
      }),
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
      list: os.issues.list.handler(({ input }) => deps.issues.list(input)),
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
      projects: os.trackers.projects.handler(({ input }) => asApiErrorAsync(() => deps.trackerProjects.list(input.tracker))),
    },
    projects: {
      list: os.projects.list.handler(() => projects.list()),
      get: os.projects.get.handler(({ input }) => projectOrNotFound(input.id)),
      create: os.projects.create.handler(({ input, context }) =>
        asApiErrorAsync(async () =>
          projects.create(
            input.trackerRef === undefined ? input : { ...input, trackerRef: await deps.trackerProjects.resolve(input.tracker, input.trackerRef) },
            context.origin,
          ),
        ),
      ),
      update: os.projects.update.handler(({ input: { id, ...patch }, context }) =>
        asApiErrorAsync(async () => {
          const { tracker } = projectOrNotFound(id);
          const trackerRef = patch.trackerRef === undefined ? undefined : await deps.trackerProjects.resolve(tracker, patch.trackerRef);
          return projects.update(id, trackerRef === undefined ? patch : { ...patch, trackerRef }, context.origin);
        }),
      ),
      pause: os.projects.pause.handler(({ input, context }) => asApiError(() => projects.pause(input.id, context.origin))),
      resume: os.projects.resume.handler(({ input, context }) => asApiError(() => projects.resume(input.id, context.origin))),
      setParallel: os.projects.setParallel.handler(({ input: { id, parallel }, context }) =>
        asApiError(() => projects.update(id, { parallel }, context.origin)),
      ),
      skipIssue: os.projects.skipIssue.handler(({ input: { id, issueId, skipped }, context }) =>
        asApiError(() => deps.scheduler.skipIssue({ projectId: id, issueId, skipped }, context.origin)),
      ),
      boostIssue: os.projects.boostIssue.handler(({ input: { id, issueId, boosted }, context }) =>
        asApiError(() => deps.scheduler.boostIssue({ projectId: id, issueId, boosted }, context.origin)),
      ),
      queue: os.projects.queue.handler(({ input }) => asApiErrorAsync(() => deps.queue.of(input.id))),
      summary: os.projects.summary.handler(({ input: { id, ...filter } }) => metrics.summary(projectOrNotFound(id).id, filter)),
    },
    prs: {
      get: os.prs.get.handler(({ input }) => readPr(input, prs.get)),
      list: os.prs.list.handler(({ input }) => prCache.list(input)),
      refresh: os.prs.refresh.handler(({ input }) => readPr(input, prCache.refresh)),
      setHold: os.prs.setHold.handler(({ input }) => asApiErrorAsync(() => readPr(input.ref, (ref) => prCommands.setHold(ref, input.hold)))),
      merge: os.prs.merge.handler(({ input, context }) => {
        // Mergear lo decide una persona: un agente que use el CLI o el MCP no comenta el comando de merge por su cuenta.
        if (context.origin !== "ui") {
          throw new ORPCError("FORBIDDEN", { message: "Mergear lo pide una persona desde la app: un agente no lo hace por su cuenta." });
        }
        return asApiErrorAsync(() => readPr(input, prCommands.merge));
      }),
      requestReview: os.prs.requestReview.handler(({ input }) =>
        asApiErrorAsync(() => readPr(input, prCommands.requestReview)),
      ),
      rebase: os.prs.rebase.handler(({ input, context }) =>
        asApiErrorAsync(() => readPr(input, (ref) => prCommands.rebase(ref, context.origin))),
      ),
    },
    repos: {
      list: os.repos.list.handler(() => repos.list()),
      add: os.repos.add.handler(({ input }) => asApiErrorAsync(() => repos.register(input.path, input.name))),
      detect: os.repos.detect.handler(({ input }) => asApiErrorAsync(() => repos.detect(input.folder))),
      testRecipe: os.repos.testRecipe.handler(({ input, context }) =>
        asApiErrorAsync(() => recipeTester.test(input.repoId, context.origin)),
      ),
    },
    runs: {
      list: os.runs.list.handler(({ input }) => flows.listRuns(input)),
      get: os.runs.get.handler(({ input }) => asApiError(() => flows.getRun(input.id))),
      step: os.runs.step.handler(({ input }) => asApiErrorAsync(() => stepDetails.get(input.id))),
      transcript: os.runs.transcript.handler(({ input }) => asApiErrorAsync(() => transcripts.read(input))),
      start: os.runs.start.handler(({ input, context }) =>
        asApiErrorAsync(() => runs.start(input, context.origin)),
      ),
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
      legacy: os.imports.legacy.handler(({ input }) => asApiError(() => deps.legacyImport.run(input))),
    },
    decisions: {
      list: os.decisions.list.handler(({ input }) => deps.decisions.list(input)),
      get: os.decisions.get.handler(({ input }) => {
        const decision = deps.decisions.get(input.id);
        if (!decision) throw new ORPCError("NOT_FOUND", { message: `No existe la decisión ${input.id}.` });
        return decision;
      }),
      resolve: os.decisions.resolve.handler(({ input, context }) =>
        asApiError(() => {
          deps.flows.resolveGate(input.id, input.option, context.origin);
          const decision = deps.decisions.get(input.id);
          if (!decision) throw new DecisionNotFoundError(input.id);
          return decision;
        }),
      ),
    },
    learnings: {
      list: os.learnings.list.handler(({ input }) => deps.learnings.list(input)),
      get: os.learnings.get.handler(({ input }) => {
        const learning = deps.learnings.get(input.id);
        if (!learning) throw new ORPCError("NOT_FOUND", { message: new LearningNotFoundError(input.id).message });
        return learning;
      }),
      propose: os.learnings.propose.handler(({ input, context }) => deps.learnings.propose(input, context.origin)),
      // Lo aprobado entra a los briefs de las corridas que siguen: un agente que lo aprobara por el CLI se dejaría instrucciones a sí mismo.
      approve: os.learnings.approve.handler(({ input, context }) => {
        if (context.origin !== "ui") throw new ORPCError("FORBIDDEN", { message: "Un learning lo aprueba una persona desde la app." });
        return asApiError(() => deps.learnings.approve(input.id, context.origin));
      }),
      reject: os.learnings.reject.handler(({ input, context }) => asApiError(() => deps.learnings.reject(input.id, context.origin))),
      update: os.learnings.update.handler(({ input, context }) => {
        if (context.origin !== "ui" && deps.learnings.get(input.id)?.status === "approved") {
          throw new ORPCError("FORBIDDEN", { message: "Un learning aprobado solo se edita desde la app: el texto nuevo entra a los briefs sin otra aprobación." });
        }
        return asApiError(() => deps.learnings.update(input));
      }),
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
      create: os.defs.create.handler(({ input, context }) => asApiError(() => defWriter.create(input, context.origin))),
      update: os.defs.update.handler(({ input, context }) => asApiError(() => defWriter.update(input, context.origin))),
      archive: os.defs.archive.handler(({ input, context }) => asApiError(() => defWriter.archive(input.kind, input.id, context.origin))),
      agentOptions: os.defs.agentOptions.handler(() => CLAUDE_OPTIONS),
      restore: os.defs.restore.handler(({ input, context }) => asApiError(() => defWriter.restore(input.kind, input.id, context.origin))),
    },
    events: {
      list: os.events.list.handler(({ input }) =>
        store.events.since(input.after, input.filter, input.limit),
      ),
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

/** Los errores de un pedido inválido o de algo que no existe llegan al cliente con su mensaje; el resto es un bug del core. */
export function asApiError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw toApiError(error);
  }
}

async function asApiErrorAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toApiError(error);
  }
}

function toApiError(error: unknown): unknown {
  if (
    error instanceof ProjectNotFoundError ||
    error instanceof RunNotFoundError ||
    error instanceof DecisionNotFoundError ||
    error instanceof LearningNotFoundError ||
    error instanceof StepNotFoundError ||
    error instanceof DefNotFoundError ||
    error instanceof SessionNotFoundError ||
    error instanceof RepoNotFoundError ||
    error instanceof IssueNotCachedError
  ) {
    return new ORPCError("NOT_FOUND", { message: error.message, cause: error });
  }
  if (
    error instanceof InvalidProjectError ||
    error instanceof IssueNotInProjectError ||
    error instanceof QueueUnavailableError ||
    error instanceof TrackerProjectsError ||
    error instanceof RunStartError ||
    error instanceof RunCommandError ||
    error instanceof DecisionResolveError ||
    error instanceof LearningUpdateError ||
    error instanceof InvalidRepoError ||
    error instanceof NotAGitRepoError ||
    error instanceof PrCommandError ||
    error instanceof RecipeTestError ||
    error instanceof RecipeSyntaxError ||
    error instanceof DefValidationError ||
    error instanceof DefWriteError ||
    error instanceof LegacyImportError
  ) {
    return new ORPCError("BAD_REQUEST", { message: error.message, cause: error });
  }
  return error;
}

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
