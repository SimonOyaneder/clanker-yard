import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunId } from "@clanker/api";
import {
  BranchNotAllowedError,
  createDefs,
  createFlows,
  createWorkspaces,
  LEASE_TTL_MS,
  newId,
  openStore,
  StaleLeaseError,
  WorkspaceBusyError,
  workspaceAcquireAction,
  type Store,
  type WorkspaceLease,
  type Workspaces,
} from "@clanker/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tempGitRepo, type TempGitRepo, type TempGitRepoOptions } from "./git";

// Workspaces se prueba aquí y no en el core: testkit puede importar el core, y el core no puede
// importar testkit (AGENTS.md, límites entre paquetes).

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
  workspaces = createWorkspaces({
    store,
    dataDir,
    repos: (id) => ({ path: repoById.get(id)!.dir, defaultBranch: "main", protectedBranches: ["release"] }),
    identity: { name: "Clanker Yard", email: "yard@clanker.invalid" },
    now: () => clock,
  });
});

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
});

describe("workspace.acquire", () => {
  test("el motor de flujos acepta la acción registrada", () => {
    const flows = createFlows({ defs: createDefs(store), roles: () => undefined });

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
});
