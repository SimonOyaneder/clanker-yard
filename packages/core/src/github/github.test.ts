import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createRouterClient, ORPCError } from "@orpc/server";
import { createConnections, type Connections } from "../connections/connections";
import { createFileSecrets } from "../secrets/encrypted-file";
import { createRouter } from "../server/router";
import { apiDeps } from "../server/testing";
import { openStore, type Store } from "../store/store";
import { syncCursors } from "../store/schema";
import { createIssues } from "../tracker/issues";
import { createGitHubClient } from "./client";
import { healthyGitHub, recorded, startFakeGitHub, type FakeGitHub } from "./fake-github";
import { GitHubPatError, githubPatForm } from "./pat";

const CLASSIC_URL = "https://github.com/settings/tokens/new?description=Clanker%20Yard&scopes=repo";

const TOKEN = "github_pat_UNIQUE-0123456789";
/** El token de `user.ok` vence el 2026-12-20 12:00 UTC. */
const EXPIRES_AT = Date.UTC(2026, 11, 20, 12);
const DAY = 24 * 60 * 60 * 1000;

let dir: string;
let store: Store;
let github: FakeGitHub | undefined;
let now: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clanker-github-"));
  store = openStore({ path: ":memory:" });
  now = EXPIRES_AT - 30 * DAY;
});

afterEach(async () => {
  await github?.close();
  github = undefined;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function connectionsAgainst(
  respond: Parameters<typeof startFakeGitHub>[0],
): Promise<Connections> {
  github = await startFakeGitHub(respond);
  return createConnections(store, createFileSecrets({ dir }), {
    github: { baseUrl: github.baseUrl },
    now: () => now,
  });
}

describe("setPat", () => {
  test("token válido: conecta la cuenta del token con los permisos verificados y su vencimiento", async () => {
    const connections = await connectionsAgainst(healthyGitHub());

    const connection = await connections.setPat(TOKEN, "ui");

    expect(connection).toEqual({
      provider: "github",
      account: "octocat",
      scopes: ["repo"],
      status: "active",
      expiresAt: EXPIRES_AT,
      auth: "pat",
    });
    expect(connections.list()).toEqual([connection]);
    expect(await connections.token("github", "octocat")).toBe(TOKEN);
    expect(store.events.since(0).map((e) => [e.type, e.origin])).toEqual([["connection.changed", "ui"]]);
    // Todas las requests llevaron el token que se pegó.
    expect(new Set(github!.requests.map((r) => r.authorization))).toEqual(new Set([`bearer ${TOKEN}`]));
  });

  test("prueba los permisos sobre un repo privado, no sobre uno público", async () => {
    const connections = await connectionsAgainst(healthyGitHub());
    await connections.setPat(TOKEN, "ui");

    const probed = github!.requests.map((r) => r.path).filter((p) => p.startsWith("/repos/"));
    expect(probed).toHaveLength(5);
    expect(probed.every((p) => p.startsWith("/repos/octocat/secret-project/"))).toBe(true);
  });

  test("classic sin el scope repo: no conecta y dice qué marcar, con el link del formulario", async () => {
    const user = recorded("user.ok");
    user.headers["x-oauth-scopes"] = "read:user, gist";
    const connections = await connectionsAgainst(healthyGitHub({ "GET /user": user }));

    const error = await connections.setPat(TOKEN, "ui").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitHubPatError);
    expect((error as Error).message).toContain("le falta el scope `repo` (tiene: read:user, gist)");
    expect((error as Error).message).toContain(CLASSIC_URL);
    expect(connections.list()).toEqual([]);
    expect(store.events.since(0)).toEqual([]);
  });

  test("classic con repo pero sin acceso de lectura a un permiso: dice cuáles y no conecta", async () => {
    const connections = await connectionsAgainst(
      healthyGitHub({ "GET /repos/octocat/secret-project/issues": recorded("probe.forbidden") }),
    );

    const error = await connections.setPat(TOKEN, "ui").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitHubPatError);
    expect((error as Error).message).toContain("no puede leer Issues del repo octocat/secret-project");
    expect(connections.list()).toEqual([]);
  });

  test("fine-grained (sin x-oauth-scopes) con 403 en checks: explica que no tienen Checks y manda al classic", async () => {
    const user = recorded("user.ok");
    delete user.headers["x-oauth-scopes"];
    const connections = await connectionsAgainst(
      healthyGitHub({
        "GET /user": user,
        "GET /repos/octocat/secret-project/commits/trunk/check-runs": recorded("probe.forbidden"),
      }),
    );

    const error = await connections.setPat(TOKEN, "ui").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitHubPatError);
    expect((error as Error).message).toContain("Los fine-grained PAT no tienen el permiso Checks");
    expect((error as Error).message).toContain(CLASSIC_URL);
    expect(connections.list()).toEqual([]);
    expect(store.events.since(0)).toEqual([]);
  });

  test("token vencido (o revocado): GitHub responde 401 y no se guarda nada", async () => {
    const connections = await connectionsAgainst(
      healthyGitHub({ "GET /user": recorded("user.bad-credentials") }),
    );

    await expect(connections.setPat(TOKEN, "ui")).rejects.toThrow(/inválido, está vencido o fue revocado/);
    await expect(connections.setPat(TOKEN, "ui")).rejects.toBeInstanceOf(GitHubPatError);
    expect(connections.list()).toEqual([]);
    expect(store.events.since(0)).toEqual([]);
  });

  test("sin repos visibles: no conecta", async () => {
    const connections = await connectionsAgainst(healthyGitHub({ "GET /user/repos": recorded("repos.empty") }));

    await expect(connections.setPat(TOKEN, "ui")).rejects.toThrow(/no ve ningún repositorio/);
    expect(connections.list()).toEqual([]);
  });

  test("un corte por cuota durante la validación no se confunde con un permiso faltante", async () => {
    const connections = await connectionsAgainst(
      healthyGitHub({ "GET /repos/octocat/secret-project/pulls": recorded("rate-limited") }),
    );

    const error = await connections.setPat(TOKEN, "ui").catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(GitHubPatError);
    expect((error as Error).message).toContain("API rate limit exceeded");
    expect(connections.list()).toEqual([]);
  });

  test("un token sin vencimiento no lleva expiresAt", async () => {
    const user = recorded("user.ok");
    delete user.headers["github-authentication-token-expiration"];
    const connections = await connectionsAgainst(healthyGitHub({ "GET /user": user }));

    const connection = await connections.setPat(TOKEN, "ui");

    expect(connection).not.toHaveProperty("expiresAt");
    expect(connection).not.toHaveProperty("expiresSoon");
  });

  test("un vencimiento ilegible falla fuerte en vez de perder el aviso", async () => {
    const user = recorded("user.ok");
    user.headers["github-authentication-token-expiration"] = "pronto";
    const connections = await connectionsAgainst(healthyGitHub({ "GET /user": user }));

    await expect(connections.setPat(TOKEN, "ui")).rejects.toThrow(/vencimiento que no se entiende: "pronto"/);
  });
});

