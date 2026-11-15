import { mkdirSync, readdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@clanker/api";
import { createFileSecrets, openStore, startCore, type Core, type Store } from "@clanker/core";
import { ORPCError } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createFakeRuntime } from "./fake-runtime";
import { tempGitRepo, type TempGitRepo } from "./git";
import { seedDb, type TestHome } from "./home";

// `repos.detect`, `repos.add` y `repos.testRecipe` sobre repos git reales y temporales.

let home: TestHome;
let store: Store;
let core: Core | undefined;
let client: Client;
let cleanups: Array<() => void>;

beforeEach(async () => {
  home = seedDb("empty");
  store = openStore({ path: home.dbPath });
  cleanups = [];
  core = await startCore({
    store,
    dataDir: home.path,
    secrets: createFileSecrets({ dir: join(home.path, "secrets") }),
    runtimes: [createFakeRuntime({ fixtures: home.path, speed: Infinity })],
    env: { CORE_RUNTIME: "fake" },
    coreVersion: "0.0.0",
    onShutdown: () => {},
  });
  client = createClient({ url: core.server.url, token: core.server.token, origin: "cli" });
});

afterEach(async () => {
  await core?.close();
  core = undefined;
  store.close();
  for (const cleanup of cleanups) cleanup();
  home.cleanup();
});

function repoWith(recipe: unknown, extra: Parameters<typeof tempGitRepo>[0] = {}): TempGitRepo {
  const repo = tempGitRepo({
    commits: [
      { message: "chore: initial commit", files: recipe === undefined ? {} : { ".clanker/recipe.json": JSON.stringify(recipe) } },
    ],
    ...extra,
  });
  cleanups.push(repo.cleanup);
  return repo;
}

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "clanker-detect-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const badRequest = (message: RegExp) => (e: unknown) =>
  e instanceof ORPCError && e.code === "BAD_REQUEST" && message.test(e.message);

describe("repos.detect", () => {
  test("lista los repos de una carpeta con el estado de su receta, su remoto y su branch por defecto", async () => {
    const folder = scratchDir();
    const ok = repoWith({ version: 1 });
    const missing = repoWith(undefined);
    const invalid = repoWith({ version: 1, checks: ["no-existe"] });
    const notJson = repoWith(undefined, { commits: [{ message: "x", files: { ".clanker/recipe.json": "{ no es json" } }] });
    missing.git("remote", "add", "origin", "git@github.com:acme/api.git");
    missing.git("branch", "-m", "main", "trunk");
    for (const [name, repo] of Object.entries({ ok, missing, invalid, "not-json": notJson })) {
      symlinkSync(repo.dir, join(folder, name));
    }
    mkdirSync(join(folder, "no-es-un-repo"));

    const detected = await client.repos.detect({ folder });

    expect(detected.map((d) => [d.name, d.recipe.status])).toEqual([
      ["invalid", "invalid"],
      ["missing", "missing"],
      ["not-json", "invalid"],
      ["ok", "found"],
    ]);
    const byName = Object.fromEntries(detected.map((d) => [d.name, d]));
    expect(byName.invalid!.recipe).toMatchObject({ message: expect.stringContaining('"no-existe" no está en commands') });
    expect(byName["not-json"]!.recipe).toMatchObject({ message: expect.stringContaining("no es JSON válido") });
    expect(byName.missing).toMatchObject({ remote: "acme/api", defaultBranch: "trunk", repoId: null });
    expect(byName.ok).toMatchObject({ remote: null, defaultBranch: "main" });
  });

  test("una carpeta que es un repo se lista a sí misma y marca el que ya está registrado", async () => {
    const repo = repoWith({ version: 1 });
    const added = await client.repos.add({ path: repo.dir });

    expect(await client.repos.detect({ folder: repo.dir })).toMatchObject([{ repoId: added.id, recipe: { status: "found" } }]);
  });

  test("una carpeta que no existe es BAD_REQUEST", async () => {
    await expect(client.repos.detect({ folder: join(home.path, "nada") })).rejects.toSatisfy(badRequest(/No existe la carpeta/));
  });
});

describe("repos.add", () => {
  test("registra el repo con su nombre, branch por defecto y remoto, y repos.list lo trae", async () => {
    const repo = repoWith(undefined);
    repo.git("remote", "add", "origin", "https://github.com/acme/web.git");

    const added = await client.repos.add({ path: repo.dir, name: "web" });

    expect(added).toEqual({ id: expect.stringMatching(/^repo_/), name: "web", path: expect.any(String), remote: "acme/web", defaultBranch: "main" });
    expect(await client.repos.list()).toEqual([added]);
  });

  test("rechaza un repo repetido, una subcarpeta y una carpeta que no es un repo", async () => {
    const repo = repoWith(undefined);
    mkdirSync(join(repo.dir, "src"));
    await client.repos.add({ path: repo.dir });

    await expect(client.repos.add({ path: repo.dir })).rejects.toSatisfy(badRequest(/ya está registrado/));
    await expect(client.repos.add({ path: join(repo.dir, "src") })).rejects.toSatisfy(badRequest(/no es la raíz de un repo/));
    await expect(client.repos.add({ path: scratchDir() })).rejects.toSatisfy(badRequest(/no es un repo de git/));
    expect(await client.repos.list()).toHaveLength(1);
  });
});

