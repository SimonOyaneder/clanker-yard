import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunId } from "@clanker/api";
import {
  BranchNotAllowedError,
  createAgents,
  createArtifacts,
  createDefs,
  createFlows,
  createProcs,
  createWorkspaces,
  LEASE_TTL_MS,
  newId,
  openStore,
  PermanentActionError,
  StaleLeaseError,
  WorktreeSetupError,
  WorkspaceBusyError,
  workspaceAcquireAction,
  workspaceReleaseAction,
  type Store,
  type WorkspaceLease,
  type Workspaces,
} from "@clanker/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createFakeRuntime } from "./fake-runtime";
import { tempGitRepo, type TempGitRepo, type TempGitRepoOptions } from "./git";

// Workspaces se prueba aquí y no en el core: testkit puede importar el core, y el core no puede
// importar testkit (AGENTS.md, límites entre paquetes).

const demoFixtures = fileURLToPath(new URL("../fixtures/runs/demo", import.meta.url));

const runA = newId("run");
const runB = newId("run");

const repoById = new Map<string, TempGitRepo>();

let clock: number;
let dataDir: string;
let store: Store;
let repos: TempGitRepo[];
let leases: WorkspaceLease[];
let workspaces: Workspaces;

beforeEach(() => {
  clock = 1_000_000;
  dataDir = mkdtempSync(join(tmpdir(), "clanker-ws-"));
  store = openStore({ path: ":memory:", now: () => clock });
  repos = [];
  leases = [];
  workspaces = workspacesOn(store);
});

function workspacesOn(store: Store, worktreeSetup?: (dir: string) => readonly string[]): Workspaces {
  return createWorkspaces({
    store,
    dataDir,
    repos: (id) => ({ path: repoById.get(id)!.dir, defaultBranch: "main", protectedBranches: ["release"] }),
    identity: { name: "Clanker Yard", email: "yard@clanker.invalid" },
    worktreeSetup,
    now: () => clock,
  });
}

