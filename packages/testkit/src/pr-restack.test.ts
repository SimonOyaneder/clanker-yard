import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createArtifacts,
  createAskpass,
  createConnections,
  createDefs,
  createFileSecrets,
  createGitRemote,
  createPacks,
  createPrs,
  createRecipes,
  createSlots,
  createWorkspaces,
  newId,
  openStore,
  PermanentActionError,
  prPublishAction,
  stackRestackAction,
  stackRestackRewrittenAction,
  type ActionCtx,
  type Askpass,
  type Store,
  type Workspaces,
} from "@clanker/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tempGitRepo, type TempGitRepo } from "./git";
import { startGitHubSim, type GitHubSim } from "./github-sim";

// `stack.restack` y `stack.restackRewritten` sobre repos git reales, un remoto bare y el GitHub simulado:
// cadenas de 2 y 3 PRs con el padre squasheado (el commit del merge no es la punta de su branch) o reescrito.

vi.setConfig({ testTimeout: 30_000 });

const TOKEN = "github_pat_UNIQUE-0123456789";
const ACCOUNT = "octocat";
const REPO = "octocat/secret-project";
const BASE_FILES = { "a.txt": "a1\na2\na3\n", "b.txt": "b1\nb2\n", "c.txt": "c1\nc2\n" };

let dataDir: string;
let store: Store;
let repo: TempGitRepo;
let askpass: Askpass;
let workspaces: Workspaces;
let github: GitHubSim;
let restack: ReturnType<typeof stackRestackAction>;
let restackRewritten: ReturnType<typeof stackRestackRewrittenAction>;
let publish: ReturnType<typeof prPublishAction>;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "clanker-restack-"));
  store = openStore({ path: ":memory:" });
  repo = tempGitRepo({ remote: true, commits: [{ message: "chore: base", files: BASE_FILES }] });
  github = await startGitHubSim({ origin: repo, repo: REPO, token: TOKEN });

  askpass = createAskpass();
  const connections = createConnections(store, createFileSecrets({ dir: join(dataDir, "secrets") }), { github: { baseUrl: github.baseUrl } });
  await connections.connect({ provider: "github", account: ACCOUNT, scopes: [], token: TOKEN }, "core");
  const repos = () => ({
    path: repo.dir,
    defaultBranch: "main",
    remote: { url: `file://${repo.remoteDir}`, repo: REPO, account: ACCOUNT },
  });
  workspaces = createWorkspaces({
    store,
    dataDir,
    repoConfig: repos,
    identityOf: async () => ({ name: "Ana Pérez", email: "ana@example.com" }),
    remote: createGitRemote({ askpass, connections }),
  });
  const defs = createDefs(store);
  const packs = createPacks({ defs });
  const packDir = join(dataDir, "pack");
  mkdirSync(packDir);
  writeFileSync(
    join(packDir, "pack.json"),
    JSON.stringify({ id: "acme", version: 1, activate: { githubOrgs: ["octocat"] }, conventions: { councilPrefix: "[clanker-council] " } }),
  );
  await packs.load(packDir);
  const recipes = createRecipes({ store, defs, workspaces, artifacts: createArtifacts({ store, dir: join(dataDir, "artifacts") }), slots: createSlots({ store }) });
  const prs = createPrs({ connections, packs });
  publish = prPublishAction({ store, workspaces, recipes, repoConfig: repos, connections, packs });
  const restackDeps = { store, workspaces, repoConfig: repos, prs, connections, pause: () => Promise.resolve() };
  restack = stackRestackAction(restackDeps);
  restackRewritten = stackRestackRewrittenAction(restackDeps);
});

