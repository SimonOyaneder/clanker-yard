import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { GitHubOAuthEndpoints } from "../../github/device-flow";

export interface FakeGitHubOAuthOptions {
  clientId: string;
  /** El reloj de las conexiones: GitHub mide el intervalo entre sondeos con él, y los vencimientos también. */
  now: () => number;
  userCode?: string;
  /** Segundos mínimos entre sondeos. */
  interval?: number;
  /** Segundos de vida del código. */
  codeTtl?: number;
  /** `false`: la App no tiene el device flow habilitado (`device_flow_disabled`). */
  deviceFlowEnabled?: boolean;
}

export interface FakeGitHubOAuthRequest {
  endpoint: "device_code" | "access_token";
  form: Record<string, string>;
  /** `now()` cuando llegó. */
  at: number;
}

export interface FakeGitHubOAuth {
  endpoints: GitHubOAuthEndpoints;
  /** Las requests que llegaron, en orden. */
  requests: FakeGitHubOAuthRequest[];
  /** El usuario escribió el código en github.com y aprobó (o abrió `verification_uri`, que hace lo mismo). */
  approve(): void;
  /** El usuario canceló en github.com. */
  deny(): void;
  /** El próximo sondeo recibe `slow_down`, aunque haya respetado el intervalo. */
  slowDown(): void;
  /** Todos los access tokens emitidos dejan de valer, sin que el core lo sepa (GitHub lo da por vencido antes que su reloj). */
  expireAccessTokens(): void;
  /** Todos los refresh tokens emitidos dejan de valer (pasaron 6 meses, o el usuario revocó la App). */
  expireRefreshTokens(): void;
  /** El access token y el refresh token más recientes. */
  latest(): { accessToken: string; refreshToken: string };
  /** Si GitHub aceptaría este access token: lo rota el refresh, y el anterior deja de valer. */
  isAccessTokenValid(token: string): boolean;
  close(): Promise<void>;
}

/**
 * Un OAuth de GitHub falso en 127.0.0.1 con el device flow de una GitHub App y el refresh de su token de
 * usuario, como lo documenta GitHub (`generating-a-user-access-token-for-a-github-app`): los errores salen
 * con un 200 y `error` en el body; sondear antes de `interval` da `slow_down` y sube el intervalo 5 s; el
 * refresh token rota (cada uno vale una vez) y no pide client secret.
 */
export async function startFakeGitHubOAuth({
  clientId,
  now,
  userCode = "WDJB-MJHT",
  interval = 5,
  codeTtl = 900,
  deviceFlowEnabled = true,
}: FakeGitHubOAuthOptions): Promise<FakeGitHubOAuth> {
  const requests: FakeGitHubOAuthRequest[] = [];
  let baseUrl = "";
  let issued = 0;
  let device: { code: string; expiresAt: number; requiredInterval: number; lastPoll: number | undefined; state: "waiting" | "approved" | "denied" } | undefined;
  let slowDownNext = false;
  let latest = { accessToken: "", refreshToken: "" };
  const accessTokens = new Set<string>();
  const refreshTokens = new Set<string>();

  function issue() {
    issued += 1;
    latest = { accessToken: `ghu_UNIQUE-access-${issued}`, refreshToken: `ghr_UNIQUE-refresh-${issued}` };
    accessTokens.add(latest.accessToken);
    refreshTokens.add(latest.refreshToken);
    return {
      access_token: latest.accessToken,
      expires_in: 28800,
      refresh_token: latest.refreshToken,
      refresh_token_expires_in: 15897600,
      scope: "",
      token_type: "bearer",
    };
  }

  function tokenEndpoint(form: Record<string, string>): Record<string, unknown> {
    if (form.grant_type === "refresh_token") {
      if (!refreshTokens.delete(form.refresh_token ?? "")) {
        return { error: "bad_refresh_token", error_description: "The refresh token passed is incorrect or expired." };
      }
      accessTokens.delete(latest.accessToken);
      return issue();
    }
    if (form.grant_type !== "urn:ietf:params:oauth:grant-type:device_code") return { error: "unsupported_grant_type" };
    if (!device || form.device_code !== device.code) return { error: "incorrect_device_code" };
    if (now() >= device.expiresAt) return { error: "expired_token" };
    const tooSoon = device.lastPoll !== undefined && now() - device.lastPoll < device.requiredInterval * 1000;
    device.lastPoll = now();
    if (tooSoon || slowDownNext) {
      slowDownNext = false;
      device.requiredInterval += 5;
      return { error: "slow_down", interval: device.requiredInterval };
    }
    if (device.state === "denied") return { error: "access_denied" };
    if (device.state === "waiting") return { error: "authorization_pending" };
    device = undefined;
    return issue();
  }

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
    const path = new URL(req.url ?? "/", "http://fake").pathname;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    // La página donde el usuario escribe el código: abrirla es aprobar (los E2E no tienen navegador ni github.com).
    if (req.method === "GET" && path === "/login/device") {
      if (device) device.state = "approved";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end("<!doctype html><title>GitHub falso</title><p>Aprobado.</p>");
    }
    if (req.method !== "POST" || req.headers.accept !== "application/json") {
      return json(404, { message: "Not Found" });
    }

    if (path === "/login/device/code") {
      requests.push({ endpoint: "device_code", form, at: now() });
      if (form.client_id !== clientId) return json(200, { error: "incorrect_client_credentials" });
      if (!deviceFlowEnabled) return json(200, { error: "device_flow_disabled" });
      device = { code: `UNIQUE-device-${requests.length}`, expiresAt: now() + codeTtl * 1000, requiredInterval: interval, lastPoll: undefined, state: "waiting" };
      return json(200, {
        device_code: device.code,
        user_code: userCode,
        verification_uri: `${baseUrl}/login/device`,
        expires_in: codeTtl,
        interval,
      });
    }
    if (path === "/login/oauth/access_token") {
      requests.push({ endpoint: "access_token", form, at: now() });
      if (form.client_id !== clientId) return json(200, { error: "incorrect_client_credentials" });
      return json(200, tokenEndpoint(form));
    }
    return json(404, { message: "Not Found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    endpoints: { deviceCode: `${baseUrl}/login/device/code`, token: `${baseUrl}/login/oauth/access_token` },
    requests,
    approve() {
      if (device) device.state = "approved";
    },
    deny() {
      if (device) device.state = "denied";
    },
    slowDown() {
      slowDownNext = true;
    },
    expireAccessTokens() {
      accessTokens.clear();
    },
    expireRefreshTokens() {
      refreshTokens.clear();
    },
    latest: () => latest,
    isAccessTokenValid: (token) => accessTokens.has(token),
    close: () =>
      new Promise((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
