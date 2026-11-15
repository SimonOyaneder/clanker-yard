import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createConnections,
  LINEAR_REFRESH_MARGIN_MS,
  type Connections,
  type LinearLogin,
} from "../connections/connections";
import { createFileSecrets } from "../secrets/encrypted-file";
import type { Secrets } from "../secrets/secrets";
import { openStore, type Store } from "../store/store";
import { startFakeLinear, type FakeLinear } from "./fake-linear";
import { LINEAR_REFRESH_TTL_MS, LinearAuthError } from "./oauth";

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CLIENT_ID = "test-client-id";

let dir: string;
let store: Store;
let secrets: Secrets;
let linear: FakeLinear;
let connections: Connections;
let clock: number;

/** Hace de navegador: abre el link de Linear y sigue el redirect hasta el loopback del core. */
async function approve(url: string): Promise<Response> {
  const authorize = await fetch(url, { redirect: "manual" });
  expect(authorize.status).toBe(302);
  return fetch(authorize.headers.get("location")!);
}

async function login(origin: "ui" | "cli" = "ui"): Promise<LinearLogin> {
  return connections.linearAuth(origin);
}

async function connectLinear() {
  const { url, done } = await login();
  await approve(url);
  return done;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "clanker-linear-"));
  store = openStore({ path: join(dir, "clanker.db") });
  secrets = createFileSecrets({ dir: join(dir, "secrets") });
  linear = await startFakeLinear({ clientId: CLIENT_ID });
  clock = NOW;
  connections = createConnections(store, secrets, {
    now: () => clock,
    linear: { clientId: CLIENT_ID, redirectPort: 0, endpoints: linear.endpoints },
  });
});

afterEach(async () => {
  await linear.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("linearAuth", () => {
  test("código, token y workspace: la cuenta queda activa y el core lee su token", async () => {
    const { url, done } = await login("ui");
    const authorize = new URL(url);
    expect(authorize.origin + authorize.pathname).toBe(linear.endpoints.authorize);
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      response_type: "code",
      client_id: CLIENT_ID,
      scope: "read,write",
      code_challenge_method: "S256",
    });
    expect(authorize.searchParams.get("redirect_uri")).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/oauth\/linear\/callback$/,
    );

    const page = await approve(url);
    expect(page.status).toBe(200);

    const connection = await done;
    expect(connection).toEqual({
      provider: "linear",
      account: "clanker-yard",
      scopes: ["read", "write"],
      status: "active",
      expiresAt: NOW + LINEAR_REFRESH_TTL_MS,
    });
    expect(connections.list()).toEqual([connection]);
    expect(await connections.token("linear", "clanker-yard")).toBe(linear.latest().accessToken);
    // El PKCE lo verificó el servidor falso: un solo cambio de código, con el verifier del core.
    expect(linear.tokenRequests.map((r) => r.grant_type)).toEqual(["authorization_code"]);
    expect(store.events.since(0).map((e) => [e.type, e.origin, e.payload])).toEqual([
      ["connection.changed", "ui", { provider: "linear", account: "clanker-yard", status: "active" }],
    ]);
  });

  test("un redirect con otro state se ignora y el login sigue esperando el verdadero", async () => {
    const { url, done } = await login();
    const redirect = new URL(new URL(url).searchParams.get("redirect_uri")!);
    redirect.searchParams.set("code", "robado");
    redirect.searchParams.set("state", "otro");
    expect((await fetch(redirect)).status).toBe(400);

    await approve(url);
    await expect(done).resolves.toMatchObject({ account: "clanker-yard" });
    expect(linear.tokenRequests).toHaveLength(1);
  });

  test("si el usuario no aprueba, done falla y no se guarda nada", async () => {
    const { url, done } = await login();
    const redirect = new URL(new URL(url).searchParams.get("redirect_uri")!);
    redirect.searchParams.set("error", "access_denied");
    redirect.searchParams.set("state", new URL(url).searchParams.get("state")!);

    const page = await fetch(redirect);

    await expect(done).rejects.toThrow(LinearAuthError);
    await expect(done).rejects.toThrow(/access_denied/);
    expect(page.status).toBe(400);
    expect(await page.text()).toContain("access_denied");
    expect(connections.list()).toEqual([]);
    expect(store.events.since(0)).toEqual([]);
    expect(linear.tokenRequests).toEqual([]);
  });

  test("si Linear rechaza el cambio del código, done falla y no se guarda nada", async () => {
    const { url, done } = await login();
    const redirect = new URL(new URL(url).searchParams.get("redirect_uri")!);
    redirect.searchParams.set("code", "no-existe");
    redirect.searchParams.set("state", new URL(url).searchParams.get("state")!);
    await fetch(redirect);

    await expect(done).rejects.toThrow(/invalid_grant/);
    expect(connections.list()).toEqual([]);
  });

  test("si el usuario no aprueba a tiempo, done falla", async () => {
    const quick = createConnections(store, secrets, {
      linear: { clientId: CLIENT_ID, redirectPort: 0, loginTimeoutMs: 1, endpoints: linear.endpoints },
    });
    const { done } = await quick.linearAuth("ui");

    await expect(done).rejects.toThrow(/a tiempo/);
  });

  test("un linearAuth nuevo cancela el pendiente", async () => {
    const first = await login();
    const second = await login();

    await expect(first.done).rejects.toThrow(/otra conexión/);
    await approve(second.url);
    await expect(second.done).resolves.toMatchObject({ account: "clanker-yard" });
  });

  test("sin client_id explica cómo configurarlo", async () => {
    const bare = createConnections(store, secrets, { linear: { endpoints: linear.endpoints } });

    await expect(bare.linearAuth("ui")).rejects.toThrow(/client_id de la OAuth app de Linear/);
  });

  test("con el puerto del redirect ocupado dice cuál es", async () => {
    const first = await login();
    const port = new URL(new URL(first.url).searchParams.get("redirect_uri")!).port;
    const other = createConnections(store, secrets, {
      linear: { clientId: CLIENT_ID, redirectPort: Number(port), endpoints: linear.endpoints },
    });

    await expect(other.linearAuth("ui")).rejects.toThrow(new RegExp(`127.0.0.1:${port}`));
  });

  test("connect no acepta Linear: su token se refresca y no se pega", async () => {
    await expect(
      connections.connect({ provider: "linear", account: "x", scopes: [], token: "lin_api_x" }, "ui"),
    ).rejects.toThrow(/linearAuth/);
  });
});

