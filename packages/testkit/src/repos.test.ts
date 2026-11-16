import { mkdirSync, readdirSync, readFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@clanker/api";
import { createConnections, createFileSecrets, createRepos, createSlots, newId, openStore, RepoNotFoundError, type Core, type Store } from "@clanker/core";
import { startCore } from "./start-core";
import { ORPCError } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
    connections: createConnections(store, createFileSecrets({ dir: join(home.path, "secrets") })),
    runtimes: [createFakeRuntime({ fixtures: home.path, speed: Infinity })],
    env: { CORE_RUNTIME: "fake" },
    scheduler: false,
    coreVersion: "0.0.0",
    onShutdown: () => {},
  });
  client = createClient({ url: core.server.url, token: core.server.token, origin: "cli" });
});

afterEach(async () => {
  vi.unstubAllEnvs();
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

    expect(added).toEqual({ id: expect.stringMatching(/^repo_/), name: "web", path: expect.any(String), remote: "acme/web", defaultBranch: "main", mergeStrategy: null });
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

describe("el override de la estrategia de merge", () => {
  test("repos.list lo trae: null mientras no se fije, y vuelve a null al quitarlo", async () => {
    const repo = repoWith(undefined);
    const { id } = await client.repos.add({ path: repo.dir });
    const repos = createRepos(store);
    expect(await client.repos.list()).toMatchObject([{ id, mergeStrategy: null }]);

    repos.setMergeStrategy(id, "off");
    expect(await client.repos.list()).toMatchObject([{ id, mergeStrategy: "off" }]);

    repos.setMergeStrategy(id, null);
    expect(await client.repos.list()).toMatchObject([{ id, mergeStrategy: null }]);
  });

  test("un repo que no existe lanza RepoNotFoundError", () => {
    expect(() => createRepos(store).setMergeStrategy("repo_nope", "on")).toThrow(RepoNotFoundError);
  });
});

describe("repos.testRecipe", () => {
  const events = () =>
    store.events
      .since(0, { types: ["recipe.test_started", "recipe.test_output", "recipe.test_finished"] })
      .map((e) => ({ type: e.type, ...e.payload }));

  /** El slot que dejó la prueba: lo que `finishSetup` o un setup cortado escribieron en la base. */
  const slotRow = (idx: number) =>
    store.db.$client.prepare("SELECT reserved_for AS pool, holder_run_id AS holder, workspace_id AS workspaceId, setup_hash AS hash, dirty, env FROM slots WHERE idx = ?").get(idx);

  test("corre requires, setup y guard con un slot de mantenimiento en un worktree desechable y emite la salida", async () => {
    const repo = repoWith({
      version: 1,
      slots: { dev: 1, maintenance: 1 },
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
      ["setup.worktree", true],
      ["guard", true],
      ["setup.slot", true],
    ]);
    expect(result.steps.at(-1)!.extract).toBe("slot app_2 en 2");
    // Tomó el slot 2 (el único del pool de mantenimiento), lo soltó y lo dejó sin dueño de su preparación.
    expect(slotRow(2)).toMatchObject({ pool: "maintenance", holder: null, workspaceId: null, hash: null, dirty: 0, env: '{"APP_DB":"app_2"}' });
    expect(slotRow(1)).toMatchObject({ pool: "dev", holder: null });
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

  test("el git de la prueba no les pasa los secretos del entorno del core al config del repo", async () => {
    const repo = repoWith({ version: 1, setup: { worktree: ["true"] } });
    // `core.fsmonitor` lo corre git al mirar el índice, y el config del repo lo puede escribir un agente.
    const seen = join(scratchDir(), "fsmonitor-env");
    const monitor = join(scratchDir(), "fsmonitor");
    writeFileSync(monitor, `#!/bin/sh\necho "gh=$GH_TOKEN anthropic=$ANTHROPIC_API_KEY" >> ${seen}\n`, { mode: 0o755 });
    repo.git("config", "core.fsmonitor", monitor);
    vi.stubEnv("GH_TOKEN", "secreto");
    vi.stubEnv("ANTHROPIC_API_KEY", "secreto");
    const { id } = await client.repos.add({ path: repo.dir });

    expect((await client.repos.testRecipe({ repoId: id })).ok).toBe(true);
    expect(readFileSync(seen, "utf8")).not.toContain("secreto");
  });

  test("cada comando queda en procs mientras corre, para que un arranque tras un crash lo mate", async () => {
    const repo = repoWith({ version: 1, setup: { worktree: ["sleep 1"] } });
    const { id } = await client.repos.add({ path: repo.dir });
    const procs = () => store.db.$client.prepare("SELECT kind FROM procs").all();

    const testing = client.repos.testRecipe({ repoId: id });
    await vi.waitFor(() => expect(procs()).toEqual([{ kind: "recipe" }]), { timeout: 5000 });

    expect((await testing).ok).toBe(true);
    expect(procs()).toEqual([]);
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
      slots: { dev: 1, maintenance: 1 },
      setup: { guard: { run: "printf otra_db", expect: "db_{{slot}}" }, slot: ["echo no-debe-correr"] },
    });
    const { id } = await client.repos.add({ path: repo.dir });

    const result = await client.repos.testRecipe({ repoId: id });

    expect(result).toMatchObject({ ok: false, steps: [{ phase: "guard", ok: false, extract: 'se esperaba "db_2" y salió "otra_db"' }] });
    expect(slotRow(2)).toMatchObject({ holder: null, dirty: 0 });
  });

  test("un setup.slot rojo deja el slot sucio, pero suelto", async () => {
    const repo = repoWith({ version: 1, slots: { dev: 1, maintenance: 1 }, setup: { slot: ["exit 4"] } });
    const { id } = await client.repos.add({ path: repo.dir });

    const result = await client.repos.testRecipe({ repoId: id });

    expect(result.ok).toBe(false);
    expect(slotRow(2)).toMatchObject({ holder: null, dirty: 1 });
  });

  test("con el pool de mantenimiento lleno falla sin esperar, aunque el de dev esté libre; sin slots, {{slot}} es un error de la receta", async () => {
    const full = repoWith({ version: 1, slots: { dev: 1, maintenance: 1 }, setup: { slot: ["echo listo"] } });
    const { id } = await client.repos.add({ path: full.dir });
    const slots = createSlots({ store });
    const busy = slots.tryAcquire({ repoId: id, lane: "maintenance", runId: newId("run"), pools: { dev: 1, maintenance: 1 } })!;
    expect(busy).toBeDefined();

    await expect(client.repos.testRecipe({ repoId: id })).rejects.toSatisfy(badRequest(/slots de mantenimiento .* ocupados/));
    slots.release(busy);

    const noSlots = repoWith({ version: 1, env: { APP_DB: "app_{{slot}}" } });
    const { id: noSlotsId } = await client.repos.add({ path: noSlots.dir });
    await expect(client.repos.testRecipe({ repoId: noSlotsId })).rejects.toSatisfy(badRequest(/\{\{slot\}\}.*define slots en la receta/));
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

describe("repos.overview", () => {
  test("cada repo con su receta y su última prueba; una carpeta que ya no existe es inválida", async () => {
    const withRecipe = repoWith({ version: 1, requires: [{ name: "Git", check: "git --version" }] });
    const without = repoWith(undefined);
    const gone = repoWith(undefined);
    const tested = await client.repos.add({ path: withRecipe.dir, name: "a-con-receta" });
    await client.repos.add({ path: without.dir, name: "b-sin-receta" });
    await client.repos.add({ path: gone.dir, name: "c-borrado" });
    rmSync(gone.dir, { recursive: true, force: true });

    expect((await client.repos.testRecipe({ repoId: tested.id })).ok).toBe(true);
    const overview = await client.repos.overview();

    expect(overview.map(({ repo, recipe, lastTest }) => [repo.name, recipe.status, lastTest?.ok ?? null])).toEqual([
      ["a-con-receta", "found", true],
      ["b-sin-receta", "missing", null],
      ["c-borrado", "invalid", null],
    ]);
  });
});
