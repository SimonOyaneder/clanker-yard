import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunId } from "@clanker/api";
import {
  ARCHIVE_TTL_MS,
  createConnections,
  createErrorReporter,
  createFileSecrets,
  createAskpass,
  createGitRemote,
  createPrCache,
  createPrs,
  createRepos,
  createPacks,
  createDefs,
  createWatch,
  createWorkspaces,
  newId,
  openStore,
  startCleanup,
  type Cleanup,
  type Store,
  type Watch,
  type WorkspaceLease,
  type Workspaces,
} from "@clanker/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tempGitRepo, type TempGitRepo } from "./git";
import { startGitHubSim, type GitHubSim } from "./github-sim";

// Archivar y borrar los worktrees de PRs que terminaron (`docs/design.html#d-ops`, estados del worktree), con
// repos git reales, el GitHub simulado y Watch como quien se entera de que el PR se mergeó. El reloj es `clock`.

vi.setConfig({ testTimeout: 20_000 });

const TOKEN = "github_pat_UNIQUE-0123456789";
const ACCOUNT = "octocat";
const REPO = "octocat/secret-project";
const MINUTE = 60_000;

let dir: string;
let store: Store;
let origin: TempGitRepo;
let sim: GitHubSim;
let workspaces: Workspaces;
let watch: Watch;
let cleaner: Cleanup | undefined;
let askpass: ReturnType<typeof createAskpass>;
let clock: number;
const run = newId("run") as RunId;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "clanker-archive-"));
  clock = Date.UTC(2026, 10, 15);
  store = openStore({ path: ":memory:", now: () => clock });
  origin = tempGitRepo({
    remote: true,
    commits: [{ message: "chore: base", files: { "a.txt": "a\n" } }],
    branches: {
      one: [{ message: "feat: one", files: { "one.txt": "1\n" } }],
      two: [{ message: "feat: two", files: { "two.txt": "2\n" } }],
    },
  });
  // Las branches de un PR existen en el remoto; una local con ese nombre sería "del usuario" para `acquire`.
  origin.git("branch", "-D", "one", "two");
  sim = await startGitHubSim({ origin, token: TOKEN });
  const connections = createConnections(store, createFileSecrets({ dir }), { github: { baseUrl: sim.baseUrl } });
  await connections.connect({ provider: "github", account: ACCOUNT, scopes: [], token: TOKEN }, "core");
  const repos = createRepos(store, { remote: (repo) => ({ url: `file://${origin.remoteDir}`, repo, account: ACCOUNT }) });
  repos.add({ name: "secret-project", path: origin.dir, remote: REPO });

  const packs = createPacks({ defs: createDefs(store) });
  const prs = createPrs({ connections, packs });
  askpass = createAskpass();
  const remote = createGitRemote({ askpass, connections });
  workspaces = createWorkspaces({
    store,
    dataDir: dir,
    repos: repos.config,
    identity: { name: "Clanker Yard", email: "yard@clanker.invalid" },
    remote,
    now: () => clock,
  });
  const errors = createErrorReporter(store);
  const cache = createPrCache({ store, repos, prs, onChange: (_ref, state) => state.state === "merged" && cleaner?.request(), now: () => clock });
  watch = createWatch({ store, connections, repos, cache, remote, waitKeys: () => [], events: { flush: () => Promise.resolve() }, errors, now: () => clock });
});

