import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventType } from "@clanker/api";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createBreakers, GITHUB_SCOPE } from "../breakers/breakers";
import { createConnections, GITHUB_REFRESH_MARGIN_MS, type Connections } from "../connections/connections";
import { createFileSecrets } from "../secrets/encrypted-file";
import type { Secrets } from "../secrets/secrets";
import { openStore, type Store } from "../store/store";
import { GitHubAuthError, pollDeviceToken, requestDeviceCode } from "./device-flow";
import { recorded, startFakeGitHub, type FakeGitHub } from "./fake-github";
import { startFakeGitHubOAuth, type FakeGitHubOAuth } from "./fake-github-oauth";

const NOW = 1_700_000_000_000;
const HOUR_MS = 60 * 60 * 1000;
const CLIENT_ID = "Iv23liTESTTESTTEST";
const ACCOUNT = "octocat";
const SESSION_REF = `connection:github:${ACCOUNT}`;

let dir: string;
let store: Store;
let secrets: Secrets;
let oauth: FakeGitHubOAuth;
let api: FakeGitHub;
let connections: Connections;
let clock: number;
/** Las esperas que pidió el sondeo, en ms. */
let sleeps: number[];
/** Se llama en cada espera (n desde 1) antes de avanzar el reloj: el "usuario" actúa aquí. */
let onSleep: ((n: number, signal: AbortSignal) => void | Promise<void>) | undefined;

const sleep = async (ms: number, signal: AbortSignal) => {
  sleeps.push(ms);
  await onSleep?.(sleeps.length, signal);
  if (signal.aborted) throw signal.reason;
  clock += ms;
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "clanker-device-flow-"));
  store = openStore({ path: join(dir, "clanker.db") });
  secrets = createFileSecrets({ dir: join(dir, "secrets") });
  clock = NOW;
  sleeps = [];
  onSleep = undefined;
  oauth = await startFakeGitHubOAuth({ clientId: CLIENT_ID, now: () => clock });
  // GitHub acepta solo el access token vigente que emitió el OAuth falso.
  api = await startFakeGitHub((request) => {
    const bearer = request.authorization?.match(/^bearer (.+)$/i)?.[1];
    if (!bearer || !oauth.isAccessTokenValid(bearer)) return recorded("user.bad-credentials");
    return request.method === "GET" && request.path === "/user" ? recorded("user.ok") : undefined;
  });
  connections = connectionsWith({ clientId: CLIENT_ID });
});