describe("vencimiento", () => {
  test("avisa desde 7 días antes y marca vencido después", async () => {
    const connections = await connectionsAgainst(healthyGitHub());
    await connections.setPat(TOKEN, "ui");
    const status = () => connections.list().map(({ status, expiresSoon }) => ({ status, expiresSoon }));

    now = EXPIRES_AT - 7 * DAY - 1;
    expect(status()).toEqual([{ status: "active" }]);
    now = EXPIRES_AT - 7 * DAY;
    expect(status()).toEqual([{ status: "active", expiresSoon: true }]);
    now = EXPIRES_AT;
    expect(status()).toEqual([{ status: "expired" }]);
  });
});

describe("githubPatForm", () => {
  test("el link abre el formulario de PAT classic con descripción y scope repo marcados", () => {
    const form = githubPatForm();
    const url = new URL(form.url);

    expect(form.url).toBe(CLASSIC_URL);
    expect(url.origin + url.pathname).toBe("https://github.com/settings/tokens/new");
    expect(Object.fromEntries(url.searchParams)).toEqual({ description: "Clanker Yard", scopes: "repo" });
    expect(form.scopes).toEqual(["repo"]);
  });
});

describe("API", () => {
  test("setPat y githubPatForm por el contrato; un token malo es BAD_REQUEST con el mensaje accionable", async () => {
    const connections = await connectionsAgainst(
      healthyGitHub({ "GET /user": recorded("user.bad-credentials") }),
    );
    const router = createRouter({
      store,
      connections,
      issues: createIssues(store),
      ...apiDeps(store, dir),
      coreVersion: "0",
      bootId: "boot",
      startedAt: 0,
      dataDir: dir,
      onShutdown: () => {},
    });
    const client = createRouterClient(router, { context: { origin: "ui" } });

    await expect(client.connections.setPat({ token: TOKEN })).rejects.toSatisfy(
      (e) => e instanceof ORPCError && e.code === "BAD_REQUEST" && /inválido, está vencido/.test(e.message),
    );
    expect(await client.connections.githubPatForm()).toEqual(githubPatForm());
  });
});

