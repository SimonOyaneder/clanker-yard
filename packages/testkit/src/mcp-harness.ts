import { join } from "node:path";
import { createClient, type Client } from "@clanker/api";
import { createConnections, createFileSecrets, openStore, type Core, type Store } from "@clanker/core";
import { startCore } from "./start-core";
import { Client as McpClient, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createDevKit } from "./dev-tools";
import { createFakeRuntime } from "./fake-runtime";
import { tempGitRepo, type TempGitRepo } from "./git";
import { seedDb, type TestHome } from "./home";

export interface McpHarness {
  store: Store;
  repo: TempGitRepo;
  core: Core;
  /** La API del core, como la UI o la CLI. */
  api: Client;
  /** Los ms epoch de su reloj falso (con `dev`); sin `dev` el core no tiene uno. */
  clock?: () => number;
  /** El cliente MCP del SDK por Streamable HTTP, como lo haría Claude Code. */
  mcp: McpClient;
  mcpUrl: string;
  /** El JSON que devuelve una tool; falla si la tool respondió con error. */
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  read(uri: string): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Un core real (Flows, Agents con el runtime fake y la API) sobre un CLANKER_HOME temporal, con el cliente
 * MCP del SDK conectado a su `/mcp`. `speed` es el del runtime fake: `Infinity` reproduce los guiones sin
 * esperar y uno muy chico deja colgado al agente en su primer evento con tiempo. Con `dev` el core se lanza como el
 * de desarrollo (`createDevKit`): monta el router `dev` y sus tools.
 */
export async function startMcpHarness({ fixtures, speed, dev = false }: { fixtures: string; speed: number; dev?: boolean }): Promise<McpHarness> {
  const home: TestHome = seedDb("empty");
  const store = openStore({ path: home.dbPath });
  const repo = tempGitRepo({});
  const kit = dev ? createDevKit({ store, api: () => api, clockStart: Date.UTC(2026, 10, 15, 12) }) : undefined;
  const core = await startCore({
    store,
    dataDir: home.path,
    connections: createConnections(store, createFileSecrets({ dir: join(home.path, "secrets") }), kit && { now: kit.now }),
    dev: kit?.dev,
    runtimes: [createFakeRuntime({ fixtures, speed })],
    env: { CORE_RUNTIME: "fake" },
    scheduler: false,
    coreVersion: "0.0.0",
    onShutdown: () => {},
  });
  const api = createClient({ url: core.server.url, token: core.server.token, origin: "cli" });
  const mcpUrl = `http://127.0.0.1:${core.server.port}/mcp`;
  const mcp = new McpClient({ name: "test", version: "0.0.0" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { authorization: `Bearer ${core.server.token}` } } }));

  return {
    store,
    repo,
    core,
    api,
    clock: kit?.now,
    mcp,
    mcpUrl,
    async call(name, args) {
      const result = await mcp.callTool({ name, arguments: args });
      const [content] = result.content as { type: string; text: string }[];
      if (result.isError) throw new Error(content!.text);
      return JSON.parse(content!.text);
    },
    async read(uri) {
      const { contents } = await mcp.readResource({ uri });
      return JSON.parse((contents[0] as { text: string }).text);
    },
    async close() {
      await mcp.close();
      await core.close();
      store.close();
      repo.cleanup();
      home.cleanup();
    },
  };
}