afterEach(async () => {
  await oauth.close();
  await api.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function connectionsWith(githubApp: { clientId: string } | undefined) {
  return createConnections(store, secrets, {
    now: () => clock,
    github: { baseUrl: api.baseUrl },
    ...(githubApp ? { githubApp: { ...githubApp, endpoints: oauth.endpoints, sleep } } : {}),
  });
}

/** Resuelve con el próximo evento de ese tipo; hay que pedirlo antes de la acción que lo emite. */
function next(type: EventType) {
  return new Promise<{ payload: Record<string, unknown> }>((resolve) => {
    const off = store.events.subscribe((event) => {
      off();
      resolve(event);
    }, { types: [type] });
  });
}

/** El usuario aprueba en la segunda espera (después de un `authorization_pending`) y la cuenta se conecta. */
async function connectApp() {
  sleeps = [];
  onSleep = (n) => {
    if (n === 2) oauth.approve();
  };
  const connected = next("connection.changed");
  const flow = await connections.startDeviceFlow("ui");
  await connected;
  onSleep = undefined;
  return flow;
}

const refreshRequests = () => oauth.requests.filter((r) => r.form.grant_type === "refresh_token");

describe("startDeviceFlow", () => {
  test("código, sondeo con authorization_pending y aprobación: la cuenta queda conectada con la App", async () => {
    const flow = await connectApp();

    expect(flow).toEqual({
      userCode: "WDJB-MJHT",
      verificationUri: expect.stringMatching(/\/login\/device$/),
      expiresIn: 900,
    });
    // Espera el intervalo antes de cada sondeo, también el primero.
    expect(sleeps).toEqual([5000, 5000]);
    expect(oauth.requests.map((r) => r.endpoint)).toEqual(["device_code", "access_token", "access_token"]);
    expect(oauth.requests[0]!.form).toEqual({ client_id: CLIENT_ID });
    expect(oauth.requests[2]!.form).toMatchObject({
      client_id: CLIENT_ID,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: expect.any(String),
    });
    expect(connections.list()).toEqual([
      { provider: "github", account: ACCOUNT, scopes: [], status: "active", auth: "app", expiresAt: clock + 15_897_600_000 },
    ]);
    expect(await connections.token("github", ACCOUNT)).toBe(oauth.latest().accessToken);
  });

  test("los tokens quedan solo en Secrets: ni list ni los eventos los llevan, y no hay client secret", async () => {
    await connectApp();
    const { accessToken, refreshToken } = oauth.latest();

    expect(JSON.parse((await secrets.get(SESSION_REF))!)).toEqual({ accessToken, refreshToken, accessExpiresAt: clock + 8 * HOUR_MS });
    const visible = JSON.stringify([connections.list(), store.events.since(0)]);
    expect(visible).not.toContain(accessToken);
    expect(visible).not.toContain(refreshToken);
    expect(JSON.stringify(oauth.requests)).not.toContain("client_secret");
  });

  test("slow_down sube el intervalo al que informa GitHub y se respeta en los sondeos siguientes", async () => {
    onSleep = (n) => {
      if (n === 1) oauth.slowDown();
      if (n === 3) oauth.approve();
    };
    const connected = next("connection.changed");
    await connections.startDeviceFlow("ui");
    await connected;

    expect(sleeps).toEqual([5000, 10_000, 10_000]);
  });

  test("sondear antes del intervalo da slow_down de GitHub, y el sondeo se adapta", async () => {
    onSleep = (n) => {
      // La segunda espera no deja pasar el tiempo: GitHub lo cobra con slow_down.
      if (n === 2) clock -= 5000;
      if (n === 4) oauth.approve();
    };
    const connected = next("connection.changed");
    await connections.startDeviceFlow("ui");
    await connected;

    expect(sleeps).toEqual([5000, 5000, 10_000, 10_000]);
  });

  test("si el usuario cancela en GitHub no se conecta nada y queda un evento error", async () => {
    onSleep = (n) => {
      if (n === 2) oauth.deny();
    };
    const failed = next("error");
    await connections.startDeviceFlow("ui");

    expect((await failed).payload).toMatchObject({ scope: "github.device_flow", message: expect.stringContaining("Cancelaste") });
    expect(connections.list()).toEqual([]);
  });

  test("si nadie aprueba, el código vence y queda un evento error", async () => {
    const failed = next("error");
    await connections.startDeviceFlow("ui");

    expect((await failed).payload).toMatchObject({ scope: "github.device_flow", message: expect.stringContaining("venció") });
    expect(connections.list()).toEqual([]);
    // 900 s de código a 5 s por sondeo.
    expect(sleeps).toHaveLength(180);
  });

  test("un código que GitHub da por vencido (expired_token) también es un rechazo definitivo", async () => {
    const code = await requestDeviceCode(oauth.endpoints, CLIENT_ID, clock);
    // El reloj del core va atrasado respecto del de GitHub: cree que el código vive.
    const behind = { ...code, expiresAt: clock + 3_600_000 };
    clock += 901_000;

    await expect(
      pollDeviceToken({ endpoints: oauth.endpoints, clientId: CLIENT_ID, code: behind, now: () => clock, sleep, signal: new AbortController().signal }),
    ).rejects.toThrow(/venció/);
  });

  test("un fallo de red al sondear no corta el flujo: reintenta hasta que GitHub conteste", async () => {
    let failures = 1;
    const real = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      if (String(input) === oauth.endpoints.token && failures-- > 0) throw new TypeError("fetch failed");
      return real(input, init);
    }) as typeof fetch;
    try {
      onSleep = (n) => {
        if (n === 2) oauth.approve();
      };
      const connected = next("connection.changed");
      await connections.startDeviceFlow("ui");
      await connected;
    } finally {
      globalThis.fetch = real;
    }

    expect(connections.list()).toMatchObject([{ account: ACCOUNT, auth: "app" }]);
  });

  test("un startDeviceFlow nuevo cancela el anterior sin reportarlo como fallo", async () => {
    const gates: Array<() => void> = [];
    onSleep = (n, signal) =>
      n === 1
        ? new Promise<void>((resolve, reject) => {
            gates.push(resolve);
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          })
        : undefined;
    await connections.startDeviceFlow("ui");
    onSleep = (n) => {
      if (n === 2) oauth.approve();
    };
    const connected = next("connection.changed");
    await connections.startDeviceFlow("ui");
    await connected;

    expect(connections.list()).toMatchObject([{ account: ACCOUNT, auth: "app" }]);
    expect(store.events.since(0, { types: ["error"] })).toEqual([]);
  });

  test("device flow sin habilitar en la App: falla con el paso a seguir y sin sondear", async () => {
    await oauth.close();
    oauth = await startFakeGitHubOAuth({ clientId: CLIENT_ID, now: () => clock, deviceFlowEnabled: false });
    connections = connectionsWith({ clientId: CLIENT_ID });

    await expect(connections.startDeviceFlow("ui")).rejects.toThrow(/Enable Device Flow/);
    expect(oauth.requests.map((r) => r.endpoint)).toEqual(["device_code"]);
  });

  test("un client_id que GitHub no reconoce falla con el paso a seguir", async () => {
    connections = connectionsWith({ clientId: "123456" });

    await expect(connections.startDeviceFlow("ui")).rejects.toThrow(/Client ID/);
  });

  test("sin client_id falla antes de llamar a GitHub, diciendo dónde ponerlo", async () => {
    connections = connectionsWith(undefined);

    const failure = await connections.startDeviceFlow("ui").catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(GitHubAuthError);
    expect((failure as Error).message).toContain("CLANKER_GITHUB_APP_CLIENT_ID");
    expect(oauth.requests).toEqual([]);
  });
});