afterEach(() => {
  for (const lease of leases) workspaces.release(lease);
  for (const repo of repos) repo.cleanup();
  repoById.clear();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function repo(id: string, opts: TempGitRepoOptions = { remote: true }): string {
  const created = tempGitRepo(opts);
  repos.push(created);
  repoById.set(id, created);
  return id;
}

async function acquire(repoId: string, branch: string, runId: RunId = runA, base = "main") {
  const lease = await workspaces.acquire({ repo: repoId, branch, base, runId });
  leases.push(lease);
  return lease;
}

describe("acquire", () => {
  test("dos acquires de la misma branch: gana uno y el otro ve que está ocupada", async () => {
    const id = repo("r1");

    const results = await Promise.allSettled([acquire(id, "cla-1", runA), acquire(id, "cla-1", runB)]);

    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const loser = results.find((r) => r.status === "rejected");
    expect((loser as PromiseRejectedResult).reason).toBeInstanceOf(WorkspaceBusyError);
  });

  test("crea el worktree bloqueado en worktrees/<repo>/<branch> con la branch sobre la base", async () => {
    const id = repo("r1");

    const lease = await acquire(id, "feat/cla-1");

    expect(lease.path).toBe(join(dataDir, "worktrees", "r1", "feat", "cla-1"));
    const main = repoById.get(id)!.git("rev-parse", "main");
    expect(lease.baseSha).toBe(main);
    const listing = repoById.get(id)!.git("worktree", "list", "--porcelain");
    expect(listing).toContain(`worktree ${realpathSync(lease.path)}`);
    expect(listing).toContain("locked clanker-yard");
    expect(store.events.since(0).map((e) => e.type)).toEqual(["lease.acquired"]);
  });

  test("origin/main y main dan la misma base, y es la punta del remoto aunque main local esté atrás", async () => {
    const id = repo("r1", { remote: true, commits: [{ message: "one" }, { message: "two" }] });
    const r = repoById.get(id)!;
    const originMain = r.git("rev-parse", "origin/main");
    r.git("reset", "--hard", "HEAD~1");
    expect(r.git("rev-parse", "main")).not.toBe(originMain);

    const viaOrigin = await acquire(id, "a", runA, "origin/main");
    const viaLocal = await acquire(id, "b", runA, "main");

    expect(viaOrigin.baseRef).toBe("main");
    expect(viaLocal.baseRef).toBe("main");
    expect(viaOrigin.baseSha).toBe(originMain);
    expect(viaLocal.baseSha).toBe(originMain);
  });

  test(".git/config queda igual al crear un worktree, de una branch nueva o remota", async () => {
    const id = repo("r1", { remote: true, branches: { "cla-2": [{ message: "work" }] } });
    // Solo queda la branch remota: el caso de retomar un PR que no tiene worktree local.
    repoById.get(id)!.git("branch", "--delete", "--force", "cla-2");
    const configPath = join(repoById.get(id)!.dir, ".git", "config");
    const before = readFileSync(configPath, "utf8");

    const fresh = await acquire(id, "cla-1");
    const remote = await acquire(id, "cla-2");

    expect(readFileSync(configPath, "utf8")).toBe(before);
    // La branch remota se retoma desde su punta, no desde la base.
    expect(remote.baseSha).toBe(fresh.baseSha);
    expect(repoById.get(id)!.git("rev-parse", "cla-2")).toBe(repoById.get(id)!.git("rev-parse", "origin/cla-2"));
  });

  test("funciona sin remoto, con la base local", async () => {
    const id = repo("r1", {});

    const lease = await acquire(id, "cla-1");

    expect(lease.baseSha).toBe(repoById.get(id)!.git("rev-parse", "main"));
  });

  test("rechaza la branch por defecto, las protegidas y los nombres inválidos", async () => {
    const id = repo("r1");

    for (const branch of ["main", "refs/heads/main", "release", "mala..rama"]) {
      await expect(acquire(id, branch)).rejects.toBeInstanceOf(BranchNotAllowedError);
    }
    expect(store.events.since(0)).toEqual([]);
  });

  test("no se apropia de una branch local que no creó el sistema, y no deja la fila", async () => {
    const id = repo("r1", { remote: true, branches: { mine: [{ message: "mine" }] } });
    repoById.get(id)!.git("push", "origin", "--delete", "mine");

    await expect(acquire(id, "mine")).rejects.toThrow(/no la creó Clanker Yard/);
    // El lease que alcanzó a tomarse queda soltado también en la línea de tiempo.
    const [acquired, released] = store.events.since(0);
    expect([acquired?.type, released?.type]).toEqual(["lease.acquired", "lease.released"]);
    expect(released?.payload).toMatchObject({ id: acquired?.payload.id, token: acquired?.payload.token });
    // Sin fila huérfana, la branch libre se puede tomar después.
    await expect(acquire(id, "other")).resolves.toBeDefined();
  });

  test("una branch nueva no reusa una carpeta que ya existe, aunque sea un worktree", async () => {
    const id = repo("r1");
    // Lo que pasa en macOS con `CLA-1` después de `cla-1`: la carpeta es la misma.
    const path = join(dataDir, "worktrees", "r1", "cla-1");
    repoById.get(id)!.git("worktree", "add", "-b", "otra", path);

    await expect(acquire(id, "cla-1")).rejects.toBeInstanceOf(BranchNotAllowedError);
    expect(store.db.$client.prepare("SELECT count(*) AS n FROM workspaces").get()).toEqual({ n: 0 });
    expect(repoById.get(id)!.git("-C", path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("otra");
  });

  test("tras release se reusa el mismo worktree con un token nuevo y la branch queda idle", async () => {
    const id = repo("r1");
    const first = await acquire(id, "cla-1", runA);
    workspaces.release(first);

    const second = await acquire(id, "cla-1", runB);

    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.path).toBe(first.path);
    expect(second.fencingToken).toBe(first.fencingToken + 1);
    expect(store.events.since(0).map((e) => e.type)).toEqual([
      "lease.acquired",
      "lease.released",
      "lease.acquired",
    ]);
  });

  test("si borraron la carpeta del worktree, el siguiente acquire la recrea con la branch como estaba", async () => {
    const id = repo("r1");
    const first = await acquire(id, "cla-1", runA);
    await workspaces.git(first, "commit", "--allow-empty", "--message", "wip");
    const head = await workspaces.git(first, "rev-parse", "HEAD");
    workspaces.release(first);
    rmSync(first.path, { recursive: true, force: true });

    const second = await acquire(id, "cla-1", runB);

    expect(second.path).toBe(first.path);
    expect(await workspaces.git(second, "rev-parse", "HEAD")).toBe(head);
    expect(repoById.get(id)!.git("worktree", "list", "--porcelain")).toContain("locked clanker-yard");
  });

  test("un lease vencido se puede tomar y deja un evento lease.expired del anterior", async () => {
    const id = repo("r1");
    const stale = await acquire(id, "cla-1", runA);
    clock += LEASE_TTL_MS + 1;

    const taken = await acquire(id, "cla-1", runB);

    expect(taken.fencingToken).toBe(stale.fencingToken + 1);
    const expired = store.events.since(0).find((e) => e.type === "lease.expired");
    expect(expired?.payload).toMatchObject({ runId: runA, token: stale.fencingToken });
  });
});

describe("setup.worktree", () => {
  /** Los comandos de `setup.worktree` de cada worktree, con un contador de cuántas veces se pidieron. */
  function withSetup(commands: string[]) {
    const dirs: string[] = [];
    workspaces = workspacesOn(store, (dir) => {
      dirs.push(dir);
      return commands;
    });
    return dirs;
  }

  test("corre al crear el worktree, dentro de él, y no al volver a tomar uno que ya existe", async () => {
    const id = repo("r1");
    const dirs = withSetup(["echo instalado > installed.txt", "pwd -P > where.txt"]);

    const lease = await acquire(id, "cla-1");

    expect(readFileSync(join(lease.path, "installed.txt"), "utf8")).toBe("instalado\n");
    expect(readFileSync(join(lease.path, "where.txt"), "utf8").trim()).toBe(realpathSync(lease.path));
    workspaces.release(lease);
    await acquire(id, "cla-1", runB);
    expect(dirs).toEqual([lease.path]);
  });

  test("si falla, el worktree y la branch se borran y el siguiente acquire lo intenta de cero", async () => {
    const id = repo("r1");
    const r = repoById.get(id)!;
    withSetup(["echo cargando", "echo 'sin red' >&2; exit 7"]);

    const error = await acquire(id, "cla-1").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WorktreeSetupError);
    expect((error as Error).message).toMatch(/setup\.worktree falló en .*: echo 'sin red' >&2; exit 7 \(exit 7\)\nsin red/);
    expect(existsSync(join(dataDir, "worktrees", "r1", "cla-1"))).toBe(false);
    expect(r.git("branch", "--list", "cla-1")).toBe("");
    expect(r.git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    expect(store.events.since(0).map((e) => e.type)).toEqual(["lease.acquired", "lease.released"]);

    withSetup(["echo ok > installed.txt"]);
    const retry = await acquire(id, "cla-1");
    expect(readFileSync(join(retry.path, "installed.txt"), "utf8")).toBe("ok\n");
  });

  test("un corte a medio setup deja la fila en creating y el siguiente acquire lo corre de nuevo", async () => {
    const id = repo("r1");
    const dirs = withSetup(["echo instalado > installed.txt"]);
    const lease = await acquire(id, "cla-1");
    // Como lo deja un core que murió durante `setup.worktree`, después de `recover`.
    workspaces.release(lease);
    store.db.$client.prepare("UPDATE workspaces SET state = 'creating'").run();
    rmSync(join(lease.path, "installed.txt"));

    const retry = await acquire(id, "cla-1", runB);

    expect(readFileSync(join(retry.path, "installed.txt"), "utf8")).toBe("instalado\n");
    expect(dirs).toEqual([lease.path, lease.path]);
  });

  test("sin worktreeSetup no corre nada", async () => {
    const id = repo("r1");

    const lease = await acquire(id, "cla-1");

    expect(existsSync(join(lease.path, "installed.txt"))).toBe(false);
  });
});

describe("fencing", () => {
  test("un token viejo se rechaza y no ejecuta nada", async () => {
    const id = repo("r1");
    const stale = await acquire(id, "cla-1", runA);
    clock += LEASE_TTL_MS + 1;
    const current = await acquire(id, "cla-1", runB);

    expect(() => workspaces.validate(stale)).toThrow(StaleLeaseError);
    await expect(workspaces.git(stale, "commit", "--allow-empty", "-m", "zombi")).rejects.toBeInstanceOf(
      StaleLeaseError,
    );
    expect(repoById.get(id)!.git("log", "--format=%s", "cla-1")).not.toContain("zombi");
    await expect(workspaces.git(current, "status", "--short")).resolves.toBe("");
  });

  test("release con un token viejo no suelta el lease de la corrida vigente", async () => {
    const id = repo("r1");
    const stale = await acquire(id, "cla-1", runA);
    clock += LEASE_TTL_MS + 1;
    const current = await acquire(id, "cla-1", runB);

    workspaces.release(stale);

    expect(() => workspaces.validate(current)).not.toThrow();
    await expect(acquire(id, "cla-1", runA)).rejects.toBeInstanceOf(WorkspaceBusyError);
  });

  test("git corre con autor y committer del sistema", async () => {
    const id = repo("r1");
    const lease = await acquire(id, "cla-1");

    await workspaces.git(lease, "commit", "--allow-empty", "-m", "feat: algo");

    const who = await workspaces.git(lease, "log", "-1", "--format=%an <%ae> / %cn <%ce>");
    expect(who).toBe("Clanker Yard <yard@clanker.invalid> / Clanker Yard <yard@clanker.invalid>");
  });
});

describe("heartbeat", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }));
  afterEach(() => vi.useRealTimers());

  const leaseUntil = (workspaceId: string) =>
    (store.db.$client.prepare("SELECT lease_until AS t FROM workspaces WHERE id = ?").get(workspaceId) as { t: number }).t;

  test("renueva el lease cada ttl/3", async () => {
    const lease = await acquire(repo("r1"), "cla-1");
    const before = leaseUntil(lease.workspaceId);

    clock += LEASE_TTL_MS / 3;
    vi.advanceTimersByTime(LEASE_TTL_MS / 3);

    expect(leaseUntil(lease.workspaceId)).toBe(before + LEASE_TTL_MS / 3);
    expect(lease.lost.aborted).toBe(false);
  });

  test("si otra corrida tomó el lease, el latido lo detecta y aborta `lost`", async () => {
    const id = repo("r1");
    const lease = await acquire(id, "cla-1", runA);
    clock += LEASE_TTL_MS + 1;
    const current = await acquire(id, "cla-1", runB);

    vi.advanceTimersByTime(LEASE_TTL_MS / 3);
    const renewedAt = leaseUntil(current.workspaceId);
    clock += LEASE_TTL_MS / 3;
    vi.advanceTimersByTime(LEASE_TTL_MS / 3);

    expect(lease.lost.aborted).toBe(true);
    // Perder el lease viejo no detiene el latido del vigente.
    expect(leaseUntil(current.workspaceId)).toBe(renewedAt + LEASE_TTL_MS / 3);
    expect(current.lost.aborted).toBe(false);
  });

  test("tras un handOver el latido sigue con quien recibió el worktree y el de quien lo entregó aborta `lost`", async () => {
    const id = repo("r1");
    const lease = await acquire(id, "cla-1", runA);
    store.tx((tx) => workspaces.handOver(tx, runA, runB));
    const before = leaseUntil(lease.workspaceId);

    clock += LEASE_TTL_MS / 3;
    vi.advanceTimersByTime(LEASE_TTL_MS / 3);

    expect(leaseUntil(lease.workspaceId)).toBe(before + LEASE_TTL_MS / 3);
    expect(lease.lost.aborted).toBe(true);
  });

  test("si la base falla al renovar, aborta `lost` con el error en vez de lanzar desde el timer", async () => {
    const id = repo("r1");
    const closing = openStore({ path: ":memory:", now: () => clock });
    const lease = await workspacesOn(closing).acquire({ repo: id, branch: "cla-1", base: "main", runId: runA });
    closing.close();

    expect(() => vi.advanceTimersByTime(LEASE_TTL_MS / 3)).not.toThrow();
    expect(lease.lost.aborted).toBe(true);
    expect(lease.lost.reason).toBeInstanceOf(Error);
  });
});