afterEach(async () => {
  await askpass.close();
  await github.close();
  repo.cleanup();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function ctx(): ActionCtx {
  const saved = new Map<string, unknown>();
  return {
    runId: newId("run"),
    stepId: newId("stp"),
    key: "run:restack:1",
    signal: new AbortController().signal,
    async once(stage, fn) {
      if (saved.has(stage)) return saved.get(stage) as never;
      const result = await fn();
      saved.set(stage, JSON.parse(JSON.stringify(result)));
      return result;
    },
  };
}

/** Un PR del sistema: `branch` sale de `base` con un commit que escribe `files`, publicado en draft. */
async function openPr(branch: string, base: string, files: Record<string, string>, body = ""): Promise<number> {
  const lease = await workspaces.acquire({ repo: "r1", branch, base, runId: newId("run") });
  for (const [path, content] of Object.entries(files)) writeFileSync(join(lease.path, path), content);
  const { workspaceId, path, baseSha, fencingToken } = lease;
  const published = await publish.run(
    publish.args.parse({
      ws: { workspaceId, path, branch, baseSha, fencingToken },
      plan: { commits: [{ message: `feat: ${branch}`, hunks: ["h1"], tests: [] }], pr: { title: `[${branch}] cambio`, body } },
    }),
    ctx(),
  );
  expect(published.outcome).toBe("ok");
  workspaces.release(lease);
  return (published.output as { pr: { number: number } }).pr.number;
}

/** Trabajo hecho por otro en un clon del remoto: `fn` recibe `git` sobre ese clon. */
function elsewhere<T>(fn: (git: (...args: string[]) => string, dir: string) => T): T {
  const dir = join(dataDir, `other-${Math.random().toString(36).slice(2)}`);
  repo.git("clone", "--quiet", repo.remoteDir!, dir);
  return fn((...args) => repo.git("-C", dir, ...args), dir);
}

function write(dir: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

/** `branch` mergeada a `main` con squash: un commit nuevo que no es la punta de la branch. `extra` es lo que se editó al mergear. */
function squashOnMain(branch: string, extra: Record<string, string> = {}): string {
  return elsewhere((git, dir) => {
    git("checkout", "--quiet", "main");
    git("merge", "--squash", "--quiet", `origin/${branch}`);
    write(dir, extra);
    git("add", "--all");
    git("commit", "--quiet", "--message", `feat: ${branch} (#1)`);
    git("push", "--quiet", "origin", "main");
    return git("rev-parse", "HEAD");
  });
}

const remoteSha = (branch: string) => repo.git("--git-dir", repo.remoteDir!, "rev-parse", `refs/heads/${branch}`);
const remoteLog = (range: string, format = "%s") => repo.git("--git-dir", repo.remoteDir!, "log", `--format=${format}`, range);
const sql = <T>(query: string) => store.db.$client.prepare(query).all() as T[];
const ref = (number: number) => ({ account: ACCOUNT, repo: REPO, number });
const run = (number: number) => restack.run(restack.args.parse({ pr: ref(number) }), ctx());
const runRewritten = (number: number, { from, to }: { from: string; to: string }) =>
  restackRewritten.run(restackRewritten.args.parse({ pr: ref(number), from, to }), ctx());
type Output = {
  merge: { sha: string; squash: string };
  children: { pr: { number: number }; branch: string; status: string; reason?: string; files?: string[]; commits?: number }[];
  changedDrafts: { pr: { number: number }; branch: string; base: string }[];
  mergeable: { number: number; mergeable: boolean | null }[];
};
const outputOf = (result: { output?: unknown }) => result.output as Output;

/** Otra persona reescribe `branch` en el remoto (amend con `files` y force push): su punta vieja y la nueva. */
function rewrite(branch: string, files: Record<string, string>): { from: string; to: string } {
  const from = remoteSha(branch);
  elsewhere((git, dir) => {
    git("checkout", "--quiet", branch);
    write(dir, files);
    git("add", "--all");
    git("commit", "--quiet", "--amend", "--message", `feat: ${branch} (reescrito)`);
    git("push", "--quiet", "--force", "origin", branch);
  });
  return { from, to: remoteSha(branch) };
}

/** El patch-id del commit `sha` del remoto: lo que debe conservar un commit propio al restackearse. */
const patchId = (sha: string) =>
  execFileSync("sh", ["-c", `git --git-dir=${JSON.stringify(repo.remoteDir)} show ${sha} | git patch-id --stable`], { encoding: "utf8" }).split(" ")[0];

/** Quita el worktree y el workspace de una branch: queda solo en el remoto, como la de otra persona. */
function dropWorkspace(branch: string) {
  const { path } = sql<{ path: string }>(`SELECT path FROM workspaces WHERE branch = '${branch}'`)[0]!;
  repo.git("worktree", "remove", "--force", "--force", path);
  repo.git("branch", "-D", branch);
  store.db.$client.prepare("DELETE FROM workspaces WHERE branch = ?").run(branch);
}

describe("stack.restack", () => {
  test("hijo con un merge de release-bot y padre squasheado: queda sobre la base con sus commits propios y el PR cambia de base", async () => {
    await openPr("cla-1", "main", { "a.txt": "a1\nparent\na3\n" });
    const child = await openPr("cla-2", "cla-1", { "b.txt": "b1\nchild\n" });
    // Alguien suma un commit al padre y release-bot[bot] lo mergea en el hijo.
    elsewhere((git, dir) => {
      git("checkout", "--quiet", "cla-1");
      write(dir, { "d.txt": "d\n" });
      git("add", "--all");
      git("commit", "--quiet", "--message", "fix: extra del padre");
      git("push", "--quiet", "origin", "cla-1");
      git("checkout", "--quiet", "cla-2");
      git("merge", "--no-ff", "--quiet", "--message", "Merge branch 'cla-1' into cla-2", "origin/cla-1");
      git("push", "--quiet", "origin", "cla-2");
    });
    const before = remoteSha("cla-2");
    const squash = squashOnMain("cla-1");
    github.pr(1).merge({ sha: squash });

    const result = await run(1);

    expect(result.outcome).toBe("ok");
    const output = outputOf(result);
    expect(output.merge).toEqual({ sha: squash, squash: "same" });
    expect(output.children).toMatchObject([{ pr: { number: child }, branch: "cla-2", status: "restacked", commits: 1 }]);
    expect(output.changedDrafts).toEqual([{ pr: ref(child), branch: "cla-2", base: "main" }]);
    expect(output.mergeable).toEqual([{ number: child, mergeable: true }]);
    // La punta nueva es solo su commit propio sobre el squash: sin el merge ni lo que traía del padre.
    expect(remoteSha("cla-2")).not.toBe(before);
    expect(remoteLog(`${squash}..cla-2`, "%s|%P")).toBe(`feat: cla-2|${squash}`);
    expect(repo.git("--git-dir", repo.remoteDir!, "diff", "--name-only", squash, "cla-2")).toBe("b.txt");
    expect(github.pulls().find((p) => p.number === child)?.base.ref).toBe("main");
    expect(github.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
    expect(sql(`SELECT * FROM pr_parents`)).toEqual([]);
    expect(sql(`SELECT base_ref, head_sha FROM pull_requests WHERE number = ${child}`)).toEqual([{ base_ref: "main", head_sha: remoteSha("cla-2") }]);
    // El worktree quedó en la punta nueva y suelto.
    expect(sql<{ state: string; remote_sha: string; base_ref: string }>(`SELECT state, remote_sha, base_ref FROM workspaces WHERE branch = 'cla-2'`)).toEqual([
      { state: "idle", remote_sha: remoteSha("cla-2"), base_ref: "main" },
    ]);
  });

  test("squash distinto a la branch: se avisa pero el hijo queda sobre lo que la base trae", async () => {
    await openPr("cla-1", "main", { "a.txt": "a1\nparent\na3\n" });
    const child = await openPr("cla-2", "cla-1", { "b.txt": "b1\nchild\n" });
    const squash = squashOnMain("cla-1", { "notes.txt": "editado al mergear\n" });
    github.pr(1).merge({ sha: squash });

    const result = await run(1);

    expect(outputOf(result).merge.squash).toBe("differs");
    expect(outputOf(result).children).toMatchObject([{ pr: { number: child }, status: "restacked" }]);
    expect(repo.git("--git-dir", repo.remoteDir!, "show", "cla-2:notes.txt")).toBe("editado al mergear");
    expect(remoteLog(`${squash}..cla-2`)).toBe("feat: cla-2");
  });

  test("hijo sin worktree: se crea desde la branch remota", async () => {
    await openPr("cla-1", "main", { "a.txt": "a1\nparent\na3\n" });
    const child = await openPr("cla-2", "cla-1", { "b.txt": "b1\nchild\n" });
    dropWorkspace("cla-2");
    const squash = squashOnMain("cla-1");
    github.pr(1).merge({ sha: squash });

    const result = await run(1);

    expect(outputOf(result).children).toMatchObject([{ pr: { number: child }, status: "restacked" }]);
    expect(remoteLog(`${squash}..cla-2`, "%s|%P")).toBe(`feat: cla-2|${squash}`);
    const [workspace] = sql<{ path: string; state: string }>(`SELECT path, state FROM workspaces WHERE branch = 'cla-2'`);
    expect(workspace?.state).toBe("idle");
    expect(existsSync(workspace!.path)).toBe(true);
  });

  test("conflicto: la branch queda como estaba, el hijo sigue colgando y se emite el evento para el flujo de rebase", async () => {
    await openPr("cla-1", "main", { "a.txt": "a1\nparent\na3\n" });
    const child = await openPr("cla-2", "cla-1", { "a.txt": "a1\nchild\na3\n" });
    const before = remoteSha("cla-2");
    const squash = squashOnMain("cla-1", { "a.txt": "a1\nmanual\na3\n" });
    github.pr(1).merge({ sha: squash });

    const result = await run(1);

    expect(result.outcome).toBe("conflict");
    const output = outputOf(result);
    expect(output.children).toMatchObject([{ pr: { number: child }, status: "conflict", files: ["a.txt"] }]);
    expect(output.changedDrafts).toEqual([]);
    expect(remoteSha("cla-2")).toBe(before);
    const [workspace] = sql<{ path: string; head_sha: string; base_ref: string }>(`SELECT path, head_sha, base_ref FROM workspaces WHERE branch = 'cla-2'`);
    expect(repo.git("-C", workspace!.path, "rev-parse", "HEAD")).toBe(before);
    expect(repo.git("-C", workspace!.path, "status", "--porcelain")).toBe("");
    expect(workspace?.base_ref).toBe("cla-1");
    expect(github.pulls().find((p) => p.number === child)?.base.ref).toBe("cla-1");
    expect(sql(`SELECT * FROM pr_parents`)).toHaveLength(1);
    const events = store.events.since(0, { types: ["pr.conflict"] });
    expect(events.map((e) => e.payload)).toEqual([
      { repo: REPO, number: child, sha: before, base: "main", from: expect.any(String), onto: squash, files: ["a.txt"] },
    ]);
  });

  test("un commit propio que la base ya trae cambiaría de patch-id al aplicarse: queda como conflicto sin tocar la branch", async () => {
    await openPr("cla-1", "main", { "a.txt": "a1\nparent\na3\n" });
    const child = await openPr("cla-2", "cla-1", { "b.txt": "b1\nchild\n" });
    const before = remoteSha("cla-2");
    const squash = squashOnMain("cla-1", { "b.txt": "b1\nchild\n" });
    github.pr(1).merge({ sha: squash });

    const result = await run(1);

    expect(result.outcome).toBe("conflict");
    expect(outputOf(result).children).toMatchObject([
      { pr: { number: child }, status: "conflict", files: [], failures: expect.stringContaining("otro patch-id") },
    ]);
    expect(remoteSha("cla-2")).toBe(before);
  });

  test("cadena de 3: cada nieto parte de la punta vieja de su padre y de la nueva", async () => {
    await openPr("cla-1", "main", { "a.txt": "a1\nparent\na3\n" });
    const child = await openPr("cla-2", "cla-1", { "b.txt": "b1\nchild\n" });
    const grandchild = await openPr("cla-3", "cla-2", { "c.txt": "c1\ngrandchild\n" });
    const oldChild = remoteSha("cla-2");
    const squash = squashOnMain("cla-1");
    github.pr(1).merge({ sha: squash });

    const result = await run(1);

    const output = outputOf(result);
    expect(output.children.map((c) => [c.pr.number, c.status])).toEqual([
      [child, "restacked"],
      [grandchild, "restacked"],
    ]);
    expect(output.changedDrafts).toEqual([
      { pr: ref(child), branch: "cla-2", base: "main" },
      { pr: ref(grandchild), branch: "cla-3", base: "cla-2" },
    ]);
    expect(remoteSha("cla-2")).not.toBe(oldChild);
    expect(remoteLog(`${squash}..cla-3`)).toBe("feat: cla-3\nfeat: cla-2");
    expect(remoteLog(`${remoteSha("cla-2")}..cla-3`, "%s|%P")).toBe(`feat: cla-3|${remoteSha("cla-2")}`);
    // El nieto sigue sobre la branch de su padre, que ahora cuelga de la base.
    expect(github.pulls().find((p) => p.number === grandchild)?.base.ref).toBe("cla-2");
    expect(sql(`SELECT child_id, parent_id FROM pr_parents`)).toHaveLength(1);
    expect(output.mergeable.map((m) => m.number)).toEqual([child, grandchild]);

    // Una segunda corrida no encuentra hijos del PR mergeado.
    expect(outputOf(await run(1)).children).toEqual([]);
  });

  test("un hijo con threads [clanker-council] no se fuerza y los demás siguen", async () => {
    await openPr("cla-1", "main", { "a.txt": "a1\nparent\na3\n" });
    const council = await openPr("cla-2", "cla-1", { "b.txt": "b1\nchild\n" });
    const other = await openPr("cla-3", "cla-1", { "c.txt": "c1\nother\n" });
    github.pr(council).councilThread("el nombre no calza");
    const before = remoteSha("cla-2");
    const squash = squashOnMain("cla-1");
    github.pr(1).merge({ sha: squash });

    const result = await run(1);

    expect(result.outcome).toBe("ok");
    expect(outputOf(result).children).toMatchObject([
      { pr: { number: council }, status: "skipped", reason: expect.stringContaining("council") },
      { pr: { number: other }, status: "restacked" },
    ]);
    expect(remoteSha("cla-2")).toBe(before);
  });

  test("un merge de otra branch en el hijo no se puede separar: se salta y se avisa", async () => {
    await openPr("cla-1", "main", { "a.txt": "a1\nparent\na3\n" });
    const child = await openPr("cla-2", "cla-1", { "b.txt": "b1\nchild\n" });
    elsewhere((git, dir) => {
      git("checkout", "--quiet", "-b", "otra", "main");
      write(dir, { "z.txt": "z\n" });
      git("add", "--all");
      git("commit", "--quiet", "--message", "feat: otra");
      git("checkout", "--quiet", "cla-2");
      git("merge", "--no-ff", "--quiet", "--message", "Merge branch 'otra'", "otra");
      git("push", "--quiet", "origin", "cla-2");
    });
    const before = remoteSha("cla-2");
    const squash = squashOnMain("cla-1");
    github.pr(1).merge({ sha: squash });

    const result = await run(1);

    expect(outputOf(result).children).toMatchObject([{ pr: { number: child }, status: "skipped", reason: expect.stringContaining("no está en la base") }]);
    expect(remoteSha("cla-2")).toBe(before);
    expect(sql(`SELECT * FROM pr_parents`)).toHaveLength(1);
  });

  test("si GitHub ya cambió la base del PR no la vuelve a cambiar; un cuerpo que nombra la base vieja deja una nota", async () => {
    await openPr("cla-1", "main", { "a.txt": "a1\nparent\na3\n" });
    const child = await openPr("cla-2", "cla-1", { "b.txt": "b1\nchild\n" }, "Apilado sobre cla-1");
    const squash = squashOnMain("cla-1");
    github.pr(1).merge({ sha: squash });
    // GitHub retargetea los hijos al borrarse la branch del padre.
    await fetch(`${github.baseUrl}/repos/${REPO}/pulls/${child}`, {
      method: "PATCH",
      headers: { authorization: `bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ base: "main" }),
    });
    const patches = () => github.requests.filter((r) => r.method === "PATCH").length;
    const before = patches();

    const result = await run(1);

    expect(outputOf(result).children).toMatchObject([{ status: "restacked" }]);
    expect(patches()).toBe(before);
    const notes = sql<{ kind: string; title: string; subject: string }>(`SELECT kind, title, subject FROM decisions`);
    expect(notes).toEqual([
      { kind: "review_note", title: `Descripción obsoleta en ${REPO}#${child}`, subject: expect.stringContaining('"type":"pr"') },
    ]);
  });

  test("un hijo que ya alguien dejó sobre la base solo cambia de base", async () => {
    await openPr("cla-1", "main", { "a.txt": "a1\nparent\na3\n" });
    const child = await openPr("cla-2", "cla-1", { "b.txt": "b1\nchild\n" });
    dropWorkspace("cla-2");
    const squash = squashOnMain("cla-1");
    github.pr(1).merge({ sha: squash });
    elsewhere((git) => {
      git("checkout", "--quiet", "-B", "cla-2", squash);
      git("cherry-pick", "--quiet", "origin/cla-2");
      git("push", "--quiet", "--force", "origin", "cla-2");
    });
    const rebased = remoteSha("cla-2");

    const result = await run(1);

    expect(outputOf(result).children).toMatchObject([{ pr: { number: child }, status: "uptodate" }]);
    expect(remoteSha("cla-2")).toBe(rebased);
    expect(github.pulls().find((p) => p.number === child)?.base.ref).toBe("main");
    expect(outputOf(result).changedDrafts).toEqual([]);
    expect(sql(`SELECT * FROM pr_parents`)).toEqual([]);
  });

  test("un PR sin mergear no se restackea", async () => {
    await openPr("cla-1", "main", { "a.txt": "a1\nparent\na3\n" });
    await openPr("cla-2", "cla-1", { "b.txt": "b1\nchild\n" });

    await expect(run(1)).rejects.toThrow(PermanentActionError);
    await expect(run(1)).rejects.toThrow(/no está mergeado/);
  });

  test("un PR mergeado que no tiene hijos no hace nada", async () => {
    await openPr("cla-1", "main", { "a.txt": "a1\nparent\na3\n" });
    github.pr(1).merge({ sha: squashOnMain("cla-1") });

    const result = await run(1);

    expect(result.outcome).toBe("ok");
    expect(outputOf(result).children).toEqual([]);
  });
});

describe("stack.restackRewritten", () => {
  test("padre reescrito: el hijo queda sobre la nueva punta con el mismo patch-id y sigue colgando de él", async () => {
    await openPr("cla-1", "main", { "a.txt": "a1\nparent\na3\n" });
    const child = await openPr("cla-2", "cla-1", { "b.txt": "b1\nchild\n" });
    const before = remoteSha("cla-2");
    const rewritten = rewrite("cla-1", { "a.txt": "a1\nparent v2\na3\n" });
    const patches = () => github.requests.filter((r) => r.method === "PATCH").length;
    const patchesBefore = patches();

    const result = await runRewritten(1, rewritten);

    expect(result.outcome).toBe("ok");
    const output = outputOf(result);
    expect(output.children).toMatchObject([{ pr: { number: child }, branch: "cla-2", status: "restacked", commits: 1 }]);
    expect(output.changedDrafts).toEqual([{ pr: ref(child), branch: "cla-2", base: "cla-1" }]);
    expect(output.mergeable).toEqual([{ number: 1, mergeable: true }, { number: child, mergeable: true }]);
    // Un solo commit propio, directo sobre la punta nueva del padre y con el patch-id de antes.
    expect(remoteLog(`${rewritten.to}..cla-2`, "%s|%P")).toBe(`feat: cla-2|${rewritten.to}`);
    expect(patchId(remoteSha("cla-2"))).toBe(patchId(before));
    // Su base no cambia: sigue colgando de la branch del padre.
    expect(github.pulls().find((p) => p.number === child)?.base.ref).toBe("cla-1");
    expect(patches()).toBe(patchesBefore);
    expect(sql(`SELECT * FROM pr_parents`)).toHaveLength(1);
    expect(sql(`SELECT base_ref, head_sha FROM pull_requests WHERE number = ${child}`)).toEqual([{ base_ref: "cla-1", head_sha: remoteSha("cla-2") }]);
    expect(sql<{ state: string; remote_sha: string; base_ref: string }>(`SELECT state, remote_sha, base_ref FROM workspaces WHERE branch = 'cla-2'`)).toEqual([
      { state: "idle", remote_sha: remoteSha("cla-2"), base_ref: "cla-1" },
    ]);
  });

  test("cadena de 3: el nieto parte de la punta vieja de su padre y de la nueva", async () => {
    await openPr("cla-1", "main", { "a.txt": "a1\nparent\na3\n" });
    const child = await openPr("cla-2", "cla-1", { "b.txt": "b1\nchild\n" });
    const grandchild = await openPr("cla-3", "cla-2", { "c.txt": "c1\ngrandchild\n" });
    const [oldChild, oldGrandchild] = [remoteSha("cla-2"), remoteSha("cla-3")];
    const rewritten = rewrite("cla-1", { "a.txt": "a1\nparent v2\na3\n" });

    const output = outputOf(await runRewritten(1, rewritten));

    expect(output.children.map((c) => [c.pr.number, c.status])).toEqual([
      [child, "restacked"],
      [grandchild, "restacked"],
    ]);
    expect(remoteLog(`${rewritten.to}..cla-3`)).toBe("feat: cla-3\nfeat: cla-2");
    expect(remoteLog(`${remoteSha("cla-2")}..cla-3`, "%s|%P")).toBe(`feat: cla-3|${remoteSha("cla-2")}`);
    expect(patchId(remoteSha("cla-2"))).toBe(patchId(oldChild));
    expect(patchId(remoteSha("cla-3"))).toBe(patchId(oldGrandchild));
    expect(github.pulls().find((p) => p.number === grandchild)?.base.ref).toBe("cla-2");
    expect(sql(`SELECT * FROM pr_parents`)).toHaveLength(2);
  });

  test("repetirlo no cambia nada: el hijo ya está sobre la punta nueva", async () => {
    await openPr("cla-1", "main", { "a.txt": "a1\nparent\na3\n" });
    const child = await openPr("cla-2", "cla-1", { "b.txt": "b1\nchild\n" });
    const rewritten = rewrite("cla-1", { "a.txt": "a1\nparent v2\na3\n" });
    await runRewritten(1, rewritten);
    const restacked = remoteSha("cla-2");

    const again = await runRewritten(1, rewritten);

    expect(outputOf(again).children).toMatchObject([{ pr: { number: child }, status: "uptodate" }]);
    expect(outputOf(again).changedDrafts).toEqual([]);
    expect(remoteSha("cla-2")).toBe(restacked);
  });

  test("conflicto: la branch del hijo queda como estaba y se emite el evento para el flujo de rebase", async () => {
    await openPr("cla-1", "main", { "a.txt": "a1\nparent\na3\n" });
    const child = await openPr("cla-2", "cla-1", { "a.txt": "a1\nparent\nchild\n" });
    const before = remoteSha("cla-2");
    const rewritten = rewrite("cla-1", { "a.txt": "a1\nparent v2\na3 v2\n" });

    const result = await runRewritten(1, rewritten);

    expect(result.outcome).toBe("conflict");
    expect(outputOf(result).children).toMatchObject([{ pr: { number: child }, status: "conflict", files: ["a.txt"] }]);
    expect(remoteSha("cla-2")).toBe(before);
    expect(store.events.since(0, { types: ["pr.conflict"] }).map((e) => e.payload)).toEqual([
      { repo: REPO, number: child, sha: before, base: "cla-1", from: rewritten.from, onto: rewritten.to, files: ["a.txt"] },
    ]);
  });

  test("los hijos de un hijo que quedó en conflicto se restackean cuando alguien lo resuelve y pushea", async () => {
    await openPr("cla-1", "main", { "a.txt": "a1\nparent\na3\n" });
    const child = await openPr("cla-2", "cla-1", { "a.txt": "a1\nchild\na3\n" });
    const grandchild = await openPr("cla-3", "cla-2", { "c.txt": "c1\ngrandchild\n" });
    const [oldChild, oldGrandchild] = [remoteSha("cla-2"), remoteSha("cla-3")];
    const squash = squashOnMain("cla-1", { "a.txt": "a1\nmanual\na3\n" });
    github.pr(1).merge({ sha: squash });
    const stuck = await run(1);
    expect(outputOf(stuck).children).toMatchObject([{ pr: { number: child }, status: "conflict" }]);
    expect(remoteSha("cla-3")).toBe(oldGrandchild);

    // Lo que hace el flujo de rebase: el hijo queda sobre la base con el conflicto resuelto.
    elsewhere((git, dir) => {
      git("checkout", "--quiet", "-B", "cla-2", squash);
      write(dir, { "a.txt": "a1\nmanual y child\na3\n" });
      git("add", "--all");
      git("commit", "--quiet", "--message", "feat: cla-2");
      git("push", "--quiet", "--force", "origin", "cla-2");
    });
    const rebased = { from: oldChild, to: remoteSha("cla-2") };

    const result = await runRewritten(child, rebased);

    expect(result.outcome).toBe("ok");
    expect(outputOf(result).children).toMatchObject([{ pr: { number: grandchild }, status: "restacked", commits: 1 }]);
    expect(remoteLog(`${rebased.to}..cla-3`, "%s|%P")).toBe(`feat: cla-3|${rebased.to}`);
    expect(patchId(remoteSha("cla-3"))).toBe(patchId(oldGrandchild));
    expect(github.pulls().find((p) => p.number === grandchild)?.base.ref).toBe("cla-2");
  });

  test("un PR sin hijos no hace nada, ni siquiera fetch", async () => {
    await openPr("cla-1", "main", { "a.txt": "a1\nparent\na3\n" });
    const rewritten = rewrite("cla-1", { "a.txt": "a1\nparent v2\na3\n" });
    const requests = github.requests.length;

    const result = await runRewritten(1, rewritten);

    expect(result.outcome).toBe("ok");
    expect(outputOf(result).children).toEqual([]);
    expect(github.requests.length).toBe(requests);
  });

  test("un PR que ya se mergeó no restackea a sus hijos sobre su branch reescrita", async () => {
    await openPr("cla-1", "main", { "a.txt": "a1\nparent\na3\n" });
    await openPr("cla-2", "cla-1", { "b.txt": "b1\nchild\n" });
    const rewritten = rewrite("cla-1", { "a.txt": "a1\nparent v2\na3\n" });
    github.pr(1).merge({ sha: squashOnMain("cla-1") });

    await expect(runRewritten(1, rewritten)).rejects.toThrow(PermanentActionError);
    await expect(runRewritten(1, rewritten)).rejects.toThrow(/ya está mergeado/);
  });

  test("una punta vieja que no está en el repo local no se puede restackear", async () => {
    await openPr("cla-1", "main", { "a.txt": "a1\nparent\na3\n" });
    await openPr("cla-2", "cla-1", { "b.txt": "b1\nchild\n" });
    const { to } = rewrite("cla-1", { "a.txt": "a1\nparent v2\na3\n" });

    await expect(runRewritten(1, { from: "0".repeat(40), to })).rejects.toThrow(PermanentActionError);
    await expect(runRewritten(1, { from: "0".repeat(40), to })).rejects.toThrow(/no está en el repo local/);
  });
});
