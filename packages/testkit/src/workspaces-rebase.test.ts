import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RunId } from "@clanker/api";
import {
  AttachError,
  createWorkspaces,
  newId,
  openStore,
  RebaseError,
  type GitRemote,
  type Store,
  type WorkspaceLease,
  type Workspaces,
} from "@clanker/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tempGitRepo, type TempGitRepo } from "./git";

// Retomar un PR (`workspaces.attach`) y rebasearlo (`workspaces.rebase`) sobre repos git reales con un
// `origin` bare local: sin red ni credenciales.

vi.setConfig({ testTimeout: 30_000 });

const run = newId("run") as RunId;

let dataDir: string;
let store: Store;
let repo: TempGitRepo;
let workspaces: Workspaces;
let leases: WorkspaceLease[];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "clanker-rebase-"));
  store = openStore({ path: ":memory:" });
  leases = [];
  repo = tempGitRepo({
    remote: true,
    commits: [{ message: "chore: initial", files: { "a.txt": "a1\na2\na3\n", "b.txt": "b\n" } }],
  });
  const remote: GitRemote = {
    push: () => Promise.reject(new Error("no se usa")),
    lsRemote: () => Promise.reject(new Error("no se usa")),
    fetch: ({ cwd }) => {
      execFileSync("git", ["fetch", "origin"], { cwd, stdio: "pipe" });
      return Promise.resolve("ok");
    },
  };
  workspaces = createWorkspaces({
    store,
    dataDir,
    repos: () => ({ path: repo.dir, defaultBranch: "main", remote: { url: "sin-uso", repo: "simon/sin-uso", account: "simon" } }),
    identity: { name: "Clanker Yard", email: "yard@clanker.invalid" },
    remote,
  });
});