describe("workspace.acquire", () => {
  test("el motor de flujos acepta la acción registrada", () => {
    const defs = createDefs(store);
    const flows = createFlows({
      store,
      defs,
      agents: createAgents({ store, defs, runtime: createFakeRuntime({ fixtures: demoFixtures }) }),
      artifacts: createArtifacts({ store, dir: join(dataDir, "artifacts") }),
      roles: () => undefined,
    });

    expect(() => flows.registerAction(workspaceAcquireAction(workspaces))).not.toThrow();
    expect(() => flows.registerAction(workspaceAcquireAction(workspaces))).toThrow(/workspace\.acquire/);
  });

  test("la acción toma el worktree para la corrida y devuelve el lease sin la señal", async () => {
    const id = repo("r1");
    const action = workspaceAcquireAction(workspaces);

    const result = await action.run({ repo: id, branch: "cla-1", base: "origin/main" }, { runId: runA });

    expect(action.name).toBe("workspace.acquire");
    expect(result.outcome).toBe("ok");
    expect(result.output).toMatchObject({ branch: "cla-1", baseRef: "main", fencingToken: 1 });
    expect(result.output).not.toHaveProperty("lost");
  });

  test("una branch que no se puede usar falla sin reintentos; una ocupada sí se reintenta", async () => {
    const id = repo("r1");
    const action = workspaceAcquireAction(workspaces);

    await expect(action.run({ repo: id, branch: "release", base: "main" }, { runId: runA })).rejects.toBeInstanceOf(PermanentActionError);

    await acquire(id, "cla-1", runA);
    const busy = action.run({ repo: id, branch: "cla-1", base: "main" }, { runId: runB });
    await expect(busy).rejects.toBeInstanceOf(WorkspaceBusyError);
    await expect(busy).rejects.not.toBeInstanceOf(PermanentActionError);
  });
});

