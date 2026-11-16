import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeStatus, RepoId } from "@clanker/api";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createConnections, type Connections } from "../connections/connections";
import { startFakeGitHub, type FakeGitHub } from "../testing/github/fake-github";
import { createFileSecrets } from "../secrets/encrypted-file";
import { openStore, type Store } from "../store/store";
import { createRepos } from "../repos/repos";
import { GITHUB_SCOPE, repoScope, runtimeScope } from "./breakers";
import { environmentProbe } from "./probes";

let dir: string;
let store: Store;
let github: FakeGitHub | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clanker-probes-"));
  store = openStore({ path: ":memory:" });
});

afterEach(async () => {
  await github?.close();
  github = undefined;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("github", () => {
  async function probeAgainst(status: number) {
    github = await startFakeGitHub(() => ({ status, headers: {}, body: status === 200 ? { login: "simon" } : { message: "Bad credentials" } }));
    const connections = createConnections(store, createFileSecrets({ dir }), { github: { baseUrl: github.baseUrl } });
    await connections.connect({ provider: "github", account: "simon", scopes: [], token: "tok" }, "ui");
    return { connections, probe: environmentProbe({ connections, repos: createRepos(store), runtimes: [{ id: "fake" }] }) };
  }

  test("sin ninguna cuenta conectada sigue pausado", async () => {
    const connections = createConnections(store, createFileSecrets({ dir }));
    const probe = environmentProbe({ connections, repos: createRepos(store), runtimes: [{ id: "fake" }] });

    expect(await probe(GITHUB_SCOPE)).toBe("No hay una cuenta de GitHub conectada.");
  });

  test("con la cuenta respondiendo, la causa se fue", async () => {
    const { probe } = await probeAgainst(200);

    expect(await probe(GITHUB_SCOPE)).toBeUndefined();
  });

  test("un 401 sigue pausado y deja la cuenta revocada", async () => {
    const { probe, connections } = await probeAgainst(401);

    expect(await probe(GITHUB_SCOPE)).toContain("simon");
    expect(connections.list()[0]?.status).toBe("revoked");
  });

  test("una cuenta revocada ni siquiera llama a GitHub", async () => {
    const { probe, connections } = await probeAgainst(200);
    connections.markRevoked("github", "simon", "core");

    expect(await probe(GITHUB_SCOPE)).toBe("La cuenta de GitHub simon está revoked: reconéctala.");
    expect(github!.requests).toEqual([]);
  });
});

describe("runtime", () => {
  const claude = (status: Partial<ClaudeStatus>) =>
    ({ testClaude: () => Promise.resolve({ mode: "subscription", state: "ready", ...status }) }) as unknown as Connections;

  test("claude-sdk pasa solo con Claude listo y si no dice por qué", async () => {
    const repos = createRepos(store);
    const ready = environmentProbe({ connections: claude({}), repos, runtimes: [{ id: "claude-sdk" }] });
    const out = environmentProbe({ connections: claude({ state: "quota_exhausted", message: "Se agotó la cuota de Claude." }), repos, runtimes: [{ id: "claude-sdk" }] });

    expect(await ready(runtimeScope("claude-sdk"))).toBeUndefined();
    expect(await out(runtimeScope("claude-sdk"))).toBe("Se agotó la cuota de Claude.");
  });

  test("otro runtime se prueba con su probe, y sin él no tiene causas de entorno que probar", async () => {
    const opencode = { id: "opencode" as const, probe: () => Promise.resolve("opencode no está instalado.") };
    const probe = environmentProbe({ connections: claude({ state: "login_expired" }), repos: createRepos(store), runtimes: [{ id: "fake" }, opencode] });

    expect(await probe(runtimeScope("fake"))).toBeUndefined();
    expect(await probe(runtimeScope("opencode"))).toBe("opencode no está instalado.");
  });

  test("claude-sdk solo se prueba con la conexión si el core lo tiene registrado", async () => {
    const probe = environmentProbe({ connections: claude({ state: "login_expired" }), repos: createRepos(store), runtimes: [{ id: "fake" }] });

    expect(await probe(runtimeScope("claude-sdk"))).toBeUndefined();
  });
});

describe("repo", () => {
  function repoWith(recipe?: unknown): RepoId {
    const path = join(dir, "repo");
    mkdirSync(join(path, ".clanker"), { recursive: true });
    if (recipe) writeFileSync(join(path, ".clanker", "recipe.json"), JSON.stringify(recipe));
    return createRepos(store).add({ name: "api", path });
  }
  const probeFor = () =>
    environmentProbe({ connections: createConnections(store, createFileSecrets({ dir })), repos: createRepos(store), runtimes: [{ id: "fake" }] });

  test("pasa si todos los requires responden y falla nombrando los que no", async () => {
    const id = repoWith({ version: 1, requires: [{ name: "Postgres", check: "true" }, { name: "Redis", check: "exit 1" }, { name: "Doppler", check: "exit 3" }] });

    expect(await probeFor()(repoScope(id))).toBe("No responde: Redis, Doppler.");

    writeFileSync(join(dir, "repo", ".clanker", "recipe.json"), JSON.stringify({ version: 1, requires: [{ name: "Postgres", check: "true" }] }));
    expect(await probeFor()(repoScope(id))).toBeUndefined();
  });

  test("un repo sin receta, sin requires o que ya no está registrado no tiene nada que probar", async () => {
    const id = repoWith();

    expect(await probeFor()(repoScope(id))).toBeUndefined();
    expect(await probeFor()(repoScope("repo_desconocido"))).toBeUndefined();
  });

  test("corre los requires con el env de la receta y un slot, como recipe.check", async () => {
    const id = repoWith({
      version: 1,
      slots: { dev: 2, maintenance: 1 },
      env: { DB_NAME: "app_cy{{slot}}" },
      requires: [{ name: "Postgres", check: 'test "$DB_NAME" = app_cy1 && test {{slot+5432}} = 5433' }],
    });

    expect(await probeFor()(repoScope(id))).toBeUndefined();
  });
});
