import { parseArgs } from "node:util";
import { SdkHttpError, StreamableHTTPClientTransport, isJSONRPCRequest, type JSONRPCMessage } from "@modelcontextprotocol/client";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { CliContext, Command } from "./command";

/** JSON-RPC "internal error". */
const INTERNAL_ERROR = -32603;

type Endpoint = Awaited<ReturnType<CliContext["mcpEndpoint"]>>;

/** Un transporte abierto contra un core, con el endpoint que se usó para abrirlo. */
interface Link {
  endpoint: Endpoint;
  transport: StreamableHTTPClientTransport;
}

/**
 * Puente stdio para los clientes MCP que no hablan HTTP (`docs/design.html#mcp`): reenvía cada mensaje
 * al `/mcp` del core (que levanta si no corre) y devuelve sus respuestas, sin interpretarlos, así que
 * lo que el core agregue al MCP llega sin tocar la CLI. El stdout es del protocolo: lo que diagnostica
 * va a stderr.
 *
 * El core cambia de puerto y de token en cada arranque, y el cliente MCP lanza este puente una sola vez
 * por sesión: si un envío falla y el core ya es otro, el puente se reconecta al nuevo (o lo levanta) y
 * avisa al cliente que relea tools y resources. Solo reenvía el mensaje si el core viejo seguro no lo
 * recibió (puerto cerrado o token rechazado); si se cortó a medias, lo contesta con un error para no
 * repetir una tool que quizás ya corrió.
 */
export const mcp: Command = {
  usage: "clanker mcp",
  async run(args, ctx) {
    parseArgs({ args, options: {} });
    const client = new StdioServerTransport();
    let closing = false;

    const open = async (endpoint: Endpoint): Promise<Link> => {
      const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
        requestInit: { headers: { authorization: `Bearer ${endpoint.token}` } },
      });
      transport.onmessage = (message) => {
        client.send(message).catch(report);
      };
      // Cerrar el transporte (al salir o al cambiar de core) aborta su stream: no es un fallo.
      transport.onerror = (error) => closing || link?.transport !== transport || report(error);
      await transport.start();
      return { endpoint, transport };
    };

    let link: Link | undefined;
    link = await open(await ctx.mcpEndpoint());
    let relinking: Promise<Link | undefined> | undefined;

    /** El link al core vivo si ya no es el de `failed`, o `undefined` si el core sigue siendo el mismo. */
    const relink = (failed: Link): Promise<Link | undefined> => {
      if (link !== failed) return Promise.resolve(link);
      relinking ??= (async () => {
        const endpoint = await ctx.mcpEndpoint();
        if (endpoint.url === failed.endpoint.url && endpoint.token === failed.endpoint.token) return undefined;
        const next = await open(endpoint);
        link = next;
        void failed.transport.close();
        process.stderr.write(`clanker mcp: el core cambió, ahora en ${endpoint.url}\n`);
        // El core nuevo puede ser otra versión: que el cliente relea lo que ofrece.
        await client.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
        await client.send({ jsonrpc: "2.0", method: "notifications/resources/list_changed" });
        return next;
      })().finally(() => (relinking = undefined));
      return relinking;
    };

    const forward = async (message: JSONRPCMessage): Promise<void> => {
      const used = link!;
      try {
        await used.transport.send(message);
      } catch (error) {
        const next = await relink(used).catch((cause: unknown) => {
          report(cause);
          return undefined;
        });
        if (!next) throw error;
        if (!neverArrived(error)) throw new Error("el core se reinició mientras atendía este pedido; vuelve a intentarlo", { cause: error });
        await next.transport.send(message);
      }
    };

    client.onmessage = (message) => {
      forward(message).catch((error: unknown) => answerWithError(client, message, error));
    };

    const closed = new Promise<void>((resolve) => {
      client.onclose = resolve;
      ctx.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    await client.start();
    await closed;
    closing = true;
    await Promise.all([link.transport.close(), client.close()]);
  },
};

/** Si el envío falló antes de que el core lo procesara: nadie escuchaba en el puerto o el token ya no vale. */
function neverArrived(error: unknown): boolean {
  if (error instanceof SdkHttpError) return error.status === 401 || error.status === 403;
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  return cause?.code === "ECONNREFUSED";
}

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