afterEach(async () => {
  await cleaner?.stop();
  cleaner = undefined;
  await watch.stop();
  await askpass.close();
  await sim.close();
  origin.cleanup();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const repoId = () => (store.db.$client.prepare("SELECT id FROM repos").get() as { id: string }).id;
const row = (branch: string) =>
  store.db.$client.prepare("SELECT state, archived_at, holder_run_id FROM workspaces WHERE branch = ?").get(branch) as
    | { state: string; archived_at: number | null; holder_run_id: string | null }
    | undefined;
const setPrState = (state: string) => store.db.$client.prepare("UPDATE pull_requests SET state = ?").run(state);

/** Watch descubre el PR (o ve que cambió). */
async function wake(ms = 6 * MINUTE) {
  clock += ms;
  await watch.tick();
}

/** Toma `branch`, hace `work` en ella, la suelta y deja a Watch viendo su PR abierto. */
async function idleWorktreeWithPr(branch: string, work: (lease: WorkspaceLease) => Promise<void> = async () => undefined) {
  const lease = await workspaces.acquire({ repo: repoId(), branch, base: "main", runId: run });
  const pr = sim.openPr({ head: branch });
  await wake();
  await work(lease);
  workspaces.release(lease);
  return { lease, pr };
}

describe("archivar", () => {
  test("un PR mergeado archiva el worktree idle; a los 7 días se borra con su branch y su fila", async () => {
    const { lease, pr } = await idleWorktreeWithPr("one");
    const mine = origin.git("worktree", "add", join(dir, "user-wt"), "-b", "mine");
    expect(mine).toBeDefined();

    expect(await workspaces.cleanup()).toMatchObject({ archived: 0 });
    expect(row("one")?.state).toBe("idle");

    pr.merge();
    await wake();
    const mergedAt = clock;
    expect(await workspaces.cleanup()).toEqual({ archived: 1, reopened: 0, removed: 0, kept: 0 });
    expect(row("one")).toMatchObject({ state: "archived", archived_at: mergedAt });
    expect(existsSync(lease.path)).toBe(true);

    clock = mergedAt + ARCHIVE_TTL_MS - 1;
    expect(await workspaces.cleanup()).toMatchObject({ removed: 0 });
    expect(existsSync(lease.path)).toBe(true);

    clock = mergedAt + ARCHIVE_TTL_MS;
    expect(await workspaces.cleanup()).toEqual({ archived: 0, reopened: 0, removed: 1, kept: 0 });
    expect(row("one")).toBeUndefined();
    expect(existsSync(lease.path)).toBe(false);
    expect(origin.git("worktree", "list", "--porcelain")).not.toContain(lease.path);
    expect(origin.git("branch", "--list", "one")).toBe("");
    // El worktree y la branch del usuario no son del sistema: ni se miran.
    expect(existsSync(join(dir, "user-wt"))).toBe(true);
    expect(origin.git("branch", "--list", "mine")).toContain("mine");
  });

  test("un PR cerrado sin merge también archiva; si se reabre, vuelve a idle y no se borra", async () => {
    await idleWorktreeWithPr("one");

    setPrState("closed");
    expect(await workspaces.cleanup()).toMatchObject({ archived: 1 });
    expect(row("one")?.state).toBe("archived");

    setPrState("open");
    expect(await workspaces.cleanup()).toMatchObject({ archived: 0, reopened: 1 });
    expect(row("one")).toMatchObject({ state: "idle", archived_at: null });

    clock += 30 * 24 * 60 * MINUTE;
    expect(await workspaces.cleanup()).toMatchObject({ removed: 0 });
    expect(row("one")?.state).toBe("idle");
  });

  test("con otro PR abierto de la misma branch no se archiva", async () => {
    const { pr } = await idleWorktreeWithPr("one");
    pr.merge();
    await wake();
    sim.openPr({ head: "one" });
    await wake();

    expect(await workspaces.cleanup()).toMatchObject({ archived: 0 });
    expect(row("one")?.state).toBe("idle");
  });

  test("una corrida que tiene el worktree (viva o estacionada) lo conserva aunque el PR termine; al soltarlo se archiva", async () => {
    const lease = await workspaces.acquire({ repo: repoId(), branch: "one", base: "main", runId: run });
    const pr = sim.openPr({ head: "one" });
    await wake();
    pr.merge();
    await wake();

    expect(await workspaces.cleanup()).toMatchObject({ archived: 0, removed: 0 });
    clock += 2 * ARCHIVE_TTL_MS;
    workspaces.extendLeases();
    expect(await workspaces.cleanup()).toMatchObject({ archived: 0, removed: 0 });
    expect(row("one")).toMatchObject({ state: "leased", holder_run_id: run });
    expect(existsSync(lease.path)).toBe(true);

    workspaces.release(lease);
    expect(await workspaces.cleanup()).toMatchObject({ archived: 1, removed: 0 });
    expect(existsSync(lease.path)).toBe(true);
  });

  test("al soltarse el worktree de un PR ya mergeado, la limpieza automática lo archiva", async () => {
    cleaner = startCleanup({ workspaces, errors: createErrorReporter(store) });
    const lease = await workspaces.acquire({ repo: repoId(), branch: "one", base: "main", runId: run });
    const pr = sim.openPr({ head: "one" });
    await wake();
    pr.merge();
    await wake();
    store.events.subscribe(() => cleaner?.request(), { types: ["lease.released"] });

    workspaces.release(lease);
    await cleaner.stop();

    expect(row("one")?.state).toBe("archived");
  });
});

describe("no perder trabajo", () => {
  /** El PR se mergea, se archiva y pasan los 7 días. */
  async function expired(pr: { merge(): void }) {
    pr.merge();
    await wake();
    await workspaces.cleanup();
    clock += ARCHIVE_TTL_MS;
  }

  test("con commits sin pushear no se borra, y se borra cuando ya no queda nada", async () => {
    const { lease, pr } = await idleWorktreeWithPr("one", async (held) => {
      writeFileSync(join(held.path, "extra.txt"), "x\n");
      await workspaces.git(held, "add", "extra.txt");
      await workspaces.git(held, "commit", "--message", "feat: extra");
    });
    await expired(pr);

    expect(await workspaces.cleanup()).toEqual({ archived: 0, reopened: 0, removed: 0, kept: 1 });
    expect(row("one")?.state).toBe("archived");
    expect(existsSync(lease.path)).toBe(true);

    // Alguien lo pushea a mano desde el worktree: ya está en el remoto y no se pierde nada.
    origin.git("-C", lease.path, "push", "origin", "one");
    expect(await workspaces.cleanup()).toMatchObject({ removed: 1, kept: 0 });
    expect(existsSync(lease.path)).toBe(false);
  });

  test("con cambios sin commitear o un archivo nuevo tampoco", async () => {
    const { lease, pr } = await idleWorktreeWithPr("one");
    await expired(pr);

    writeFileSync(join(lease.path, "one.txt"), "editado\n");
    expect(await workspaces.cleanup()).toMatchObject({ removed: 0, kept: 1 });

    origin.git("-C", lease.path, "checkout", "--", "one.txt");
    writeFileSync(join(lease.path, "nuevo.txt"), "n\n");
    expect(await workspaces.cleanup()).toMatchObject({ removed: 0, kept: 1 });
    expect(existsSync(lease.path)).toBe(true);
  });

  test("un archivado que alguien vuelve a tomar no se borra, y sale de archived", async () => {
    const { lease, pr } = await idleWorktreeWithPr("one");
    await expired(pr);

    const taken = await workspaces.acquire({ repo: repoId(), branch: "one", base: "main", runId: run });
    expect(taken.workspaceId).toBe(lease.workspaceId);
    expect(row("one")).toMatchObject({ state: "leased", archived_at: null });
    expect(await workspaces.cleanup()).toMatchObject({ removed: 0, archived: 0 });
    expect(existsSync(lease.path)).toBe(true);
    workspaces.release(taken);
  });

  test("si git no puede borrarlo la fila vuelve y los demás siguen", async () => {
    const one = await idleWorktreeWithPr("one");
    const two = await idleWorktreeWithPr("two");
    one.pr.merge();
    two.pr.merge();
    await wake();
    await workspaces.cleanup();
    clock += ARCHIVE_TTL_MS;
    // Un archivo en el lugar del worktree: no hay estado que revisar ni nada que git pueda borrar.
    rmSync(one.lease.path, { recursive: true });
    writeFileSync(one.lease.path, "ya no es un worktree");

    await expect(workspaces.cleanup()).rejects.toThrow(/No se pudo borrar 1 worktree/);

    expect(row("one")?.state).toBe("archived");
    expect(row("two")).toBeUndefined();
    expect(existsSync(two.lease.path)).toBe(false);
  });
});

describe("startCleanup", () => {
  test("junta los pedidos que llegan en vuelo en una sola pasada más y anota una vez lo que falla", async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const failing: Pick<Workspaces, "cleanup"> = {
      async cleanup() {
        calls++;
        await gate;
        throw new Error("disco lleno");
      },
    };
    const errors = createErrorReporter(store);

    const loop = startCleanup({ workspaces: failing, errors, everyMs: 3_600_000 });
    loop.request();
    loop.request();
    release();
    await loop.stop();

    expect(calls).toBe(1);
    loop.request();
    const reports = () => store.db.$client.prepare("SELECT payload FROM events WHERE type = 'error'").all();
    expect(reports()).toHaveLength(1);
    expect(JSON.stringify(reports())).toContain("disco lleno");
  });
});
