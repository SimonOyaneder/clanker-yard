import { API_MAJOR, type ClientOrigin, contract } from "@clanker/api";
import { ORPCError, implement, withEventMeta } from "@orpc/server";
import { GitHubPatError, githubPatForm } from "../github/pat";
import type { Connections } from "../connections/connections";
import { join } from "node:path";
import { createArtifacts } from "../artifacts/artifacts";
import { readSchemaVersion } from "../store/migrate";
import type { Store } from "../store/store";
import type { Issues } from "../tracker/issues";
import { eventsAfter } from "./event-stream";

/** Lo que cada llamada trae consigo, venga por HTTP o en proceso (`createRouterClient`, MCP). */
export interface CoreContext {
  origin: ClientOrigin;
}

export interface RouterDeps {
  store: Store;
  connections: Connections;
  issues: Issues;
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
  const artifacts = createArtifacts({ store, dir: join(deps.dataDir, "artifacts") });
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
        // Todavía no existe la tabla de corridas.
        activeRuns: 0,
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
      createLocal: os.issues.createLocal.handler(({ input, context }) =>
        deps.issues.createLocal(input, context.origin),
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