describe("held y workspace.release", () => {
  test("held da el worktree que la corrida tiene tomado y deja de darlo al soltarlo", async () => {
    const id = repo("r1");
    expect(workspaces.held(runA)).toBeUndefined();

    const lease = await acquire(id, "cla-1");

    expect(workspaces.held(runA)).toEqual({
      workspaceId: lease.workspaceId,
      path: lease.path,
      branch: "cla-1",
      fencingToken: lease.fencingToken,
      base: "main",
      repoId: id,
    });
    expect(workspaces.held(runB)).toBeUndefined();
    workspaces.release(lease);
    expect(workspaces.held(runA)).toBeUndefined();
  });

  test("releaseHeldBy suelta lo que tiene la corrida, deja lo de otra y no hace nada si no tiene nada", async () => {
    const id = repo("r1");
    await acquire(id, "cla-1", runA);
    await acquire(id, "cla-2", runB);

    workspaces.releaseHeldBy(runA);
    workspaces.releaseHeldBy(runA);

    expect(workspaces.held(runA)).toBeUndefined();
    expect(workspaces.held(runB)).toMatchObject({ branch: "cla-2" });
    expect(store.events.since(0, { runId: runA, types: ["lease.released"] })).toHaveLength(1);
  });

  test("la acción suelta el lease que acquire devolvió, solo con el id y el token", async () => {
    const id = repo("r1");
    const acquired = await workspaceAcquireAction(workspaces).run({ repo: id, branch: "cla-1", base: "main" }, { runId: runA });
    const { workspaceId, fencingToken } = acquired.output as { workspaceId: string; fencingToken: number };

    const released = await workspaceReleaseAction(workspaces).run({ workspaceId, fencingToken }, { runId: runA });

    expect(released.outcome).toBe("ok");
    expect(workspaces.held(runA)).toBeUndefined();
    expect(store.events.since(0).map((e) => e.type)).toEqual(["lease.acquired", "lease.released"]);
  });
});

