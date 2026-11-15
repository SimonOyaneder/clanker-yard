import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ClientOrigin } from "@clanker/api";
import { ORPCError, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/node";
import { newId } from "../store/conventions";
import { createMcpHandler } from "../mcp/server";
import { createRouter, type CoreContext, type CoreRouter, type RouterDeps } from "./router";

export interface StartServerOptions extends Pick<
  RouterDeps,
  | "store"
  | "connections"
  | "issues"
  | "projects"
  | "packs"
  | "repos"
  | "recipeTester"
  | "runs"
  | "queue"
  | "flows"
  | "artifacts"
  | "decisions"
  | "defs"
  | "legacyImport"
  | "coreVersion"
  | "dataDir"
  | "onShutdown"
> {
  /** Identifica a este arranque; por defecto uno nuevo. Quien arma los módulos que lo necesitan (Flows) lo fija antes. */
  bootId?: string;
  /** Origins de navegador que pueden llamar a la API (la ventana de la app). Cualquier otro Origin se rechaza. */
  allowedOrigins?: readonly string[];
}

export interface CoreServer {
  /** Endpoint `/rpc`, el `url` de `createClient`. El MCP (Streamable HTTP) está en `/mcp` del mismo puerto, con el mismo token. */
  url: string;
  port: number;
  /** 32 bytes aleatorios por arranque, en base64url. Va en `Authorization: Bearer`. */
  token: string;
  bootId: string;
  router: CoreRouter;
  /** Corta los streams abiertos y deja de escuchar. */
  close(): Promise<void>;
}

/**
 * Sirve la API por HTTP en 127.0.0.1 con puerto aleatorio: `/rpc` (oRPC) y `/mcp` (MCP). Antes de
 * cualquiera, cada request debe traer el token y su Host y su Origin deben ser los esperados (contra DNS
 * rebinding: una página ajena que apunte su dominio a 127.0.0.1 manda otro Host u Origin). `/rpc` además
 * pide un `x-clanker-origin` válido; `/mcp` es siempre origin `mcp`.
 */
export async function startServer(opts: StartServerOptions): Promise<CoreServer> {
  const token = randomBytes(32).toString("base64url");
  const bootId = opts.bootId ?? newId("boot");
  const allowedOrigins = new Set(opts.allowedOrigins);
  const router = createRouter({ ...opts, bootId, startedAt: Date.now() });
  const mcp = createMcpHandler(router, opts.coreVersion);
  const handler = new RPCHandler(router, {
    interceptors: [
      onError((error) => {
        if (!(error instanceof ORPCError)) console.error(error);
      }),
    ],
  });

  const server = createServer(async (req, res) => {
    const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    const rejection = authorize(req, { host, token, allowedOrigins });
    if (rejection) return reject(res, rejection);
    if (new URL(req.url ?? "/", `http://${host}`).pathname === "/mcp") return mcp(req, res);

    const origin = ClientOrigin.safeParse(req.headers["x-clanker-origin"]);
    if (!origin.success) {
      return reject(res, { status: 400, message: "Falta x-clanker-origin: debe ser ui, cli o mcp." });
    }
    const { matched } = await handler.handle(req, res, { prefix: "/rpc", context: { origin: origin.data } satisfies CoreContext });
    if (!matched) res.writeHead(404).end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/rpc`,
    port,
    token,
    bootId,
    router,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

function reject(res: ServerResponse, { status, message }: Rejection): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(message);
}

interface Rejection {
  status: number;
  message: string;
}

/** El rechazo con su status HTTP, o `undefined` si el Host, el Origin y el token son los esperados. */
function authorize(
  req: IncomingMessage,
  expected: { host: string; token: string; allowedOrigins: ReadonlySet<string> },
): Rejection | undefined {
  if (req.headers.host !== expected.host) {
    return { status: 403, message: `Host no permitido: se esperaba ${expected.host}.` };
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !expected.allowedOrigins.has(origin)) {
    return { status: 403, message: `Origin no permitido: ${origin}.` };
  }
  if (!hasBearer(req.headers.authorization, expected.token)) {
    return {
      status: 401,
      message: "Falta el token: envía Authorization: Bearer <token> (está en core.json).",
    };
  }
}

function hasBearer(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const wanted = Buffer.from(token);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}