describe("refresh", () => {
  test("con el access token vigente no llama a Linear", async () => {
    await connectLinear();
    clock += DAY_MS - 1000 - LINEAR_REFRESH_MARGIN_MS - 1000;

    expect(await connections.token("linear", "clanker-yard")).toBe(linear.latest().accessToken);
    expect(linear.tokenRequests).toHaveLength(1);
  });

  test("antes de vencer lo refresca, rota el refresh token y renueva el vencimiento de la conexión", async () => {
    await connectLinear();
    const firstRefresh = linear.latest().refreshToken;
    clock += DAY_MS - LINEAR_REFRESH_MARGIN_MS + 1000;

    const token = await connections.token("linear", "clanker-yard");

    expect(token).toBe(linear.latest().accessToken);
    expect(linear.tokenRequests[1]).toMatchObject({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: firstRefresh,
    });
    expect(linear.tokenRequests[1]).not.toHaveProperty("client_secret");
    expect(connections.list()[0]).toMatchObject({ status: "active", expiresAt: clock + LINEAR_REFRESH_TTL_MS });
    // El refresh token nuevo quedó guardado: el siguiente refresh lo usa (el viejo ya no vale).
    clock += DAY_MS;
    expect(await connections.token("linear", "clanker-yard")).toBe(linear.latest().accessToken);
    expect(linear.tokenRequests).toHaveLength(3);
    expect(store.events.since(0)).toHaveLength(1);
  });

  test("llamadas concurrentes con el token vencido hacen un solo refresh", async () => {
    await connectLinear();
    clock += DAY_MS;

    const tokens = await Promise.all([1, 2, 3].map(() => connections.token("linear", "clanker-yard")));

    expect(new Set(tokens).size).toBe(1);
    expect(linear.tokenRequests.filter((r) => r.grant_type === "refresh_token")).toHaveLength(1);
  });

  test("si Linear rechaza el refresh la conexión queda revocada, con un evento, y no se reintenta", async () => {
    await connectLinear();
    clock += DAY_MS;
    linear.refreshFailure = { status: 400, error: "invalid_grant" };

    await expect(connections.token("linear", "clanker-yard")).rejects.toThrow(LinearAuthError);

    expect(connections.list()[0]?.status).toBe("revoked");
    expect(store.events.since(0).map((e) => e.payload.status)).toEqual(["active", "revoked"]);
    const requests = linear.tokenRequests.length;
    await expect(connections.token("linear", "clanker-yard")).rejects.toThrow(/revocada: vuelve a conectarla/);
    expect(linear.tokenRequests).toHaveLength(requests);
    expect(store.events.since(0)).toHaveLength(2);
  });

  test("tras revocarse, volver a conectar la deja activa con tokens nuevos", async () => {
    await connectLinear();
    clock += DAY_MS;
    linear.refreshFailure = { status: 400, error: "invalid_grant" };
    await expect(connections.token("linear", "clanker-yard")).rejects.toThrow(LinearAuthError);
    linear.refreshFailure = undefined;

    await connectLinear();

    expect(connections.list()[0]?.status).toBe("active");
    expect(await connections.token("linear", "clanker-yard")).toBe(linear.latest().accessToken);
  });

  test("un fallo transitorio de Linear no revoca la conexión y el siguiente intento funciona", async () => {
    await connectLinear();
    clock += DAY_MS;
    linear.refreshFailure = { status: 503, error: "unavailable" };

    await expect(connections.token("linear", "clanker-yard")).rejects.toThrow(/503/);
    expect(connections.list()[0]?.status).toBe("active");
    expect(store.events.since(0)).toHaveLength(1);

    linear.refreshFailure = undefined;
    expect(await connections.token("linear", "clanker-yard")).toBe(linear.latest().accessToken);
  });

  test("si falta o está dañado el secreto, dice cómo repararlo", async () => {
    await connectLinear();
    await secrets.set("connection:linear:clanker-yard", "no es json");

    await expect(connections.token("linear", "clanker-yard")).rejects.toThrow(
      /desconecta la cuenta y vuelve a conectarla/,
    );
  });
});

