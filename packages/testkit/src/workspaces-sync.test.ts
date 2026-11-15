import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunId } from "@clanker/api";
import {
  commitsApplyAction,
  createArtifacts,
  createDefs,
  createRecipes,
  createSlots,
  createWorkspaces,
  newId,
  openStore,
  PermanentActionError,
  SyncBaseError,
  workspaceSyncBaseAction,
  type GitRemote,
  type Store,
  type WorkspaceLease,
  type Workspaces,
} from "@clanker/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { tempGitRepo, type TempGitRepo, type TempGitRepoOptions } from "./git";

// Mismo motivo que workspaces.test.ts: Workspaces se prueba aquí porque testkit puede importar el core.

const run = newId("run") as RunId;
const BACKUP = (branch: string) => `refs/clanker/backup/${branch}`;

let dataDir: string;
let store: Store;
let repo: TempGitRepo;
let workspaces: Workspaces;
let leases: WorkspaceLease[];
let fetches: number;
let fetchOutcome: "ok" | "unauthorized";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "clanker-sync-"));
  store = openStore({ path: ":memory:" });
  leases = [];
  fetches = 0;
  fetchOutcome = "ok";
});

afterEach(() => {
  for (const lease of leases) workspaces.release(lease);
  repo.cleanup();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** Un `origin` bare local: el fetch es un `git fetch` de verdad, sin red ni credenciales. */
function setup(opts: TempGitRepoOptions = {}, { remote = true } = {}) {
  repo = tempGitRepo({ remote: true, ...opts });
  const fakeRemote: GitRemote = {
    push: () => Promise.reject(new Error("no se usa")),
    fetch: ({ cwd }) => {
      fetches += 1;
      if (fetchOutcome === "ok") execFileSync("git", ["fetch", "origin"], { cwd, stdio: "pipe" });
      return Promise.resolve(fetchOutcome);
    },
  };
  workspaces = createWorkspaces({
    store,
    dataDir,
    repos: () => ({
      path: repo.dir,
      defaultBranch: "main",
      ...(remote && { remote: { url: "sin-uso", repo: "simon/sin-uso", account: "simon" } }),
    }),
    identity: { name: "Clanker Yard", email: "yard@clanker.invalid" },
    remote: fakeRemote,
  });
}

async function acquire(branch = "cla-48") {
  const lease = await workspaces.acquire({ repo: "r1", branch, base: "main", runId: run });
  leases.push(lease);
  return lease;
}

/** Una branch que solo existe en el remoto (sin commits propios), como al retomar un PR. */
async function acquireFromRemote() {
  setup({ ...seed, branches: { "cla-48": [] } });
  repo.git("branch", "--delete", "--force", "cla-48");
  return acquire();
}

/** Un commit nuevo en `origin/main` hecho por otro: el checkout del repo no se entera hasta el fetch. */
function advanceOrigin(files: Record<string, string | null>): string {
  const other = join(dataDir, `other-${Math.random().toString(36).slice(2)}`);
  repo.git("clone", "--quiet", repo.remoteDir!, other);
  for (const [path, content] of Object.entries(files)) {
    if (content === null) repo.git("-C", other, "rm", "--quiet", path);
    else {
      writeFileSync(join(other, path), content);
      repo.git("-C", other, "add", path);
    }
  }
  repo.git("-C", other, "commit", "--quiet", "--message", "chore: advance main");
  repo.git("-C", other, "push", "--quiet", "origin", "main");
  return repo.git("-C", other, "rev-parse", "HEAD");
}

const read = (lease: WorkspaceLease, file: string) => readFileSync(join(lease.path, file), "utf8");
const wt = (lease: WorkspaceLease, ...args: string[]) => repo.git("-C", lease.path, ...args);

const seed: TempGitRepoOptions = {
  commits: [{ message: "chore: initial", files: { "a.txt": "a1\na2\na3\n", "b.txt": "b\n", "old.txt": "old\n" } }],
};

describe("workspace.syncBase", () => {
  test("same: la base no se movió, no toca nada ni crea respaldo", async () => {
    setup(seed);
    const lease = await acquire();
    writeFileSync(join(lease.path, "a.txt"), "a1\nmine\na3\n");

    const result = await workspaces.syncBase(lease);

    expect(result).toEqual({ outcome: "same", baseSha: lease.baseSha });
    expect(fetches).toBe(1);
    expect(read(lease, "a.txt")).toBe("a1\nmine\na3\n");
    expect(repo.git("for-each-ref", "refs/clanker")).toBe("");
  });

  test("rebased: el trabajo (cambios, archivos nuevos y borrados) queda sobre la base nueva y sin staging", async () => {
    setup(seed);
    const lease = await acquire();
    writeFileSync(join(lease.path, "a.txt"), "a1\na2\nmine\n");
    writeFileSync(join(lease.path, "new.txt"), "new\n");
    rmSync(join(lease.path, "old.txt"));
    const moved = advanceOrigin({ "b.txt": "b-main\n", "a.txt": "main-first\na2\na3\n" });

    const result = await workspaces.syncBase(lease);

    expect(result).toEqual({ outcome: "rebased", baseSha: moved, from: lease.baseSha, backup: BACKUP("cla-48") });
    expect(wt(lease, "rev-parse", "HEAD")).toBe(moved);
    expect(workspaces.baseSha(lease)).toBe(moved);
    expect(read(lease, "a.txt")).toBe("main-first\na2\nmine\n");
    expect(read(lease, "b.txt")).toBe("b-main\n");
    expect(read(lease, "new.txt")).toBe("new\n");
    expect(existsSync(join(lease.path, "old.txt"))).toBe(false);
    expect(wt(lease, "status", "--porcelain")).toBe(" M a.txt\n D old.txt\n?? new.txt");
    expect(await workspaces.syncBase(lease)).toEqual({ outcome: "same", baseSha: moved });
  });

  test("conflict: las marcas quedan en los archivos, la lista en el output y lo que no choca se aplica", async () => {
    setup(seed);
    const lease = await acquire();
    writeFileSync(join(lease.path, "a.txt"), "a1\nmine\na3\n");
    writeFileSync(join(lease.path, "b.txt"), "b\nmore\n");
    const moved = advanceOrigin({ "a.txt": "a1\ntheirs\na3\n" });

    const result = await workspaces.syncBase(lease);

    expect(result).toMatchObject({ outcome: "conflict", baseSha: moved, from: lease.baseSha, conflicts: ["a.txt"] });
    expect(result.outcome === "conflict" && result.failures).toContain("a.txt");
    expect(read(lease, "a.txt")).toBe("a1\n<<<<<<< ours\ntheirs\n=======\nmine\n>>>>>>> theirs\na3\n");
    expect(read(lease, "b.txt")).toBe("b\nmore\n");
    expect(wt(lease, "status", "--porcelain")).toBe(" M a.txt\n M b.txt");
    // La base nueva queda registrada: tras resolver, el siguiente sync es `same`.
    expect(workspaces.baseSha(lease)).toBe(moved);
    expect(await workspaces.syncBase(lease)).toEqual({ outcome: "same", baseSha: moved });
  });

  test("conflict: un archivo que la base nueva borró no deja marcas pero se lista, con su versión en el respaldo", async () => {
    setup(seed);
    const lease = await acquire();
    writeFileSync(join(lease.path, "b.txt"), "b-mine\n");
    advanceOrigin({ "b.txt": null });

    const result = await workspaces.syncBase(lease);

    expect(result).toMatchObject({ outcome: "conflict", conflicts: ["b.txt"] });
    expect(result.outcome === "conflict" && result.failures).toContain(BACKUP("cla-48"));
    expect(repo.git("show", `${BACKUP("cla-48")}:b.txt`)).toBe("b-mine");
  });

  test("el respaldo guarda el árbol de antes y permite volver", async () => {
    setup(seed);
    const lease = await acquire();
    writeFileSync(join(lease.path, "a.txt"), "a1\na2\nmine\n");
    writeFileSync(join(lease.path, "new.txt"), "new\n");
    rmSync(join(lease.path, "old.txt"));
    advanceOrigin({ "b.txt": "b-main\n" });

    await workspaces.syncBase(lease);

    const backup = BACKUP("cla-48");
    expect(repo.git("rev-parse", `${backup}^`)).toBe(lease.baseSha);
    expect(repo.git("show", `${backup}:new.txt`)).toBe("new");
    expect(repo.git("diff", "--name-status", `${backup}^`, backup)).toBe("M\ta.txt\nA\tnew.txt\nD\told.txt");
    // Volver: la branch a la base vieja con todo el trabajo sin commit, como estaba.
    wt(lease, "reset", "--hard", backup);
    wt(lease, "reset", "--mixed", `${backup}^`);
    expect(wt(lease, "rev-parse", "HEAD")).toBe(lease.baseSha);
    expect(read(lease, "a.txt")).toBe("a1\na2\nmine\n");
    expect(read(lease, "new.txt")).toBe("new\n");
    expect(existsSync(join(lease.path, "old.txt"))).toBe(false);
    expect(existsSync(join(lease.path, "b.txt"))).toBe(true);
    expect(read(lease, "b.txt")).toBe("b\n");
  });

  test("un respaldo nuevo pisa al anterior", async () => {
    setup(seed);
    const lease = await acquire();
    writeFileSync(join(lease.path, "a.txt"), "a1\na2\nmine\n");
    advanceOrigin({ "b.txt": "b1\n" });
    await workspaces.syncBase(lease);
    const first = repo.git("rev-parse", BACKUP("cla-48"));
    const second = advanceOrigin({ "b.txt": "b2\n" });

    await workspaces.syncBase(lease);

    expect(repo.git("rev-parse", BACKUP("cla-48"))).not.toBe(first);
    expect(wt(lease, "rev-parse", "HEAD")).toBe(second);
  });

  test("lo que git ignora no se toca", async () => {
    setup({ commits: [{ message: "chore: initial", files: { ".gitignore": "node_modules\n", "a.txt": "a\n" } }] });
    const lease = await acquire();
    writeFileSync(join(lease.path, "node_modules"), "dep\n");
    writeFileSync(join(lease.path, "x.txt"), "x\n");
    advanceOrigin({ "b.txt": "b\n" });

    await workspaces.syncBase(lease);

    expect(read(lease, "node_modules")).toBe("dep\n");
    expect(read(lease, "x.txt")).toBe("x\n");
  });

  test("un syncBase cortado tras el reset se retoma desde el respaldo", async () => {
    setup(seed);
    const lease = await acquire();
    writeFileSync(join(lease.path, "a.txt"), "a1\na2\nmine\n");
    const moved = advanceOrigin({ "b.txt": "b-main\n" });
    const done = await workspaces.syncBase(lease);
    // Se deshace lo que el corte no alcanzó a hacer: la base guardada sigue siendo la vieja y el worktree quedó limpio sobre la nueva.
    store.db.$client.prepare("UPDATE workspaces SET base_sha = ? WHERE id = ?").run(lease.baseSha, lease.workspaceId);
    wt(lease, "checkout", "--", ".");

    expect(await workspaces.syncBase(lease)).toEqual(done);

    expect(wt(lease, "rev-parse", "HEAD")).toBe(moved);
    expect(read(lease, "a.txt")).toBe("a1\na2\nmine\n");
    expect(workspaces.baseSha(lease)).toBe(moved);
  });

  describe("lo que no puede rebasear", () => {
    test("commits propios: lanza y deja todo como estaba", async () => {
      setup(seed);
      const lease = await acquire();
      writeFileSync(join(lease.path, "a.txt"), "own\n");
      wt(lease, "commit", "--all", "--message", "feat: own");
      advanceOrigin({ "b.txt": "b-main\n" });

      await expect(workspaces.syncBase(lease)).rejects.toThrow(SyncBaseError);
      await expect(workspaces.syncBase(lease)).rejects.toThrow(/commits propios/);

      expect(read(lease, "a.txt")).toBe("own\n");
      expect(workspaces.baseSha(lease)).toBe(lease.baseSha);
      expect(repo.git("for-each-ref", "refs/clanker")).toBe("");
    });

    test("branch que ya está en el remoto: lanza", async () => {
      const lease = await acquireFromRemote();
      advanceOrigin({ "b.txt": "b-main\n" });

      await expect(workspaces.syncBase(lease)).rejects.toThrow(/ya está en el remoto/);

      expect(workspaces.baseSha(lease)).toBe(lease.baseSha);
    });

    test("credenciales revocadas en el fetch: lanza", async () => {
      setup(seed);
      const lease = await acquire();
      fetchOutcome = "unauthorized";

      await expect(workspaces.syncBase(lease)).rejects.toThrow(/reconéctala/);
    });

    test("sin remoto configurado no hay fetch: la base es la que ya tiene el checkout", async () => {
      setup(seed, { remote: false });
      const lease = await acquire();
      advanceOrigin({ "b.txt": "b-main\n" });

      expect(await workspaces.syncBase(lease)).toEqual({ outcome: "same", baseSha: lease.baseSha });
      expect(fetches).toBe(0);
    });

    test("un lease perdido no ejecuta nada", async () => {
      setup(seed);
      const lease = await acquire();
      store.db.$client.prepare("UPDATE workspaces SET fencing_token = fencing_token + 1").run();

      await expect(workspaces.syncBase(lease)).rejects.toThrow(/ya no es el vigente/);
    });
  });
});

describe("acción workspace.syncBase", () => {
  const once = { once: <T>(_stage: string, fn: () => Promise<T>) => fn() };

  test("entrega el outcome y deja el resto como output", async () => {
    setup(seed);
    const lease = await acquire();
    writeFileSync(join(lease.path, "a.txt"), "a1\nmine\na3\n");
    const moved = advanceOrigin({ "a.txt": "a1\ntheirs\na3\n" });
    const action = workspaceSyncBaseAction(workspaces);
    const ws = { workspaceId: lease.workspaceId, path: lease.path, branch: lease.branch, baseSha: lease.baseSha, fencingToken: lease.fencingToken };

    const result = await action.run({ ws }, { ...once, runId: run, stepId: "stp_1", key: "k", signal: new AbortController().signal });

    expect(action.outcomes).toEqual(["same", "rebased", "conflict"]);
    expect(result).toMatchObject({ outcome: "conflict", output: { baseSha: moved, conflicts: ["a.txt"], backup: BACKUP("cla-48") } });
  });

  test("lo que no se puede rebasear es permanente: no se reintenta", async () => {
    const lease = await acquireFromRemote();
    advanceOrigin({ "b.txt": "b-main\n" });
    const ws = { workspaceId: lease.workspaceId, path: lease.path, branch: lease.branch, baseSha: lease.baseSha, fencingToken: lease.fencingToken };

    await expect(
      workspaceSyncBaseAction(workspaces).run({ ws }, { ...once, runId: run, stepId: "stp_1", key: "k", signal: new AbortController().signal }),
    ).rejects.toThrow(PermanentActionError);
  });
});

describe("tras un rebase", () => {
  test("commits.apply parte de la base nueva aunque `$ws` traiga la vieja", async () => {
    setup(seed);
    const lease = await acquire();
    writeFileSync(join(lease.path, "a.txt"), "a1\na2\nmine\n");
    const moved = advanceOrigin({ "b.txt": "b-main\n" });
    await workspaces.syncBase(lease);
    const artifacts = createArtifacts({ store, dir: join(dataDir, "artifacts") });
    const recipes = createRecipes({ store, defs: createDefs(store), workspaces, artifacts, slots: createSlots({ store }) });
    const { workspaceId, path, branch, baseSha, fencingToken } = lease;
    expect(baseSha).not.toBe(moved);

    const result = await commitsApplyAction({ workspaces, recipes }).run(
      {
        ws: { workspaceId, path, branch, baseSha, fencingToken },
        plan: { commits: [{ message: "feat: mine", hunks: ["h1"], tests: [] }] },
      },
      { runId: run, stepId: "stp_1", key: "k", signal: new AbortController().signal, once: (_stage, fn) => fn() },
    );

    expect(result.outcome).toBe("ok");
    expect(wt(lease, "log", "--format=%s", `${moved}..HEAD`)).toBe("feat: mine");
  });
});
