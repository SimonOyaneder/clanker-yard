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

/** Un PR del GitHub falso, con la forma de `GET /repos/{owner}/{repo}/pulls` (solo lo que el core lee). */
export interface FakePull {
  id: number;
  node_id: string;
  number: number;
  state: "open" | "closed";
  draft: boolean;
  title: string;
  body: string | null;
  html_url: string;
  head: { ref: string; sha: string; label: string };
  base: { ref: string; label: string };
}

export interface FakePullsApi {
  pulls: FakePull[];
  respond(request: FakeRequest): RecordedResponse | undefined;
}

/**
 * Los PRs de un repo como los sirve la API REST: `GET .../pulls` filtra por `state` (por defecto
 * `open`), `head` (`owner:branch`) y `base`, y `POST .../pulls` abre uno numerado, en draft si se pide.
 * Como GitHub, rechaza con 422 un PR sin título, uno cuya branch no existe en el remoto (`branchSha`
 * da su sha, o `undefined`) y un segundo PR abierto de la misma branch a la misma base.
 */
export function pullsApi({
  repo,
  branchSha,
}: {
  repo: string;
  branchSha(branch: string): string | undefined;
}): FakePullsApi {
  const [owner] = repo.split("/") as [string];
  const pulls: FakePull[] = [];
  const invalid = (...errors: object[]): RecordedResponse => ({
    status: 422,
    headers: {},
    body: { message: "Validation Failed", errors, documentation_url: "https://docs.github.com/rest/pulls/pulls#create-a-pull-request" },
  });

  return {
    pulls,
    respond({ method, path, query, body }) {
      if (path !== `/repos/${repo}/pulls`) return undefined;
      if (method === "GET") {
        const { state = "open", head, base } = query;
        const found = pulls.filter(
          (pull) =>
            (state === "all" || pull.state === state) &&
            (head === undefined || pull.head.label === head) &&
            (base === undefined || pull.base.ref === base),
        );
        return { status: 200, headers: {}, body: [...found].reverse() };
      }
      if (method !== "POST") return undefined;

      const input = (body ?? {}) as { title?: string; head?: string; base?: string; body?: string; draft?: boolean };
      if (!input.title) return invalid({ resource: "PullRequest", field: "title", code: "missing_field" });
      const sha = input.head ? branchSha(input.head) : undefined;
      if (!input.head || sha === undefined) return invalid({ resource: "PullRequest", field: "head", code: "invalid" });
      if (!input.base) return invalid({ resource: "PullRequest", field: "base", code: "invalid" });
      if (pulls.some((p) => p.state === "open" && p.head.ref === input.head && p.base.ref === input.base)) {
        return invalid({ resource: "PullRequest", code: "custom", message: `A pull request already exists for ${owner}:${input.head}.` });
      }
      const number = pulls.length + 1;
      const pull: FakePull = {
        id: 5_000_000 + number,
        node_id: `PR_kwDOfake${number}`,
        number,
        state: "open",
        draft: input.draft ?? false,
        title: input.title,
        body: input.body ?? null,
        html_url: `https://github.com/${repo}/pull/${number}`,
        head: { ref: input.head, sha, label: `${owner}:${input.head}` },
        base: { ref: input.base, label: `${owner}:${input.base}` },
      };
      pulls.push(pull);
      return { status: 201, headers: {}, body: pull };
    },
  };
}
