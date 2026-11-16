import * as z from "zod";
import { BadRequestError } from "../errors/domain";

/**
 * GitHub rechazó definitivamente el device flow o el refresh (el usuario no aprobó, el código venció, el
 * refresh token ya no vale, device flow sin habilitar en la App). Los fallos transitorios (red, 5xx) no
 * son de este tipo: suben como `Error` y no cambian el estado de la conexión.
 */
export class GitHubAuthError extends BadRequestError {
  override name = "GitHubAuthError";
  constructor(
    message: string,
    /** `denied`: el usuario canceló en github.com; `expired`: el código venció sin aprobarse; `rejected`: GitHub rechazó otra cosa. */
    readonly reason: "denied" | "expired" | "rejected" = "rejected",
  ) {
    super(message);
  }
}

export interface GitHubOAuthEndpoints {
  deviceCode: string;
  token: string;
}

export const GITHUB_OAUTH_ENDPOINTS: GitHubOAuthEndpoints = {
  deviceCode: "https://github.com/login/device/code",
  token: "https://github.com/login/oauth/access_token",
};

/** Lo que GitHub informa de un token de usuario de una App con "Expire user authorization tokens" (8 h y 6 meses). */
export interface GitHubAppTokens {
  accessToken: string;
  refreshToken: string;
  /** ms epoch. */
  accessExpiresAt: number;
  /** ms epoch. */
  refreshExpiresAt: number;
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** ms epoch. */
  expiresAt: number;
  /** Segundos mínimos entre dos sondeos. */
  interval: number;
}

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const DeviceCodeResponse = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.url(),
  expires_in: z.number().positive(),
  interval: z.number().positive(),
});

const TokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  refresh_token_expires_in: z.number().positive().optional(),
});

/** GitHub contesta los errores de OAuth con un 200 y `error` en el body; con `Accept: application/json` es JSON. */
const OAuthError = z.object({ error: z.string(), error_description: z.string().optional(), interval: z.number().optional() });

/** Los `error` que no dicen "esto ya no sirve" sino "inténtalo de nuevo". */
const TRANSIENT_ERRORS = new Set(["temporarily_unavailable", "server_error"]);

type OAuthReply = { kind: "ok"; body: unknown } | { kind: "error"; error: z.infer<typeof OAuthError> };

async function post(url: string, form: Record<string, string>, signal?: AbortSignal): Promise<OAuthReply> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form),
    ...(signal === undefined ? {} : { signal }),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`GitHub respondió ${response.status} sin JSON en ${url}.`);
  }
  const error = OAuthError.safeParse(body);
  if (error.success) {
    if (TRANSIENT_ERRORS.has(error.data.error)) throw new Error(`GitHub no pudo atender la solicitud (${oauthErrorText(error.data)}).`);
    return { kind: "error", error: error.data };
  }
  if (!response.ok) throw new Error(`GitHub respondió ${response.status} en ${url}.`);
  return { kind: "ok", body };
}

function oauthErrorText({ error, error_description }: z.infer<typeof OAuthError>): string {
  return error_description ? `${error}: ${error_description}` : error;
}

/** `POST /login/device/code`: el código que el usuario escribe en `verificationUri`. */
export async function requestDeviceCode(
  endpoints: GitHubOAuthEndpoints,
  clientId: string,
  now: number,
  signal?: AbortSignal,
): Promise<DeviceCode> {
  const reply = await post(endpoints.deviceCode, { client_id: clientId }, signal);
  if (reply.kind === "error") throw new GitHubAuthError(startFailure(reply.error));
  const body = DeviceCodeResponse.parse(reply.body);
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    expiresAt: now + body.expires_in * 1000,
    interval: body.interval,
  };
}