describe("refresh", () => {
  test("antes del margen el token sale tal cual; después se refresca solo y rota los dos tokens", async () => {
    await connectApp();
    const first = oauth.latest();

    const expiresAt = (JSON.parse((await secrets.get(SESSION_REF))!) as { accessExpiresAt: number }).accessExpiresAt;
    clock = expiresAt - GITHUB_REFRESH_MARGIN_MS - 1000;
    expect(await connections.token("github", ACCOUNT)).toBe(first.accessToken);
    expect(refreshRequests()).toHaveLength(0);

    clock = expiresAt - GITHUB_REFRESH_MARGIN_MS + 1000;
    const token = await connections.token("github", ACCOUNT);

    expect(token).toBe(oauth.latest().accessToken);
    expect(token).not.toBe(first.accessToken);
    expect(oauth.isAccessTokenValid(first.accessToken)).toBe(false);
    // Un token del device flow se refresca solo con client_id.
    expect(refreshRequests()).toEqual([
      expect.objectContaining({ form: { client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: first.refreshToken } }),
    ]);
    expect(JSON.parse((await secrets.get(SESSION_REF))!)).toEqual({
      accessToken: oauth.latest().accessToken,
      refreshToken: oauth.latest().refreshToken,
      accessExpiresAt: clock + 8 * HOUR_MS,
    });
    // El refresh token nuevo renueva los 6 meses.
    expect(connections.list()[0]).toMatchObject({ status: "active", expiresAt: clock + 15_897_600_000 });
  });

  test("varios usos a la vez con el token vencido hacen un solo refresh", async () => {
    await connectApp();
    clock += 8 * HOUR_MS;

    const tokens = await Promise.all(Array.from({ length: 6 }, () => connections.token("github", ACCOUNT)));

    expect(refreshRequests()).toHaveLength(1);
    expect(new Set(tokens)).toEqual(new Set([oauth.latest().accessToken]));
  });

  test("refresh token vencido: la cuenta queda revoked, abre el breaker github y no vuelve a llamar a GitHub", async () => {
    await connectApp();
    const breakers = createBreakers({ store, runtime: "claude-sdk", probe: () => Promise.resolve("sigue caído") });
    breakers.start();
    try {
      oauth.expireRefreshTokens();
      clock += 8 * HOUR_MS;
      const changed = next("connection.changed");

      await expect(connections.token("github", ACCOUNT)).rejects.toBeInstanceOf(GitHubAuthError);

      expect((await changed).payload).toMatchObject({ provider: "github", account: ACCOUNT, status: "revoked" });
      expect(connections.list()[0]).toMatchObject({ status: "revoked", auth: "app" });
      expect(breakers.open(GITHUB_SCOPE)).toContain(ACCOUNT);

      const requests = oauth.requests.length;
      await expect(connections.token("github", ACCOUNT)).rejects.toThrow(/revocada/);
      expect(oauth.requests).toHaveLength(requests);
    } finally {
      breakers.close();
    }
  });

  test("un fallo transitorio del refresh no cambia el estado de la cuenta", async () => {
    await connectApp();
    clock += 8 * HOUR_MS;
    await oauth.close();

    await expect(connections.token("github", ACCOUNT)).rejects.not.toBeInstanceOf(GitHubAuthError);

    expect(connections.list()[0]).toMatchObject({ status: "active" });
  });

  test("si Secrets no puede guardar los tokens rotados, se usan desde memoria y se reintenta guardarlos", async () => {
    await connectApp();
    clock += 8 * HOUR_MS;
    let failing = true;
    const realSet = secrets.set.bind(secrets);
    secrets.set = async (ref, value) => {
      if (failing) throw new Error("llavero bloqueado");
      return realSet(ref, value);
    };
    const quiet = console.error;
    console.error = () => undefined;
    try {
      const token = await connections.token("github", ACCOUNT);
      expect(token).toBe(oauth.latest().accessToken);
      failing = false;

      expect(await connections.token("github", ACCOUNT)).toBe(token);
      expect(refreshRequests()).toHaveLength(1);
      expect(JSON.parse((await secrets.get(SESSION_REF))!)).toMatchObject({ accessToken: token });
    } finally {
      console.error = quiet;
    }
  });
});

