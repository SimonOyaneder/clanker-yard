import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Role } from "@clanker/api";
import { createAgents } from "./agents/agents";
import { type AgentRuntime, selectRuntime } from "./agents/runtime";
import { createArtifacts } from "./artifacts/artifacts";
import { installBuiltins } from "./builtin/install";
import { createConnections } from "./connections/connections";
import { createDefs, type Defs } from "./defs/defs";
import { createFlows } from "./flows/flows";
import { createPacks } from "./packs/packs";
import { createProjects } from "./projects/projects";
import type { Secrets } from "./secrets/secrets";
import { startServer, type CoreServer, type StartServerOptions } from "./server/server";
import { newId } from "./store/conventions";
import type { Store } from "./store/store";
import { createIssues } from "./tracker/issues";
import { createRepos } from "./workspaces/repos";
import { createWorkspaces, workspaceAcquireAction, workspaceReleaseAction } from "./workspaces/workspaces";

/** Cuánto espera el cierre a que terminen los pasos en curso antes de dejarlos atrás. */
const DRAIN_MS = 10_000;

/** Autor y committer de lo que el core hace con git en un worktree. */
const GIT_IDENTITY = { name: "Clanker Yard", email: "clanker@localhost" };

export interface StartCoreOptions extends Pick<StartServerOptions, "coreVersion" | "onShutdown" | "allowedOrigins"> {
  store: Store;
  dataDir: string;
  secrets: Secrets;
  /** Los runtimes de agentes que este core conoce; `CORE_RUNTIME` elige entre ellos. */
  runtimes: readonly AgentRuntime[];
  /** De aquí sale `CORE_RUNTIME`. Por defecto, `process.env`. */
  env?: Record<string, string | undefined>;
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
  const agents = createAgents({ store, defs, runtime });
  const artifacts = createArtifacts({ store, dir: join(dataDir, "artifacts") });
  const workspaces = createWorkspaces({ store, dataDir, repos: createRepos(store).config, identity: GIT_IDENTITY });
  const flows = createFlows({
    store,
    defs,
    agents,
    artifacts,
    roles: roleInfoOf(defs),
    workspaceOf: workspaces.held,
    bootId,
  });
  flows.registerAction(workspaceAcquireAction(workspaces));
  flows.registerAction(workspaceReleaseAction(workspaces));
  installBuiltins({ defs, flows });
  flows.recover();

  const server = await startServer({
    store,
    connections: createConnections(store, opts.secrets),
    issues: createIssues(store),
    projects: createProjects(store, defs),
    packs: createPacks({ defs }),
    flows,
    artifacts,
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
