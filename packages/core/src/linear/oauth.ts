import { createHash, randomBytes } from "node:crypto";
import * as z from "zod";
import { BadRequestError } from "../errors/domain";

/**
 * Linear rechazó definitivamente la autorización o el refresh (el usuario no aprobó, el código o el
 * refresh token ya no valen, la app fue revocada). Los fallos transitorios (red, 5xx) no son de este
 * tipo: suben como `Error` y no cambian el estado de la conexión.
 */
export class LinearAuthError extends BadRequestError {
  override name = "LinearAuthError";
}

export interface LinearEndpoints {
  authorize: string;
  token: string;
  graphql: string;
}

export const LINEAR_ENDPOINTS: LinearEndpoints = {
  authorize: "https://linear.app/oauth/authorize",
  token: "https://api.linear.app/oauth/token",
  graphql: "https://api.linear.app/graphql",
};

/** Lo que Clanker Yard pide a Linear: leer y escribir issues y comentarios como el usuario. */
export const LINEAR_SCOPES = ["read", "write"];

/** El access token dura 24 h y el refresh token 30 días (`docs/design.html#integraciones`). */
export const LINEAR_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface LinearTokens {
  accessToken: string;
  refreshToken: string;
  /** ms epoch. */
  accessExpiresAt: number;
  scopes: string[];
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function authorizeUrl(
  endpoints: LinearEndpoints,
  params: { clientId: string; redirectUri: string; state: string; challenge: string },
): string {
  const url = new URL(endpoints.authorize);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    scope: LINEAR_SCOPES.join(","),
    state: params.state,
    code_challenge: params.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
  // Las OAuth apps anteriores a dic 2023 reciben un arreglo.
  scope: z.union([z.string(), z.array(z.string())]),
});

/** Los 4xx con que un servidor OAuth dice "esto ya no sirve"; el resto de los errores es transitorio. */
const DEFINITIVE_STATUSES = new Set([400, 401, 403]);

async function requestTokens(
  endpoints: LinearEndpoints,
  form: Record<string, string>,
  now: number,
  previousRefreshToken?: string,
): Promise<LinearTokens> {
  const response = await fetch(endpoints.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  if (!response.ok) {
    const detail = await describeOAuthError(response);
    if (DEFINITIVE_STATUSES.has(response.status)) {
      throw new LinearAuthError(`Linear rechazó la solicitud de tokens (${detail}).`);
    }
    throw new Error(`Linear respondió ${response.status} al pedir tokens (${detail}).`);
  }
  const body = TokenResponse.parse(await response.json());
  const refreshToken = body.refresh_token ?? previousRefreshToken;
  if (refreshToken === undefined) {
    throw new LinearAuthError(
      "Linear no devolvió un refresh token: revisa que la OAuth app de Linear use refresh tokens.",
    );
  }
  return {
    accessToken: body.access_token,
    refreshToken,
    accessExpiresAt: now + body.expires_in * 1000,
    scopes: typeof body.scope === "string" ? body.scope.split(/[ ,]+/).filter(Boolean) : body.scope,
  };
}

async function describeOAuthError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const { error, error_description } = z
      .object({ error: z.string(), error_description: z.string().optional() })
      .parse(JSON.parse(text));
    return error_description ? `${error}: ${error_description}` : error;
  } catch {
    return `HTTP ${response.status}`;
  }
}

export function exchangeCode(
  endpoints: LinearEndpoints,
  params: { clientId: string; code: string; verifier: string; redirectUri: string },
  now: number,
): Promise<LinearTokens> {
  return requestTokens(
    endpoints,
    {
      grant_type: "authorization_code",
      client_id: params.clientId,
      code: params.code,
      code_verifier: params.verifier,
      redirect_uri: params.redirectUri,
    },
    now,
  );
}

/** Un token emitido con PKCE se refresca solo con `client_id`: la app no tiene client secret. */
export function refreshTokens(
  endpoints: LinearEndpoints,
  params: { clientId: string; refreshToken: string },
  now: number,
): Promise<LinearTokens> {
  return requestTokens(
    endpoints,
    { grant_type: "refresh_token", client_id: params.clientId, refresh_token: params.refreshToken },
    now,
    params.refreshToken,
  );
}

const WorkspaceResponse = z.object({
  data: z.object({ organization: z.object({ urlKey: z.string().min(1) }) }),
});

/** El `urlKey` del workspace del token (`clanker-yard` en `linear.app/clanker-yard`): es el nombre de la cuenta. */
export async function fetchWorkspaceKey(endpoints: LinearEndpoints, accessToken: string): Promise<string> {
  const response = await fetch(endpoints.graphql, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ query: "{ organization { urlKey } }" }),
  });
  if (!response.ok) {
    throw new Error(`Linear respondió ${response.status} al consultar el workspace.`);
  }
  const body = await response.json();
  const parsed = WorkspaceResponse.safeParse(body);
  if (!parsed.success) {
    throw new Error(`Linear no devolvió el workspace del token: ${JSON.stringify(body)}`);
  }
  return parsed.data.data.organization.urlKey;
}