describe("repos.testRecipe", () => {
  const events = () =>
    store.events
      .since(0, { types: ["recipe.test_started", "recipe.test_output", "recipe.test_finished"] })
      .map((e) => ({ type: e.type, ...e.payload }));

  test("corre requires, guard y setup con el slot 1 en un worktree desechable y emite la salida", async () => {
    const repo = repoWith({
      version: 1,
      env: { APP_DB: "app_{{slot}}" },
      requires: [{ name: "Git", check: "git --version" }],
      setup: {
        worktree: ["echo instalando > installed.txt && echo worktree-listo"],
        slot: ["test -f installed.txt && echo \"slot $APP_DB en {{slot}}\""],
        guard: { run: "printf %s \"$APP_DB\"", expect: "app_{{slot}}" },
      },
    });
    const { id } = await client.repos.add({ path: repo.dir });

    const result = await client.repos.testRecipe({ repoId: id });

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => [s.phase, s.ok])).toEqual([
      ["requires", true],
      ["guard", true],
      ["setup.worktree", true],
      ["setup.slot", true],
    ]);
    expect(result.steps.at(-1)!.extract).toBe("slot app_1 en 1");
    const log = events();
    const output = log.filter((e) => e.type === "recipe.test_output");
    expect(log[0]).toMatchObject({ type: "recipe.test_started", repoId: id });
    expect(log.slice(1, -1)).toEqual(output);
    expect(output.map((e) => (e as { text?: string }).text).join("")).toContain("worktree-listo");
    expect(log.at(-1)).toMatchObject({ type: "recipe.test_finished", repoId: id, ok: true });
    // El worktree desechable ya no existe ni en el repo ni en disco.
    expect(repo.git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    expect(readdirSync(join(home.path, "recipe-tests"))).toEqual([]);
  });

  test("un comando rojo corta la prueba y se informa su exit y su salida", async () => {
    const repo = repoWith({ version: 1, setup: { worktree: ["echo uno", "echo roto >&2; exit 3", "echo nunca"] } });
    const { id } = await client.repos.add({ path: repo.dir });

    const result = await client.repos.testRecipe({ repoId: id });

    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => [s.ok, s.exitCode, s.extract])).toEqual([
      [true, 0, "uno"],
      [false, 3, "roto"],
    ]);
    expect(events().at(-1)).toMatchObject({ type: "recipe.test_finished", ok: false });
  });

  test("prueba todos los requires y, si falta alguno, no corre el setup", async () => {
    const repo = repoWith({
      version: 1,
      requires: [
        { name: "Postgres", check: "exit 1" },
        { name: "Redis", check: "true" },
        { name: "Doppler", check: "exit 2" },
      ],
      setup: { slot: ["echo no-debe-correr"] },
    });
    const { id } = await client.repos.add({ path: repo.dir });

    const result = await client.repos.testRecipe({ repoId: id });

    expect(result.steps.map((s) => [s.name, s.ok])).toEqual([["Postgres", false], ["Redis", true], ["Doppler", false]]);
    expect(result.ok).toBe(false);
  });

  test("un guard que no resuelve lo esperado corta antes del setup", async () => {
    const repo = repoWith({
      version: 1,
      setup: { guard: { run: "printf otra_db", expect: "db_{{slot}}" }, slot: ["echo no-debe-correr"] },
    });
    const { id } = await client.repos.add({ path: repo.dir });

    const result = await client.repos.testRecipe({ repoId: id });

    expect(result).toMatchObject({ ok: false, steps: [{ phase: "guard", ok: false, extract: 'se esperaba "db_1" y salió "otra_db"' }] });
  });

  test("sin receta, con receta inválida, repo desconocido y prueba en curso son errores", async () => {
    const without = await client.repos.add({ path: repoWith(undefined).dir });
    const invalid = await client.repos.add({ path: repoWith({ version: 2 }).dir });
    const slow = await client.repos.add({ path: repoWith({ version: 1, setup: { worktree: ["echo listo"] } }).dir });

    await expect(client.repos.testRecipe({ repoId: without.id })).rejects.toSatisfy(badRequest(/no tiene \.clanker\/recipe\.json/));
    await expect(client.repos.testRecipe({ repoId: invalid.id })).rejects.toSatisfy(badRequest(/inválido/));
    await expect(client.repos.testRecipe({ repoId: "repo_00000000000000000000000001" })).rejects.toSatisfy(
      (e) => e instanceof ORPCError && e.code === "NOT_FOUND",
    );
    const [first, second] = await Promise.allSettled([
      client.repos.testRecipe({ repoId: slow.id }),
      client.repos.testRecipe({ repoId: slow.id }),
    ]);
    expect([first.status, second.status].sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = [first, second].find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toSatisfy(badRequest(/ya hay una prueba/i));
  });
});