function startFailure(error: z.infer<typeof OAuthError>): string {
  if (error.error === "device_flow_disabled") {
    return 'La GitHub App no tiene el device flow habilitado: márcalo en su configuración ("Enable Device Flow", docs/github-app.md) y vuelve a intentarlo.';
  }
  if (error.error === "incorrect_client_credentials") {
    return "GitHub no reconoce el client_id de la GitHub App: revisa que sea el Client ID (empieza con Iv) y no el App ID (docs/github-app.md).";
  }
  return `GitHub rechazó iniciar el device flow (${oauthErrorText(error)}).`;
}

export interface PollOptions {
  endpoints: GitHubOAuthEndpoints;
  clientId: string;
  code: DeviceCode;
  now: () => number;
  /** Espera `ms`; rechaza con `signal.reason` si se aborta. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
}

/**
 * Sondea el token respetando `interval` (la primera vez también espera: el usuario recién ve el código) y
 * el `interval` nuevo que trae `slow_down` (+5 s). Sigue mientras GitHub conteste `authorization_pending` y
 * ante fallos transitorios (red, 5xx), hasta que el código venza; lanza `GitHubAuthError` si el usuario
 * cancela, el código vence o GitHub rechaza algo que no se arregla reintentando.
 */
export async function pollDeviceToken({ endpoints, clientId, code, now, sleep, signal }: PollOptions): Promise<GitHubAppTokens> {
  let interval = code.interval;
  let lastTransient: unknown;
  for (;;) {
    await sleep(interval * 1000, signal);
    if (now() >= code.expiresAt) throw expired(lastTransient);
    let reply: OAuthReply;
    try {
      reply = await post(endpoints.token, { client_id: clientId, device_code: code.deviceCode, grant_type: DEVICE_GRANT }, signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      lastTransient = error;
      continue;
    }
    if (reply.kind === "ok") return toTokens(reply.body, now());
    switch (reply.error.error) {
      case "authorization_pending":
        break;
      case "slow_down":
        interval = reply.error.interval ?? interval + 5;
        break;
      case "expired_token":
        throw expired(undefined);
      case "access_denied":
        throw new GitHubAuthError("Cancelaste la conexión en GitHub. Vuelve a intentarlo desde Clanker Yard.", "denied");
      default:
        throw new GitHubAuthError(startFailure(reply.error));
    }
  }
}

function expired(lastTransient: unknown): GitHubAuthError {
  const cause = lastTransient instanceof Error ? ` Último error de red: ${lastTransient.message}` : "";
  return new GitHubAuthError(`El código de GitHub venció sin que lo aprobaras: vuelve a intentarlo.${cause}`, "expired");
}

/**
 * Cambia el refresh token por tokens nuevos. El refresh token rota: el anterior y el access token anterior
 * dejan de valer, así que quien llama debe guardar el resultado antes de usarlo. Un token del device flow
 * se refresca solo con `client_id`: la App no tiene client secret.
 */
export async function refreshAppTokens(
  endpoints: GitHubOAuthEndpoints,
  { clientId, refreshToken }: { clientId: string; refreshToken: string },
  now: number,
): Promise<GitHubAppTokens> {
  const reply = await post(endpoints.token, { client_id: clientId, grant_type: "refresh_token", refresh_token: refreshToken });
  if (reply.kind === "error") {
    throw new GitHubAuthError(`GitHub rechazó renovar el token (${oauthErrorText(reply.error)}): vuelve a conectar la GitHub App.`);
  }
  return toTokens(reply.body, now);
}

function toTokens(body: unknown, now: number): GitHubAppTokens {
  const tokens = TokenResponse.parse(body);
  if (tokens.refresh_token === undefined || tokens.expires_in === undefined || tokens.refresh_token_expires_in === undefined) {
    throw new GitHubAuthError(
      'GitHub no devolvió un token que vence con refresh token: en la GitHub App marca "Expire user authorization tokens" (docs/github-app.md) y vuelve a conectar.',
    );
  }
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accessExpiresAt: now + tokens.expires_in * 1000,
    refreshExpiresAt: now + tokens.refresh_token_expires_in * 1000,
  };
}
