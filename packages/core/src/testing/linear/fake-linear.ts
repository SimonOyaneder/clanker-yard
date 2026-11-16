import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createFakeWorkspace, type FakeWorkspace } from "./fake-workspace";
import type { LinearEndpoints } from "../../linear/oauth";

export interface FakeLinearOptions {
  clientId: string;
  /** El `urlKey` que devuelve `organization`. */
  workspace?: string;
  /** Segundos de vida del access token. */
  expiresIn?: number;
}

export interface FakeLinear {
  endpoints: LinearEndpoints;
  /** Los datos que sirve `/graphql` (equipos, issues, comentarios...), para armarlos desde el test. */
  workspace: FakeWorkspace;
  /** Los bodies de `/oauth/token`, en orden. */
  tokenRequests: Record<string, string>[];
  /** Mientras tenga valor, `/oauth/token` contesta eso a un `refresh_token` sin validarlo. */
  refreshFailure: { status: number; error: string } | undefined;
  /** El access token más reciente que emitió, y el refresh token que lo acompaña. */
  latest(): { accessToken: string; refreshToken: string };
  close(): Promise<void>;
}

/**
 * Un Linear falso en 127.0.0.1 con lo justo del OAuth con PKCE: `/oauth/authorize` redirige con un código,
 * `/oauth/token` valida PKCE, `client_id` y `redirect_uri` y rota el refresh token (cada uno vale una vez, como
 * en Linear), y `/graphql` ejecuta las operaciones contra el esquema de Linear (`FakeWorkspace`) solo con un access
 * token vigente.
 */
export async function startFakeLinear({
  clientId,
  workspace = "clanker-yard",
  expiresIn = 86399,
}: FakeLinearOptions): Promise<FakeLinear> {
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  const accessTokens = new Set<string>();
  const refreshTokens = new Set<string>();
  let issued = 0;
  let latest = { accessToken: "", refreshToken: "" };
  const tokenRequests: Record<string, string>[] = [];
  const workspaceData = createFakeWorkspace({ workspace });

  function issue() {
    issued += 1;
    latest = { accessToken: `UNIQUE-linear-access-${issued}`, refreshToken: `UNIQUE-linear-refresh-${issued}` };
    accessTokens.add(latest.accessToken);
    refreshTokens.add(latest.refreshToken);
    return {
      access_token: latest.accessToken,
      refresh_token: latest.refreshToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      scope: "read write",
    };
  }

  const fake: FakeLinear = {
    endpoints: { authorize: "", token: "", graphql: "" },
    workspace: workspaceData,
    tokenRequests,
    refreshFailure: undefined,
    latest: () => latest,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/oauth/authorize") {
      const q = url.searchParams;
      if (q.get("client_id") !== clientId || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) {
        return json(400, { error: "invalid_request" });
      }
      const code = randomBytes(8).toString("hex");
      codes.set(code, { challenge: q.get("code_challenge")!, redirectUri: q.get("redirect_uri")! });
      const redirect = new URL(q.get("redirect_uri")!);
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", q.get("state")!);
      res.writeHead(302, { location: redirect.toString() });
      return res.end();
    }

    if (url.pathname === "/oauth/token" && req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
      tokenRequests.push(form);
      if (form.client_id !== clientId) return json(401, { error: "invalid_client" });

      if (form.grant_type === "authorization_code") {
        const grant = codes.get(form.code ?? "");
        codes.delete(form.code ?? "");
        const verifierHash = createHash("sha256")
          .update(form.code_verifier ?? "")
          .digest("base64url");
        if (!grant || grant.redirectUri !== form.redirect_uri || grant.challenge !== verifierHash) {
          return json(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
        }
        return json(200, issue());
      }
      if (form.grant_type === "refresh_token") {
        if (fake.refreshFailure) {
          return json(fake.refreshFailure.status, { error: fake.refreshFailure.error });
        }
        if (!refreshTokens.delete(form.refresh_token ?? "")) {
          return json(400, { error: "invalid_grant", error_description: "refresh token already used" });
        }
        return json(200, issue());
      }
      return json(400, { error: "unsupported_grant_type" });
    }

    if (url.pathname === "/graphql" && req.method === "POST") {
      const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
      if (!accessTokens.has(token)) return json(401, { errors: [{ message: "Unauthorized" }] });
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const { query, variables } = JSON.parse(Buffer.concat(chunks).toString()) as {
        query: string;
        variables?: Record<string, unknown>;
      };
      const result = await workspaceData.execute(query, variables);
      return json(result.errors ? 400 : 200, result);
    }
    json(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.endpoints = { authorize: `${base}/oauth/authorize`, token: `${base}/oauth/token`, graphql: `${base}/graphql` };
  return fake;
}