afterEach(() => {
  for (const lease of leases) workspaces.release(lease);
  repo.cleanup();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** Un clon de `origin` donde otro (una persona, otro PR) hace commits y pushea. */
function elsewhere<T>(fn: (git: (...args: string[]) => string, dir: string) => T): T {
  const dir = join(dataDir, `other-${Math.random().toString(36).slice(2)}`);
  repo.git("clone", "--quiet", repo.remoteDir!, dir);
  const git = (...args: string[]) => repo.git("-C", dir, ...args);
  return fn(git, dir);
}

function put(dir: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

/** Una branch pusheada al remoto, con un commit por entrada, sobre `from` (por defecto `main`). */
function pushBranch(branch: string, commits: Record<string, string>[], from = "main") {
  elsewhere((git, dir) => {
    git("checkout", "--quiet", "-b", branch, `origin/${from}`);
    for (const [i, files] of commits.entries()) {
      put(dir, files);
      git("add", "--all");
      git("commit", "--quiet", "--message", `feat: ${branch} ${i + 1}`);
    }
    git("push", "--quiet", "origin", branch);
  });
}

/** Un commit de `files` en `branch` del remoto, hecho por otro, y el fetch que el flujo ya hizo en `attach`. */
async function advance(branch: string, files: Record<string, string>, message?: string) {
  const sha = moveRemote(branch, files, message);
  await workspaces.fetch("r1");
  return sha;
}

function moveRemote(branch: string, files: Record<string, string>, message = "chore: advance") {
  return elsewhere((git, dir) => {
    git("checkout", "--quiet", branch);
    put(dir, files);
    git("add", "--all");
    git("commit", "--quiet", "--message", message);
    git("push", "--quiet", "origin", branch);
    return git("rev-parse", "HEAD");
  });
}

async function attach(branch: string, base = "main") {
  const lease = await workspaces.attach({ repo: "r1", branch, base, runId: run });
  leases.push(lease);
  return lease;
}

const wt = (lease: WorkspaceLease, ...args: string[]) => repo.git("-C", lease.path, ...args);
const head = (lease: WorkspaceLease) => wt(lease, "rev-parse", "HEAD");
const origin = (ref: string) => repo.git("--git-dir", repo.remoteDir!, "rev-parse", ref);
const row = (lease: WorkspaceLease) =>
  store.db.$client
    .prepare("SELECT base_ref AS baseRef, base_sha AS baseSha, head_sha AS headSha, remote_sha AS remoteSha, state, holder_run_id AS holder FROM workspaces WHERE id = ?")
    .get(lease.workspaceId) as { baseRef: string; baseSha: string; headSha: string; remoteSha: string; state: string; holder: string | null };
const subjects = (lease: WorkspaceLease, range: string) => wt(lease, "log", "--reverse", "--format=%s", range).split("\n").filter(Boolean);
const read = (lease: WorkspaceLease, file: string) => readFileSync(join(lease.path, file), "utf8");
const resolveAll = (lease: WorkspaceLease, files: string[], text = "resuelto\n") => {
  for (const file of files) writeFileSync(join(lease.path, file), text);
};

describe("workspaces.attach", () => {
  test("sin worktree lo crea desde la branch remota y su punta es el remote_sha", async () => {
    pushBranch("cla-1", [{ "a.txt": "a1\nmine\na3\n" }]);

    const lease = await attach("cla-1");

    expect(head(lease)).toBe(origin("refs/heads/cla-1"));
    expect(row(lease)).toMatchObject({ remoteSha: head(lease), headSha: head(lease), state: "leased", holder: run });
    expect(read(lease, "a.txt")).toBe("a1\nmine\na3\n");
  });

  test("con worktree viejo hace fast-forward a lo que otro pusheó y lo guarda como remote_sha", async () => {
    pushBranch("cla-1", [{ "a.txt": "a1\nmine\na3\n" }]);
    const first = await attach("cla-1");
    workspaces.release(first);
    const moved = await advance("cla-1", { "b.txt": "b2\n" });

    const lease = await attach("cla-1");

    expect(lease.workspaceId).toBe(first.workspaceId);
    expect(lease.fastForwarded).toBe(true);
    expect(head(lease)).toBe(moved);
    expect(row(lease).remoteSha).toBe(moved);
    expect(read(lease, "b.txt")).toBe("b2\n");
  });

  test("una branch que no está en el remoto no se retoma ni deja un worktree", async () => {
    await expect(attach("cla-9")).rejects.toThrow(AttachError);

    expect(store.db.$client.prepare("SELECT count(*) AS n FROM workspaces").get()).toEqual({ n: 0 });
    expect(repo.git("branch", "--list", "cla-9")).toBe("");
  });

  test("si la local tiene commits que el remoto no (adelantada o divergida) falla y suelta el lease", async () => {
    pushBranch("cla-1", [{ "a.txt": "a1\nmine\na3\n" }]);
    const first = await attach("cla-1");
    wt(first, "commit", "--quiet", "--allow-empty", "--message", "wip: local");
    workspaces.release(first);
    await expect(attach("cla-1")).rejects.toThrow(/tiene commits que el remoto no/);
    expect(row(first).holder).toBeNull();

    await advance("cla-1", { "b.txt": "b2\n" });
    await expect(attach("cla-1")).rejects.toThrow(/divergieron/);
    expect(row(first).holder).toBeNull();
  });
});

describe("workspaces.rebase", () => {
  test("clean: queda sobre la base nueva, con la base guardada y el árbol limpio; origin/main y main son la misma", async () => {
    pushBranch("cla-1", [{ "a.txt": "a1\na2\nmine\n" }, { "c.txt": "c\n" }]);
    const lease = await attach("cla-1");
    const moved = await advance("main", { "b.txt": "b-main\n" });

    const result = await workspaces.rebase(lease, { council: false, base: "origin/main" });

    expect(result).toEqual({ outcome: "clean", baseSha: moved, head: head(lease) });
    expect(wt(lease, "merge-base", "HEAD", moved)).toBe(moved);
    expect(subjects(lease, `${moved}..HEAD`)).toEqual(["feat: cla-1 1", "feat: cla-1 2"]);
    expect(workspaces.baseSha(lease)).toBe(moved);
    expect(row(lease)).toMatchObject({ baseRef: "main", headSha: head(lease) });
    // El remote_sha sigue siendo lo último pusheado: el push con lease lo compara con eso.
    expect(row(lease).remoteSha).toBe(origin("refs/heads/cla-1"));
    expect(wt(lease, "status", "--porcelain")).toBe("");
  });

  test("las precondiciones: sin remote_sha al día, árbol sucio, rebase en curso o council lanzan sin tocar nada", async () => {
    pushBranch("cla-1", [{ "a.txt": "a1\na2\nmine\n" }]);
    const lease = await attach("cla-1");
    await advance("main", { "b.txt": "b-main\n" });
    const before = head(lease);

    await expect(workspaces.rebase(lease, { council: true })).rejects.toThrow(/council/);

    writeFileSync(join(lease.path, "dirty.txt"), "x\n");
    await expect(workspaces.rebase(lease, { council: false })).rejects.toThrow(/sin commitear/);
    rmSync(join(lease.path, "dirty.txt"));

    wt(lease, "commit", "--quiet", "--allow-empty", "--message", "wip: local");
    await expect(workspaces.rebase(lease, { council: false })).rejects.toThrow(RebaseError);
    await expect(workspaces.rebase(lease, { council: false })).rejects.toThrow(/no es lo último que se pusheó/);
    wt(lease, "reset", "--quiet", "--hard", before);

    expect(head(lease)).toBe(before);
    expect(workspaces.baseSha(lease)).not.toBe(origin("refs/heads/main"));
  });

  test("conflict deja el rebase detenido con HEAD detached; continue rechaza las marcas pendientes y termina al resolver", async () => {
    pushBranch("cla-1", [{ "a.txt": "a1\nmine\na3\n" }, { "b.txt": "b-mine\n" }]);
    const lease = await attach("cla-1");
    const moved = await advance("main", { "a.txt": "a1\nmain\na3\n", "b.txt": "b-main\n" });

    const conflict = await workspaces.rebase(lease, { council: false });

    expect(conflict).toMatchObject({ outcome: "conflict", conflicts: ["a.txt"] });
    expect(conflict.outcome === "conflict" && conflict.applying).toBe(origin("refs/heads/cla-1~1"));
    expect(() => wt(lease, "symbolic-ref", "--quiet", "HEAD")).toThrow();
    expect(read(lease, "a.txt")).toContain("<<<<<<<");
    // Nada se guarda hasta que el rebase termina.
    expect(workspaces.baseSha(lease)).not.toBe(moved);

    // El agente "resuelve" pero deja una marca (y hasta la agrega al index): no avanza.
    writeFileSync(join(lease.path, "a.txt"), "a1\n<<<<<<< HEAD\nmain\n=======\nmine\n>>>>>>> feat\na3\n");
    wt(lease, "add", "a.txt");
    const rejected = await workspaces.rebase(lease, { council: false, continue: true });
    expect(rejected).toMatchObject({ outcome: "conflict", conflicts: ["a.txt"] });
    expect(rejected.outcome === "conflict" && rejected.failures).toContain("Quedan marcas");
    expect(() => wt(lease, "symbolic-ref", "--quiet", "HEAD")).toThrow();

    // Resuelto el primer commit, el segundo choca con lo que main cambió en b.txt: commit por commit.
    writeFileSync(join(lease.path, "a.txt"), "a1\nmain+mine\na3\n");
    const second = await workspaces.rebase(lease, { council: false, continue: true });
    expect(second).toMatchObject({ outcome: "conflict", conflicts: ["b.txt"] });

    resolveAll(lease, ["b.txt"], "b-resuelto\n");
    const done = await workspaces.rebase(lease, { council: false, continue: true });

    expect(done).toEqual({ outcome: "clean", baseSha: moved, head: head(lease) });
    expect(wt(lease, "symbolic-ref", "--short", "HEAD")).toBe("cla-1");
    expect(subjects(lease, `${moved}..HEAD`)).toEqual(["feat: cla-1 1", "feat: cla-1 2"]);
    expect(read(lease, "a.txt")).toBe("a1\nmain+mine\na3\n");
    expect(workspaces.baseSha(lease)).toBe(moved);
    expect(wt(lease, "status", "--porcelain")).toBe("");
  });

  test("continue acepta un rebase que el agente terminó por su cuenta, y rechaza si no hay nada que continuar", async () => {
    pushBranch("cla-1", [{ "a.txt": "a1\nmine\na3\n" }]);
    const lease = await attach("cla-1");
    const moved = await advance("main", { "a.txt": "a1\nmain\na3\n" });
    await expect(workspaces.rebase(lease, { council: false, continue: true })).rejects.toThrow(/no hay nada que continuar/);

    await workspaces.rebase(lease, { council: false });
    resolveAll(lease, ["a.txt"]);
    wt(lease, "add", "a.txt");
    wt(lease, "-c", "core.editor=true", "rebase", "--continue");

    const done = await workspaces.rebase(lease, { council: false, continue: true });

    expect(done).toEqual({ outcome: "clean", baseSha: moved, head: head(lease) });
    expect(workspaces.baseSha(lease)).toBe(moved);
  });

  test("un rebase con más de 20 commits con conflicto se aborta y la branch queda como estaba", async () => {
    const files = (tag: string) => Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`f${i}.txt`, `${tag}${i}\n`]));
    await advance("main", files("base"), "chore: files");
    pushBranch(
      "cla-1",
      Array.from({ length: 21 }, (_, i) => ({ [`f${i}.txt`]: `mine${i}\n` })),
    );
    const lease = await attach("cla-1");
    const before = head(lease);
    await advance("main", files("main"), "chore: main changes them all");

    let result = await workspaces.rebase(lease, { council: false });
    let resolved = 0;
    while (result.outcome === "conflict") {
      resolveAll(lease, result.conflicts);
      resolved += 1;
      result = await workspaces.rebase(lease, { council: false, continue: true });
    }

    expect(resolved).toBe(21);
    expect(result).toMatchObject({ outcome: "error", failures: expect.stringContaining("20 commits con conflicto") });
    expect(head(lease)).toBe(before);
    expect(wt(lease, "symbolic-ref", "--short", "HEAD")).toBe("cla-1");
    expect(wt(lease, "status", "--porcelain")).toBe("");
  });

  test("error: un rebase que falla sin conflicto hace --abort y la branch queda igual", async () => {
    pushBranch("cla-1", [{ "a.txt": "a1\nmine\na3\n" }]);
    const lease = await attach("cla-1");
    await advance("main", { "b.txt": "b-main\n" });
    const before = head(lease);
    const hook = join(repo.dir, ".git", "hooks", "pre-rebase");
    writeFileSync(hook, "#!/bin/sh\necho 'rebase prohibido' >&2\nexit 1\n");
    chmodSync(hook, 0o755);

    const result = await workspaces.rebase(lease, { council: false });

    expect(result).toMatchObject({ outcome: "error", failures: expect.stringContaining("rebase prohibido") });
    expect(head(lease)).toBe(before);
    expect(wt(lease, "symbolic-ref", "--short", "HEAD")).toBe("cla-1");
    expect(existsSync(join(wt(lease, "rev-parse", "--absolute-git-dir"), "rebase-merge"))).toBe(false);
    expect(workspaces.baseSha(lease)).not.toBe(origin("refs/heads/main"));
  });

  describe("el PR de abajo se mergeó con squash", () => {
    /** `parent` (2 commits) y `child` encima (1 commit); main recibe el squash de `parent` y avanza. */
    function stack() {
      pushBranch("parent", [{ "p.txt": "p1\n" }, { "p.txt": "p1\np2\n", "q.txt": "q\n" }]);
      pushBranch("child", [{ "c.txt": "c\n", "p.txt": "p1\np2\nchild\n" }], "parent");
      return async () => {
        const sha = elsewhere((git) => {
          git("checkout", "--quiet", "main");
          git("merge", "--squash", "origin/parent");
          git("commit", "--quiet", "--message", "feat: parent (#1)");
          git("push", "--quiet", "origin", "main");
          return git("rev-parse", "HEAD");
        });
        await workspaces.fetch("r1");
        return sha;
      };
    }

    test("from es la última punta pusheada del padre, que tiene workspace: queda solo el commit propio", async () => {
      const squash = stack();
      await attach("parent");
      const child = await attach("child", "parent");
      const squashed = await squash();

      const result = await workspaces.rebase(child, { council: false, base: "main" });

      expect(result).toEqual({ outcome: "clean", baseSha: squashed, head: head(child) });
      expect(subjects(child, `${squashed}..HEAD`)).toEqual(["feat: child 1"]);
      expect(read(child, "p.txt")).toBe("p1\np2\nchild\n");
      expect(row(child)).toMatchObject({ baseRef: "main", baseSha: squashed });
    });

    test("sin workspace del padre, from es origin/<padre>", async () => {
      const squash = stack();
      const child = await attach("child", "parent");
      const squashed = await squash();

      const result = await workspaces.rebase(child, { council: false, base: "main" });

      expect(result).toMatchObject({ outcome: "clean", baseSha: squashed });
      expect(subjects(child, `${squashed}..HEAD`)).toEqual(["feat: child 1"]);
    });

    test("un rebase común, sin cambio de base, no pasa por from", async () => {
      stack();
      const child = await attach("child", "parent");
      const movedParent = await advance("parent", { "z.txt": "z\n" });

      const result = await workspaces.rebase(child, { council: false });

      expect(result).toMatchObject({ outcome: "clean", baseSha: movedParent });
      expect(subjects(child, `${movedParent}..HEAD`)).toEqual(["feat: child 1"]);
    });

    test("si la punta del padre ya no es ancestro del hijo, lanza en lugar de rebasear mal", async () => {
      stack();
      await attach("parent");
      const child = await attach("child", "parent");
      // Como si el padre se hubiera reescrito: lo último que pusheamos de él no está en la historia del hijo.
      const elsewhereSha = await advance("main", { "b.txt": "b-main\n" });
      store.db.$client.prepare("UPDATE workspaces SET remote_sha = ? WHERE branch = 'parent'").run(elsewhereSha);

      await expect(workspaces.rebase(child, { council: false, base: "main" })).rejects.toThrow(/no es ancestro/);
      expect(head(child)).toBe(origin("refs/heads/child"));
    });
  });
});
