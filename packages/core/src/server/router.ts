import { API_MAJOR, type ClientOrigin, contract, type ProjectId } from "@clanker/api";
import { ORPCError, implement, withEventMeta } from "@orpc/server";
import { GitHubPatError, githubPatForm } from "../github/pat";
import { PrNotFoundError } from "../github/pr-query";
import { createPrs } from "../github/prs";
import { LinearAuthError } from "../linear/oauth";
import type { Connections } from "../connections/connections";
import type { Artifacts } from "../artifacts/artifacts";
import type { Engine } from "../flows/engine";
import { RunNotFoundError, RunStartError } from "../flows/engine";
import type { Packs } from "../packs/packs";
import { DefValidationError } from "../defs/defs";
import { InvalidProjectError, ProjectNotFoundError, type Projects } from "../projects/projects";
import { IssueNotCachedError, type RunStarter } from "../projects/start-run";
import { RecipeSyntaxError } from "../recipe/recipe";
import { RecipeTestError, type RecipeTester } from "../recipe/recipe-test";
import { readSchemaVersion } from "../store/migrate";
import type { Store } from "../store/store";
import type { Issues } from "../tracker/issues";
import { NotAGitRepoError } from "../workspaces/inspect";
import { InvalidRepoError, RepoNotFoundError, type Repos } from "../workspaces/repos";
import { eventsAfter } from "./event-stream";

/** Lo que cada llamada trae consigo, venga por HTTP o en proceso (`createRouterClient`, MCP). */
export interface CoreContext {
  origin: ClientOrigin;
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
  flows: Engine;
  artifacts: Artifacts;
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
  const prs = createPrs({ connections: deps.connections, packs: deps.packs });
  const projectOrNotFound = (id: ProjectId) => {
    const project = projects.get(id);
    if (!project) throw new ORPCError("NOT_FOUND", { message: `No existe el proyecto ${id}.` });
    return project;
  };
  const platform = process.platform;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    throw new Error(
      `Plataforma no soportada: ${platform}. El core corre en macOS, Linux y Windows.`,
    );
  }

  return os.router({
    system: {
      health: os.system.health.handler(() => ({
        coreVersion: deps.coreVersion,
        apiMajor: API_MAJOR,
        schemaVersion,
        bootId: deps.bootId,
        activeRuns: flows.listRuns({ status: ["queued", "running", "waiting"] }).length,
      })),
      info: os.system.info.handler(() => ({
        pid: process.pid,
        startedAt: deps.startedAt,
        dataDir: deps.dataDir,
        platform,
      })),
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
    projects: {
      list: os.projects.list.handler(() => projects.list()),
      get: os.projects.get.handler(({ input }) => projectOrNotFound(input.id)),
      create: os.projects.create.handler(({ input, context }) =>
        asApiError(() => projects.create(input, context.origin)),
      ),
      update: os.projects.update.handler(({ input: { id, ...patch }, context }) =>
        asApiError(() => projects.update(id, patch, context.origin)),
      ),
    },
    prs: {
      get: os.prs.get.handler(async ({ input }) => {
        if (!deps.connections.list().some((c) => c.provider === "github" && c.account === input.account)) {
          throw new ORPCError("BAD_REQUEST", {
            message: `No hay una cuenta github conectada como "${input.account}": conéctala primero.`,
          });
        }
        try {
          return await prs.get(input);
        } catch (error) {
          if (error instanceof PrNotFoundError) throw new ORPCError("NOT_FOUND", { message: error.message, cause: error });
          throw error;
        }
      }),
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
      start: os.runs.start.handler(({ input, context }) =>
        asApiErrorAsync(() => runs.start(input, context.origin)),
      ),
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
function asApiError<T>(fn: () => T): T {
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
    error instanceof RepoNotFoundError ||
    error instanceof IssueNotCachedError
  ) {
    return new ORPCError("NOT_FOUND", { message: error.message, cause: error });
  }
  if (
    error instanceof InvalidProjectError ||
    error instanceof RunStartError ||
    error instanceof InvalidRepoError ||
    error instanceof NotAGitRepoError ||
    error instanceof RecipeTestError ||
    error instanceof RecipeSyntaxError ||
    error instanceof DefValidationError
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
