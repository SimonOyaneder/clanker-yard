import { join } from "node:path";
import { createClient, type Client } from "@clanker/api";
import { createConnections, createFileSecrets, openStore, startCore, type Core, type Store } from "@clanker/core";
import { Client as McpClient, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createFakeRuntime } from "./fake-runtime";
import { tempGitRepo, type TempGitRepo } from "./git";
import { seedDb, type TestHome } from "./home";

export interface McpHarness {
  store: Store;
  repo: TempGitRepo;
  core: Core;
  /** La API del core, como la UI o la CLI. */
  api: Client;
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
 * esperar y uno muy chico deja colgado al agente en su primer evento con tiempo.
 */
export async function startMcpHarness({ fixtures, speed }: { fixtures: string; speed: number }): Promise<McpHarness> {
  const home: TestHome = seedDb("empty");
  const store = openStore({ path: home.dbPath });
  const repo = tempGitRepo({});
  const core = await startCore({
    store,
    dataDir: home.path,
    connections: createConnections(store, createFileSecrets({ dir: join(home.path, "secrets") })),
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
