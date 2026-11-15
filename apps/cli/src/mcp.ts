import { parseArgs } from "node:util";
import { StreamableHTTPClientTransport, isJSONRPCRequest, type JSONRPCMessage } from "@modelcontextprotocol/client";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { Command } from "./cli";

/** JSON-RPC "internal error". */
const INTERNAL_ERROR = -32603;

/**
 * Puente stdio para los clientes MCP que no hablan HTTP (`docs/design.html#mcp`): reenvía cada mensaje
 * al `/mcp` del core (que levanta si no corre) y devuelve sus respuestas, sin interpretarlos, así que
 * lo que el core agregue al MCP llega sin tocar la CLI. El stdout es del protocolo: lo que diagnostica
 * va a stderr.
 */
export const mcp: Command = {
  usage: "clanker mcp",
  async run(args, ctx) {
    parseArgs({ args, options: {} });
    const { url, token } = await ctx.mcpEndpoint();
    const core = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
    const client = new StdioServerTransport();

    client.onmessage = (message) => {
      core.send(message).catch((error: unknown) => answerWithError(client, message, error));
    };
    core.onmessage = (message) => {
      client.send(message).catch(report);
    };
    // Cerrar el transporte aborta su stream: no es un fallo.
    let closing = false;
    core.onerror = (error) => closing || report(error);

    const closed = new Promise<void>((resolve) => {
      client.onclose = resolve;
      ctx.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    await core.start();
    await client.start();
    await closed;
    closing = true;
    await Promise.all([core.close(), client.close()]);
  },
};

/** Sin respuesta el cliente MCP se queda esperando: un request que no llegó al core se contesta con un error. */
async function answerWithError(client: StdioServerTransport, message: JSONRPCMessage, error: unknown): Promise<void> {
  report(error);
  if (!isJSONRPCRequest(message)) return;
  const detail = error instanceof Error ? error.message : String(error);
  await client
    .send({ jsonrpc: "2.0", id: message.id, error: { code: INTERNAL_ERROR, message: `No se pudo hablar con el core: ${detail}` } })
    .catch(report);
}

function report(error: unknown): void {
  process.stderr.write(`clanker mcp: ${error instanceof Error ? error.message : String(error)}\n`);
}
