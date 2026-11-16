import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ClientOrigin, UI_KEY_HEADER } from "@clanker/api";
import { hashUiKey } from "@clanker/api/node";
import { ORPCError, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/node";
import { newId } from "../store/conventions";
import { createMcpHandler } from "../mcp/server";
import { createDevRouter, type DevTools } from "./dev-router";
import { createRouter, type CoreContext, type CoreRouter, type RouterDeps } from "./router";

export interface StartServerOptions extends Pick<
  RouterDeps,
  | "store"
  | "connections"
  | "issues"
  | "projects"
  | "packs"
  | "repos"
  | "repoConfigSync"
  | "repoConfigExport"
  | "projectConfigs"
  | "recipeTester"
  | "runs"
  | "queue"
  | "trackerProjects"
  | "scheduler"
  | "lanes"
  | "breakers"
  | "flows"
  | "onPrChange"
  | "artifacts"
  | "decisions"
  | "learnings"
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
  /**
   * SHA-256 (hex) de la llave de la app. Sin ella, o con otra, ninguna llamada puede declararse `ui`:
   * `x-clanker-origin` lo escribe quien llama y el token está en `core.json`, así que solo la llave
   * (que `core.json` no tiene) distingue a la app de un agente.
   */
  uiKeyHash?: string;
  /** Monta el router `dev` y sus tools MCP (`DevTools`). Sin él un core nunca los sirve. */
  dev?: DevTools;
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

/** oRPC rechaza una entrada inválida con "Input validation failed" y deja la causa en `data.issues`; el CLI solo imprime el mensaje. */
function explainInputValidation(error: unknown): unknown {
  if (!(error instanceof ORPCError) || error.code !== "BAD_REQUEST" || error.message !== "Input validation failed") return error;
  const issues: unknown = (error.data as { issues?: unknown } | undefined)?.issues;
  if (!Array.isArray(issues) || issues.length === 0) return error;
  const lines = issues.map((issue: { message?: string; path?: PropertyKey[] }) => {
    const path = (issue.path ?? []).map(String).join(".");
    return `${path === "" ? "" : `${path}: `}${issue.message ?? "inválido"}`;
  });
  return new ORPCError("BAD_REQUEST", { message: `Entrada inválida: ${lines.join("; ")}`, data: error.data, cause: error });
}

/**
 * Sirve la API por HTTP en 127.0.0.1 con puerto aleatorio: `/rpc` (oRPC) y `/mcp` (MCP). Antes de
 * cualquiera, cada request debe traer el token y su Host y su Origin deben ser los esperados (contra DNS
 * rebinding: una página ajena que apunte su dominio a 127.0.0.1 manda otro Host u Origin). `/rpc` además
 * pide un `x-clanker-origin` válido, y `ui` solo con la llave de la app (`uiKeyHash`); `/mcp` es siempre origin `mcp`.
 */
export async function startServer(opts: StartServerOptions): Promise<CoreServer> {
  const token = randomBytes(32).toString("base64url");
  const bootId = opts.bootId ?? newId("boot");
  const allowedOrigins = new Set(opts.allowedOrigins);
  const router = createRouter({ ...opts, bootId, startedAt: Date.now() });
  const served = opts.dev ? { ...router, dev: createDevRouter({ flows: opts.flows, dev: opts.dev }) } : router;
  const mcp = createMcpHandler(served, opts.coreVersion, { dev: opts.dev !== undefined });
  const handler = new RPCHandler(served, {
    interceptors: [
      onError((error) => {
        if (!(error instanceof ORPCError)) console.error(error);
      }),
      async ({ next }) => {
        try {
          return await next();
        } catch (error) {
          throw explainInputValidation(error);
        }
      },
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
    const uiKey = hasUiKey(req.headers[UI_KEY_HEADER], opts.uiKeyHash);
    if (origin.data === "ui" && !uiKey) {
      return reject(res, { status: 403, message: "El origin ui exige la llave de la app: solo la app puede declararse ui; usa cli o mcp." });
    }
    const { matched } = await handler.handle(req, res, { prefix: "/rpc", context: { origin: origin.data, uiKey } satisfies CoreContext });
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

function hasUiKey(header: string | string[] | undefined, expectedHash: string | undefined): boolean {
  if (expectedHash === undefined || typeof header !== "string") return false;
  const given = Buffer.from(hashUiKey(header));
  const wanted = Buffer.from(expectedHash);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

function hasBearer(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const wanted = Buffer.from(token);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}