describe("handOver y reread", () => {
  const rowOf = (lease: WorkspaceLease) =>
    store.db.$client
      .prepare("SELECT holder_run_id AS holder, fencing_token AS token, head_sha AS head, lease_until AS until FROM workspaces WHERE id = ?")
      .get(lease.workspaceId) as { holder: string; token: number; head: string; until: number };

  test("pasa el worktree a otra corrida con fencing + 1: lo que tenía la anterior ya no valida", async () => {
    const id = repo("r1");
    const lease = await acquire(id, "cla-1", runA);

    store.tx((tx) => workspaces.handOver(tx, runA, runB));

    expect(rowOf(lease)).toMatchObject({ holder: runB, token: lease.fencingToken + 1 });
    expect(workspaces.held(runA)).toBeUndefined();
    expect(workspaces.held(runB)).toMatchObject({ workspaceId: lease.workspaceId, fencingToken: lease.fencingToken + 1 });
    expect(() => workspaces.validate(lease)).toThrow(StaleLeaseError);
    expect(store.events.since(0, { types: ["lease.released", "lease.acquired"] }).map((e) => [e.type, e.runId, e.payload.token])).toEqual([
      ["lease.acquired", runA, 1],
      ["lease.released", runA, 1],
      ["lease.acquired", runB, 2],
    ]);
  });

  test("sin worktrees tomados no hace nada, y deja los de otra corrida", async () => {
    const id = repo("r1");
    const lease = await acquire(id, "cla-1", runA);

    store.tx((tx) => workspaces.handOver(tx, runB, newId("run")));

    expect(rowOf(lease)).toMatchObject({ holder: runA, token: lease.fencingToken });
  });

  test("reread deja el head_sha de la fila en el HEAD que tiene el worktree", async () => {
    const id = repo("r1");
    const lease = await acquire(id, "cla-1", runA);
    const before = rowOf(lease).head;

    await workspaces.git(lease, "commit", "--allow-empty", "-m", "rebase de otra corrida");
    await workspaces.reread(runA);

    const head = repoById.get(id)!.git("rev-parse", "cla-1");
    expect(rowOf(lease).head).toBe(head);
    expect(head).not.toBe(before);
  });
});