describe("disconnect", () => {
  test("borra los tokens de Linear y la cuenta, y emite connection.changed", async () => {
    await connectLinear();

    await connections.disconnect("linear", "clanker-yard", "cli");

    expect(connections.list()).toEqual([]);
    expect(await secrets.get("connection:linear:clanker-yard")).toBeUndefined();
    expect(store.events.since(0).at(-1)).toMatchObject({
      origin: "cli",
      payload: { provider: "linear", account: "clanker-yard", status: "disconnected" },
    });
  });
});

describe("sin tokens fuera del almacén", () => {
  test("ni el access ni el refresh token están en la base, el WAL, los eventos ni list", async () => {
    await connectLinear();
    clock += DAY_MS;
    await connections.token("linear", "clanker-yard");
    const { accessToken, refreshToken } = linear.latest();
    expect(accessToken).toContain("UNIQUE-linear-access");

    // Con la base todavía abierta: el contenido puede estar en el WAL.
    const dbFiles = readdirSync(dir).filter((f) => f.startsWith("clanker.db"));
    expect(dbFiles).toContain("clanker.db");
    for (const file of dbFiles) {
      const bytes = readFileSync(join(dir, file)).toString("latin1");
      expect(bytes, file).not.toContain("UNIQUE-linear");
    }
    expect(JSON.stringify(store.events.since(0))).not.toContain("UNIQUE-linear");
    expect(JSON.stringify(connections.list())).not.toContain("UNIQUE-linear");
    expect(store.db.$client.prepare("SELECT secret_ref FROM connections").get()).toEqual({
      secret_ref: "connection:linear:clanker-yard",
    });
    // Y el almacén sí los tiene, juntos: el refresh token rota con el access token.
    expect(JSON.parse((await secrets.get("connection:linear:clanker-yard"))!)).toMatchObject({
      accessToken,
      refreshToken,
    });
  });
});