describe("cliente de GitHub", () => {
  async function connected() {
    const connections = await connectionsAgainst(
      healthyGitHub({ "GET /repos/octocat/hello-world": { ...recorded("user.ok"), body: { name: "hello-world" } } }),
    );
    await connections.setPat(TOKEN, "ui");
    return connections;
  }

  test("registra la cuota de cada respuesta en sync_cursors", async () => {
    const connections = await connected();
    await connections.githubClient("octocat").request("GET /repos/{owner}/{repo}", {
      owner: "octocat",
      repo: "hello-world",
    });

    expect(store.db.select().from(syncCursors).all()).toEqual([
      expect.objectContaining({
        key: "rate:github:octocat:core",
        etag: null,
        rateRemaining: 4999,
        resetAt: 1_795_000_000_000,
        rateLimit: 5000,
      }),
    ]);
  });

  test("es un solo cliente por cuenta y exige que la cuenta esté conectada", async () => {
    const connections = await connected();

    expect(connections.githubClient("octocat")).toBe(connections.githubClient("octocat"));
    expect(() => connections.githubClient("otra")).toThrow(/conéctala primero/);
    await connections.disconnect("github", "octocat", "ui");
    expect(() => connections.githubClient("octocat")).toThrow(/conéctala primero/);
  });

  test("cuota primaria agotada: emite sync.rate_limited con la hora del reset y deja pasar el error", async () => {
    const connections = await connectionsAgainst(
      healthyGitHub({ "GET /repos/octocat/hello-world": recorded("rate-limited") }),
    );
    await connections.setPat(TOKEN, "ui");

    await expect(
      connections.githubClient("octocat").request("GET /repos/{owner}/{repo}", { owner: "octocat", repo: "hello-world" }),
    ).rejects.toMatchObject({ status: 403 });

    const limited = store.events.since(0, { types: ["sync.rate_limited"] });
    expect(limited.map((e) => [e.origin, e.payload])).toEqual([
      ["core", { provider: "github", account: "octocat", resetAt: 1_795_003_600_000 }],
    ]);
    expect(store.db.select().from(syncCursors).all()[0]).toMatchObject({ rateRemaining: 0 });
  });

  test("cuota secundaria: espera lo que dice retry-after", async () => {
    const connections = await connectionsAgainst(
      healthyGitHub({ "GET /repos/octocat/hello-world": recorded("secondary-rate-limited") }),
    );
    await connections.setPat(TOKEN, "ui");

    const before = Date.now();
    await connections
      .githubClient("octocat")
      .request("GET /repos/{owner}/{repo}", { owner: "octocat", repo: "hello-world" })
      .catch(() => undefined);

    const [event] = store.events.since(0, { types: ["sync.rate_limited"] });
    const resetAt = event!.payload.resetAt as number;
    expect(resetAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(resetAt).toBeLessThan(before + 60_000 + 5_000);
  });

  test("un 403 por permisos no es un corte por cuota", async () => {
    const connections = await connectionsAgainst(
      healthyGitHub({ "GET /repos/octocat/hello-world": recorded("probe.forbidden") }),
    );
    await connections.setPat(TOKEN, "ui");

    await connections
      .githubClient("octocat")
      .request("GET /repos/{owner}/{repo}", { owner: "octocat", repo: "hello-world" })
      .catch(() => undefined);

    expect(store.events.since(0, { types: ["sync.rate_limited"] })).toEqual([]);
  });

  test("con una fuente que sabe refrescar, un 401 pide un token nuevo y reintenta una vez", async () => {
    let current = "token-viejo";
    const fake = await startFakeGitHub((request) =>
      request.authorization === "bearer token-nuevo" ? recorded("user.ok") : recorded("user.bad-credentials"),
    );
    github = fake;
    const refresh = vi.fn(async () => {
      current = "token-nuevo";
    });
    const client = createGitHubClient({
      baseUrl: fake.baseUrl,
      tokens: { kind: "app", token: async () => current, refresh },
    });

    const { data } = await client.request("GET /user");

    expect(data.login).toBe("octocat");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fake.requests.map((r) => r.authorization)).toEqual(["bearer token-viejo", "bearer token-nuevo"]);
  });

  test("las requests de un cliente salen en serie, y una que falla no frena a las demás", async () => {
    let inFlight = 0;
    let most = 0;
    const answers = [404, 200, 200];
    const slowFetch = async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await delay(15);
      inFlight -= 1;
      return new Response("{}", { status: answers.shift(), headers: { "content-type": "application/json" } });
    };
    const client = createGitHubClient({ baseUrl: "http://github.invalid", fetch: slowFetch, tokens: { kind: "pat", token: async () => "x" } });

    const results = await Promise.allSettled([client.request("GET /user"), client.request("GET /user"), client.request("GET /user")]);

    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
    expect(most).toBe(1);
  });

  test("sin refresh, un 401 sube tal cual", async () => {
    const fake = await startFakeGitHub(() => recorded("user.bad-credentials"));
    github = fake;
    const client = createGitHubClient({ baseUrl: fake.baseUrl, tokens: { kind: "pat", token: async () => "x" } });

    await expect(client.request("GET /user")).rejects.toMatchObject({ status: 401 });
    expect(fake.requests).toHaveLength(1);
  });
});