describe("recover y extendLeases", () => {
  /** Una corrida en la base, sin pasar por el motor: `recover` solo mira su estado. */
  function seedRun(runId: RunId, status: "running" | "parked" | "done") {
    const sqlite = store.db.$client;
    sqlite.exec("PRAGMA foreign_keys = OFF");
    sqlite
      .prepare(
        `INSERT INTO runs (id, subject_type, subject_id, flow_def_id, flow_version, roles, lane, status, writes, params, rounds, started_at)
         VALUES (?, 'issue', ?, 'def_x', 1, '{}', 'dev', ?, 1, '{}', '{}', 0)`,
      )
      .run(runId, runId, status);
    sqlite.exec("PRAGMA foreign_keys = ON");
  }

  const row = (workspaceId: string) =>
    store.db.$client.prepare("SELECT state, holder_run_id AS holder, lease_until AS leaseUntil, fencing_token AS token FROM workspaces WHERE id = ?").get(workspaceId) as {
      state: string;
      holder: string | null;
      leaseUntil: number | null;
      token: number;
    };

  test("el worktree de una corrida viva sigue suyo: mismo token, lease renovado y nadie más lo toma", async () => {
    const id = repo("r1");
    seedRun(runA, "parked");
    const lease = await acquire(id, "cla-1", runA);
    // Un corte largo: el lease venció y otra corrida podría quedárselo.
    clock += 10 * LEASE_TTL_MS;

    const rebooted = workspacesOn(store);
    expect(rebooted.recover()).toBe(1);

    expect(row(lease.workspaceId)).toMatchObject({ state: "leased", holder: runA, token: lease.fencingToken, leaseUntil: clock + LEASE_TTL_MS });
    expect(rebooted.held(runA)).toMatchObject({ path: lease.path });
    expect(() => rebooted.validate(lease)).not.toThrow();
    await expect(rebooted.acquire({ repo: id, branch: "cla-1", base: "main", runId: runB })).rejects.toBeInstanceOf(WorkspaceBusyError);
  });

  test("el worktree de una corrida que ya terminó se suelta", async () => {
    const id = repo("r1");
    seedRun(runA, "done");
    const lease = await acquire(id, "cla-1", runA);

    expect(workspacesOn(store).recover()).toBe(1);

    expect(row(lease.workspaceId)).toMatchObject({ state: "idle", holder: null, leaseUntil: null });
    expect(store.events.since(0).map((e) => e.type)).toEqual(["lease.acquired", "lease.released"]);
    await expect(acquire(id, "cla-1", runB)).resolves.toMatchObject({ fencingToken: lease.fencingToken + 1 });
  });

  test("uno que se quedó a medio crear pierde el lease para que su paso lo tome de nuevo", async () => {
    const id = repo("r1");
    seedRun(runA, "running");
    const lease = await acquire(id, "cla-1", runA);
    store.db.$client.prepare("UPDATE workspaces SET state = 'creating' WHERE id = ?").run(lease.workspaceId);

    workspacesOn(store).recover();

    expect(row(lease.workspaceId)).toMatchObject({ state: "creating", holder: null, leaseUntil: null });
    expect(store.events.since(0).at(-1)).toMatchObject({ type: "lease.expired", payload: { runId: runA, token: lease.fencingToken } });
  });

  test("la corrida que ya tiene el worktree lo vuelve a tomar con un token nuevo, sin avisar un vencimiento", async () => {
    const id = repo("r1");
    const first = await acquire(id, "cla-1", runA);

    const again = await acquire(id, "cla-1", runA);

    expect(again.fencingToken).toBe(first.fencingToken + 1);
    expect(again.path).toBe(first.path);
    expect(store.events.since(0).map((e) => e.type)).toEqual(["lease.acquired", "lease.acquired"]);
    await expect(acquire(id, "cla-1", runB)).rejects.toBeInstanceOf(WorkspaceBusyError);
  });

  test("extendLeases renueva ya los leases de este core: dormir no los pierde", async () => {
    const id = repo("r1");
    const lease = await acquire(id, "cla-1", runA);

    // La máquina duerme 10 min: los latidos no corrieron y el lease venció.
    clock += 10 * 60_000;
    workspaces.extendLeases();

    expect(row(lease.workspaceId).leaseUntil).toBe(clock + LEASE_TTL_MS);
    await expect(acquire(id, "cla-1", runB)).rejects.toBeInstanceOf(WorkspaceBusyError);
  });

  test("exec registra el comando en procs mientras corre", async () => {
    const procs = createProcs({ store, bootId: "boot_now" });
    const id = repo("r1");
    const lease = await acquire(id, "cla-1", runA);
    const withProcs = createWorkspaces({
      store,
      dataDir,
      repos: (repoId) => ({ path: repoById.get(repoId)!.dir, defaultBranch: "main", protectedBranches: [] }),
      identity: { name: "Clanker Yard", email: "yard@clanker.invalid" },
      procs,
      now: () => clock,
    });
    const procRows = () => store.db.$client.prepare("SELECT boot_id AS bootId, kind, step_run_id AS stepRunId FROM procs").all();

    const running = withProcs.exec(lease, "sleep 0.3", { runId: runA, stepId: "stp_1" });
    expect(procRows()).toEqual([{ bootId: "boot_now", kind: "recipe", stepRunId: "stp_1" }]);
    await running;

    expect(procRows()).toEqual([]);
  });
});
