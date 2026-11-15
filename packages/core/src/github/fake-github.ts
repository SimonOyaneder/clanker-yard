import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/** Una respuesta grabada de la API de GitHub (`fixtures/*.json`). */
export interface RecordedResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export function recorded(name: string): RecordedResponse {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
}

export interface FakeRequest {
  method: string;
  /** Ruta sin query: `/repos/octocat/secret-project/issues`. */
  path: string;
  /** La query string: `?head=a:b&state=all` es `{ head: "a:b", state: "all" }`. */
  query: Record<string, string>;
  authorization: string | undefined;
  /** El header `If-None-Match` de un GET condicional. */
  ifNoneMatch: string | undefined;
  /** El body JSON de un POST (GraphQL: `{ query, variables }`); `undefined` si no hay. */
  body: unknown;
}

export interface FakeGitHub {
  baseUrl: string;
  /** Las requests que llegaron, en orden. */
  requests: FakeRequest[];
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Un GitHub falso en 127.0.0.1: `respond` decide por request; sin respuesta contesta 404. */
export async function startFakeGitHub(
  respond: (request: FakeRequest) => RecordedResponse | undefined,
): Promise<FakeGitHub> {
  const requests: FakeRequest[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    const text = await readBody(req);
    const url = new URL(req.url ?? "/", "http://fake");
    const request: FakeRequest = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: req.headers.authorization,
      ifNoneMatch: req.headers["if-none-match"],
      body: text === "" ? undefined : JSON.parse(text),
    };
    requests.push(request);
    const response = respond(request) ?? {
      status: 404,
      headers: {},
      body: { message: "Not Found", status: "404" },
    };
    res.writeHead(response.status, { "content-type": "application/json; charset=utf-8", ...response.headers });
    res.end(JSON.stringify(response.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

/**
 * Un token válido con todos los permisos: `GET /user`, un repo público y uno privado, y un 200 en cada
 * probe. `overrides` pisa una ruta (`"GET /user"`) o la quita con `undefined`.
 */
export function healthyGitHub(
  overrides: Record<string, RecordedResponse | undefined> = {},
): (request: FakeRequest) => RecordedResponse | undefined {
  const routes: Record<string, RecordedResponse> = {
    "GET /user": recorded("user.ok"),
    "GET /user/repos": recorded("repos.ok"),
    "GET /repos/octocat/secret-project/commits": recorded("probe.ok"),
    "GET /repos/octocat/secret-project/pulls": recorded("probe.ok"),
    "GET /repos/octocat/secret-project/issues": recorded("probe.ok"),
    "GET /repos/octocat/secret-project/commits/trunk/check-runs": recorded("probe.ok"),
  };
  return (request) => {
    const key = `${request.method} ${request.path}`;
    return key in overrides ? overrides[key] : routes[key];
  };
}