describe("elegir PAT o App por cuenta", () => {
  test("pegar un PAT en una cuenta conectada con la App la deja con el PAT, y al revés", async () => {
    await connectApp();

    await connections.connect({ provider: "github", account: ACCOUNT, scopes: ["contents"], token: "github_pat_manual" }, "ui");
    expect(connections.list()).toEqual([{ provider: "github", account: ACCOUNT, scopes: ["contents"], status: "active", auth: "pat" }]);
    expect(await connections.token("github", ACCOUNT)).toBe("github_pat_manual");

    await connectApp();
    expect(connections.list()).toMatchObject([{ account: ACCOUNT, auth: "app", scopes: [] }]);
    expect(await connections.token("github", ACCOUNT)).toBe(oauth.latest().accessToken);
  });

  test("desconectar borra la sesión de Secrets", async () => {
    await connectApp();

    await connections.disconnect("github", ACCOUNT, "ui");

    expect(connections.list()).toEqual([]);
    expect(await secrets.get(SESSION_REF)).toBeUndefined();
  });
});

describe("githubClient con la App", () => {
  test("pone el token de la App en cada request", async () => {
    await connectApp();

    await connections.githubClient(ACCOUNT).request("GET /user");

    expect(api.requests.at(-1)?.authorization).toBe(`bearer ${oauth.latest().accessToken}`);
  });

  test("un 401 refresca el token una vez y reintenta con el nuevo", async () => {
    await connectApp();
    const first = oauth.latest();
    // GitHub dio por vencido el access token antes de lo que dice el reloj del core.
    oauth.expireAccessTokens();
    api.requests.length = 0;

    await connections.githubClient(ACCOUNT).request("GET /user");

    expect(api.requests.map((r) => r.authorization)).toEqual([`bearer ${first.accessToken}`, `bearer ${oauth.latest().accessToken}`]);
    expect(refreshRequests()).toHaveLength(1);
    expect(connections.list()[0]).toMatchObject({ status: "active" });
  });

  test("un 401 con el refresh token también rechazado deja la cuenta revoked", async () => {
    await connectApp();
    oauth.expireAccessTokens();
    oauth.expireRefreshTokens();
    const changed = next("connection.changed");

    await expect(connections.githubClient(ACCOUNT).request("GET /user")).rejects.toBeInstanceOf(GitHubAuthError);

    expect((await changed).payload).toMatchObject({ status: "revoked" });
  });
});
