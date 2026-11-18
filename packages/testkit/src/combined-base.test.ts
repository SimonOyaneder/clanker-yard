import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FlowDef, NewProject, type CachedIssue } from "@clanker/api";
import {
  combinedBaseBranch,
  createArtifacts,
  createAskpass,
  createConnections,
  createDefs,
  createFileSecrets,
  createGitRemote,
  createIssues,
  createLocalTracker,
  createPacks,
  createPrs,
  createProjects,
  createRecipes,
  createSlots,
  createWorkspaces,
  newId,
  openStore,
  prPublishAction,
  stackRestackAction,
  workspaceCombinedBaseMergeAction,
  type ActionCtx,
  type Askpass,
  type Store,
  type Workspaces,
} from "@clanker/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tempGitRepo, type TempGitRepo } from "./git";
import { startGitHubSim, type GitHubSim } from "./github-sim";

// Las bases combinadas (`docs/design.html#d-ops`, "Bases combinadas"): `workspaces.combineBase`, publicar el PR
// sobre el primer padre y `stack.restack` recalculando la base cuando se mergea un padre. Repos git reales, un
// remoto bare y el GitHub simulado.

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
let publish: ReturnType<typeof prPublishAction>;
let issues: ReturnType<typeof createIssues>;
let projectId: CachedIssue["projectId"];
let combinedMerge: ReturnType<typeof workspaceCombinedBaseMergeAction>;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "clanker-combined-"));
  store = openStore({ path: ":memory:" });
  repo = tempGitRepo({ remote: true, commits: [{ message: "chore: base", files: BASE_FILES }] });
  github = await startGitHubSim({ origin: repo, repo: REPO, token: TOKEN });

  askpass = createAskpass();
  const connections = createConnections({ store, secrets: createFileSecrets({ dir: join(dataDir, "secrets") }), github: { baseUrl: github.baseUrl } });
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
  const defs = createDefs({ store });
  const packs = createPacks({ defs });
  const recipes = createRecipes({ store, defs, workspaces, artifacts: createArtifacts({ store, dir: join(dataDir, "artifacts") }), slots: createSlots({ store }) });
  publish = prPublishAction({ store, workspaces, recipes, repoConfig: repos, connections, packs });
  combinedMerge = workspaceCombinedBaseMergeAction({ store, workspaces, repoConfig: repos });
  restack = stackRestackAction({ store, workspaces, repoConfig: repos, prs: createPrs({ connections, packs }), connections, pause: () => Promise.resolve() });

  issues = createIssues({ store, local: createLocalTracker({ store }) });
  projectId = createProjects({ store, defs }).create(NewProject.parse({ slug: "demo", name: "Demo", tracker: "local" }), "cli").id;
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

const newIssue = (title = "Con dos padres") => issues.createLocal({ projectId, title }, "cli");

/** Un PR del sistema: `branch` sale de `base` con un commit que escribe `files`, publicado en draft (`beforePublish` corre justo antes). */
async function openPr(branch: string, base: string, files: Record<string, string>, issue?: CachedIssue, beforePublish?: () => void): Promise<{ number: number; body: string }> {
  const published = await publishPr(branch, base, files, beforePublish);
  expect(published.outcome).toBe("ok");
  const number = (published.output as { pr: { number: number } }).pr.number;
  // Sin una corrida que lo abra (`recordPull` toma el sujeto de ella), la issue del PR se fija a mano.
  if (issue) store.db.$client.prepare("UPDATE pull_requests SET issue_id = ? WHERE number = ?").run(issue.id, number);
  return { number, body: github.pulls().find((p) => p.number === number)?.body ?? "" };
}

async function publishPr(branch: string, base: string, files: Record<string, string>, beforePublish?: () => void, actionCtx = ctx()) {
  const lease = await workspaces.acquire({ repo: "repo_r1", branch, base, runId: actionCtx.runId });
  for (const [path, content] of Object.entries(files)) writeFileSync(join(lease.path, path), content);
  // Lo que pasa en GitHub mientras la corrida trabaja, antes de que publique.
  beforePublish?.();
  const { workspaceId, path, baseSha, fencingToken } = lease;
  const published = await publish.run(
    publish.args.parse({
      ws: { workspaceId, path, branch, baseSha, fencingToken },
      plan: { commits: [{ message: `feat: ${branch}`, hunks: ["h1"], tests: [] }], pr: { title: `[${branch}] cambio`, body: "Cambia cosas." } },
    }),
    actionCtx,
  );
  workspaces.release(lease);
  return published;
}

function elsewhere<T>(fn: (git: (...args: string[]) => string, dir: string) => T): T {
  const dir = join(dataDir, `other-${Math.random().toString(36).slice(2)}`);
  repo.git("clone", "--quiet", repo.remoteDir!, dir);
  return fn((...args) => repo.git("-C", dir, ...args), dir);
}

/** `branch` mergeada a `main` con squash: un commit nuevo que no es la punta de la branch. */
function squashOnMain(branch: string): string {
  return elsewhere((git) => {
    git("checkout", "--quiet", "main");
    git("merge", "--squash", "--quiet", `origin/${branch}`);
    git("add", "--all");
    git("commit", "--quiet", "--message", `feat: ${branch} (#1)`);
    git("push", "--quiet", "origin", "main");
    return git("rev-parse", "HEAD");
  });
}

const git = (...args: string[]) => repo.git(...args);
const remoteSha = (branch: string) => repo.git("--git-dir", repo.remoteDir!, "rev-parse", `refs/heads/${branch}`);
const remoteLog = (range: string, format = "%s") => repo.git("--git-dir", repo.remoteDir!, "log", `--format=${format}`, range);
const sql = <T>(query: string) => store.db.$client.prepare(query).all() as T[];
const row = (branch: string) => sql<{ status: string; head_sha: string | null; parents: string }>(`SELECT status, head_sha, parents FROM combined_bases WHERE branch = '${branch}'`)[0];
const parentsOf = (branch: string) => (JSON.parse(row(branch)!.parents) as { key: string; branch: string; sha: string }[]).map((p) => p.branch);
const localRef = (branch: string) => repo.git("rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);

/** Dos padres abiertos en ramas distintas (`cla-1` toca a.txt, `cla-2` toca b.txt) y la issue que los combina. */
async function twoParents() {
  const one = await openPr("cla-1", "main", { "a.txt": "a1\nuno\na3\n" });
  const two = await openPr("cla-2", "main", { "b.txt": "b1\ndos\n" });
  const issue = await newIssue();
  const branch = combinedBaseBranch(issue.ref.key);
  const parents = [
    { key: "r1#1", branch: "cla-1" },
    { key: "r1#2", branch: "cla-2" },
  ];
  return { one, two, issue, branch, parents };
}

describe("workspaces.combineBase", () => {
  test("junta dos padres con un merge --no-ff de cada uno sobre la branch por defecto, y no pushea nada", async () => {
    const { issue, branch, parents } = await twoParents();

    const result = await workspaces.combineBase({ repo: "repo_r1", issueId: issue.id, branch, parents });

    expect(result).toMatchObject({ outcome: "combined", branch });
    const head = localRef(branch);
    expect(result).toMatchObject({ head });
    // Parte de `main`, con un merge de cada padre en orden.
    expect(git("log", "--first-parent", "--format=%s", `main..${branch}`)).toBe(`Merge branch 'cla-2' into ${branch}\nMerge branch 'cla-1' into ${branch}`);
    expect(git("rev-parse", `${branch}~2`)).toBe(git("rev-parse", "main"));
    expect(git("rev-parse", `${branch}^2`)).toBe(remoteSha("cla-2"));
    expect(git("rev-parse", `${branch}~1^2`)).toBe(remoteSha("cla-1"));
    expect(git("show", `${branch}:a.txt`)).toBe("a1\nuno\na3");
    expect(git("show", `${branch}:b.txt`)).toBe("b1\ndos");
    // Se registra con la punta de cada padre y no viaja al remoto: sus merges van en la branch de la issue.
    expect(row(branch)).toMatchObject({ status: "active", head_sha: head });
    expect(JSON.parse(row(branch)!.parents)).toEqual([
      { key: "r1#1", branch: "cla-1", sha: remoteSha("cla-1") },
      { key: "r1#2", branch: "cla-2", sha: remoteSha("cla-2") },
    ]);
    expect(() => remoteSha(branch)).toThrow();
    // Rehacerla con los mismos padres da el mismo commit.
    await workspaces.combineBase({ repo: "repo_r1", issueId: issue.id, branch, parents });
    expect(localRef(branch)).toBe(head);
  });

  test("padres que chocan: no crea la base, la deja en conflicto y solo avisa la primera vez", async () => {
    await openPr("cla-1", "main", { "a.txt": "a1\nuno\na3\n" });
    await openPr("cla-2", "main", { "a.txt": "a1\ndos\na3\n" });
    const issue = await newIssue();
    const branch = combinedBaseBranch(issue.ref.key);
    const parents = [
      { key: "r1#1", branch: "cla-1" },
      { key: "r1#2", branch: "cla-2" },
    ];

    const first = await workspaces.combineBase({ repo: "repo_r1", issueId: issue.id, branch, parents });
    const again = await workspaces.combineBase({ repo: "repo_r1", issueId: issue.id, branch, parents });

    expect(first).toMatchObject({ outcome: "base-conflict", parent: "r1#2", merged: ["r1#1"], files: ["a.txt"], changed: true });
    expect(again).toMatchObject({ outcome: "base-conflict", changed: false });
    expect(() => localRef(branch)).toThrow();
    expect(row(branch)).toMatchObject({ status: "conflict", head_sha: null });
  });

  test("padres que chocan: el flujo enseña la resolución, la base queda registrada y rerere la reaplica aunque un padre se mueva", async () => {
    await openPr("cla-1", "main", { "a.txt": "a1\nuno\na3\n" });
    await openPr("cla-2", "main", { "a.txt": "a1\ndos\na3\n" });
    const issue = await newIssue();
    const branch = combinedBaseBranch(issue.ref.key);
    const parents = [
      { key: "r1#1", branch: "cla-1" },
      { key: "r1#2", branch: "cla-2" },
    ];
    expect(await workspaces.combineBase({ repo: "repo_r1", issueId: issue.id, branch, parents })).toMatchObject({ outcome: "base-conflict" });

    // Lo que hace `base-combinada-conflicto`: un worktree propio, el merge real, el dev resuelve y el core sigue.
    const lease = await workspaces.acquire({ repo: "repo_r1", branch: branch.replace("clanker/base/", "clanker/resolve/"), base: "main", runId: newId("run") });
    const { workspaceId, path, baseSha, fencingToken } = lease;
    const ws = { workspaceId, path, branch: lease.branch, baseSha, fencingToken };
    const first = await combinedMerge.run(combinedMerge.args.parse({ ws, base: branch }), ctx());
    expect(first).toMatchObject({ outcome: "conflict", output: { conflicts: ["a.txt"] } });
    writeFileSync(join(path, "a.txt"), "a1\nuno\ndos\na3\n");
    const done = await combinedMerge.run(combinedMerge.args.parse({ ws, base: branch, continue: true }), ctx());
    workspaces.release(lease);

    expect(done).toMatchObject({ outcome: "clean" });
    const head = (done.output as { head: string }).head;
    expect(row(branch)).toMatchObject({ status: "active", head_sha: head });
    expect(localRef(branch)).toBe(head);
    expect(repo.git("show", `${head}:a.txt`)).toBe("a1\nuno\ndos\na3");
    // Rearmarla da la misma base, sin el agente.
    await workspaces.combineBase({ repo: "repo_r1", issueId: issue.id, branch, parents });
    expect(localRef(branch)).toBe(head);

    // Un padre se mueve con algo que no choca: `rerere` reaplica la misma resolución y la base se rearma sola.
    elsewhere((g, dir) => {
      g("checkout", "--quiet", "cla-2");
      writeFileSync(join(dir, "c.txt"), "c1\notro\n");
      g("commit", "--quiet", "--all", "--message", "feat: c en cla-2");
      g("push", "--quiet", "origin", "cla-2");
    });
    const moved = await workspaces.combineBase({ repo: "repo_r1", issueId: issue.id, branch, parents });

    expect(moved).toMatchObject({ outcome: "combined" });
    expect(repo.git("show", `${localRef(branch)}:a.txt`)).toBe("a1\nuno\ndos\na3");
    expect(repo.git("show", `${localRef(branch)}:c.txt`)).toBe("c1\notro");
  });

  test("dissolveBase borra la branch sintética y la marca disuelta", async () => {
    const { issue, branch, parents } = await twoParents();
    await workspaces.combineBase({ repo: "repo_r1", issueId: issue.id, branch, parents });

    await workspaces.dissolveBase("repo_r1", branch);
    await workspaces.dissolveBase("repo_r1", branch);

    expect(() => localRef(branch)).toThrow();
    expect(row(branch)?.status).toBe("dissolved");
  });
});

describe("pr.publish sobre una base combinada", () => {
  test("el PR apunta al primer padre, el cuerpo lo explica al principio y cuelga de todos", async () => {
    const { issue, branch, parents } = await twoParents();
    const combined = await workspaces.combineBase({ repo: "repo_r1", issueId: issue.id, branch, parents });
    expect(combined.outcome).toBe("combined");

    const child = await openPr("cla-3", branch, { "c.txt": "c1\ntres\n" }, issue);

    const pull = github.pulls().find((p) => p.number === child.number)!;
    expect(pull.base.ref).toBe("cla-1");
    expect(pull.body).toMatch(/^Base combinada: este PR apunta a `cla-1` \(r1#1\) pero también trae los commits de r1#2 \(`cla-2`\)\./);
    expect(pull.body).toContain("Cambia cosas.");
    expect(sql(`SELECT parent.number AS parent FROM pr_parents JOIN pull_requests parent ON parent.id = parent_id ORDER BY parent.number`)).toEqual([{ parent: 1 }, { parent: 2 }]);
    expect(sql(`SELECT base_ref FROM pull_requests WHERE number = ${child.number}`)).toEqual([{ base_ref: "cla-1" }]);
    // La branch de la issue trae los merges y su commit propio encima; el commit de verify solo ve lo propio.
    expect(remoteLog(`${localRef(branch)}..cla-3`)).toBe("feat: cla-3");
    expect(repo.git("--git-dir", repo.remoteDir!, "diff", "--name-only", localRef(branch), "cla-3")).toBe("c.txt");
  });
});

describe("pr.publish con un padre que se mergeó antes de publicar", () => {
  /** El PR `number` mergeado a `main` con squash, como lo haría GitHub, antes de que el hijo publique. */
  const mergeParent = (branch: string, number: number) => () => void github.pr(number).merge({ sha: squashOnMain(branch) });
  const prBase = (number: number) => github.pulls().find((p) => p.number === number)?.base.ref;

  test("un PR apilado sobre un padre ya mergeado se rehace sobre la branch por defecto y no cuelga de nadie", async () => {
    await openPr("cla-1", "main", { "a.txt": "a1\nuno\na3\n" });
    const mainBefore = git("rev-parse", "main");

    const child = await openPr("cla-2", "cla-1", { "b.txt": "b1\ndos\n" }, undefined, mergeParent("cla-1", 1));

    expect(prBase(child.number)).toBe("main");
    // La branch publicada trae solo su commit propio sobre el squash del padre, sin los commits del padre.
    const squash = git("--git-dir", repo.remoteDir!, "rev-parse", "refs/heads/main");
    expect(squash).not.toBe(mainBefore);
    expect(remoteLog(`${squash}..cla-2`, "%s|%P")).toBe(`feat: cla-2|${squash}`);
    expect(sql(`SELECT * FROM pr_parents`)).toEqual([]);
    expect(sql(`SELECT base_ref, remote_sha FROM workspaces WHERE branch = 'cla-2'`)).toEqual([{ base_ref: "main", remote_sha: remoteSha("cla-2") }]);
    expect(sql(`SELECT * FROM decisions`)).toEqual([]);
  });

  test("con una base combinada, un padre mergeado sale de la base y el PR apunta al que queda", async () => {
    const { issue, branch, parents } = await twoParents();
    await workspaces.combineBase({ repo: "repo_r1", issueId: issue.id, branch, parents });

    const child = await openPr("cla-3", branch, { "c.txt": "c1\ntres\n" }, issue, mergeParent("cla-1", 1));

    expect(prBase(child.number)).toBe("cla-2");
    expect(parentsOf(branch)).toEqual(["cla-2"]);
    const { head_sha: head, status } = row(branch)!;
    expect(status).toBe("active");
    expect(localRef(branch)).toBe(head);
    expect(remoteLog(`${head}..cla-3`, "%s|%P")).toBe(`feat: cla-3|${head}`);
    expect(sql(`SELECT parent.number AS parent FROM pr_parents JOIN pull_requests parent ON parent.id = parent_id`)).toEqual([{ parent: 2 }]);
    expect(sql(`SELECT base_ref FROM workspaces WHERE branch = 'cla-3'`)).toEqual([{ base_ref: branch }]);
    // El cuerpo no promete una base combinada con un solo padre.
    expect(github.pulls().find((p) => p.number === child.number)?.body).not.toContain("Base combinada");
  });

  test("con una base combinada y todos los padres mergeados, la base se disuelve y el PR sale sobre la branch por defecto", async () => {
    const { issue, branch, parents } = await twoParents();
    await workspaces.combineBase({ repo: "repo_r1", issueId: issue.id, branch, parents });

    const child = await openPr("cla-3", branch, { "c.txt": "c1\ntres\n" }, issue, () => {
      mergeParent("cla-1", 1)();
      mergeParent("cla-2", 2)();
    });

    expect(prBase(child.number)).toBe("main");
    expect(row(branch)?.status).toBe("dissolved");
    expect(() => localRef(branch)).toThrow();
    const main = git("--git-dir", repo.remoteDir!, "rev-parse", "refs/heads/main");
    expect(remoteLog(`${main}..cla-3`, "%s|%P")).toBe(`feat: cla-3|${main}`);
    expect(sql(`SELECT * FROM pr_parents`)).toEqual([]);
    expect(sql(`SELECT base_ref FROM workspaces WHERE branch = 'cla-3'`)).toEqual([{ base_ref: "main" }]);
  });

  test("si sus commits no caben sobre la base nueva, nada se pierde: el PR sale sobre la branch por defecto y queda una nota", async () => {
    await openPr("cla-1", "main", { "a.txt": "a1\nuno\na3\n" });
    const merge = () => {
      // `main` cambió la misma línea que el hijo toca sobre el padre.
      elsewhere((g, dir) => {
        g("checkout", "--quiet", "main");
        writeFileSync(join(dir, "a.txt"), "a1\notro\na3\n");
        g("commit", "--quiet", "--all", "--message", "fix: a");
        g("push", "--quiet", "origin", "main");
      });
      github.pr(1).merge({ sha: git("--git-dir", repo.remoteDir!, "rev-parse", "refs/heads/main") });
    };

    const child = await openPr("cla-2", "cla-1", { "a.txt": "a1\nuno\nhijo\n" }, undefined, merge);

    expect(prBase(child.number)).toBe("main");
    // La branch se publicó tal cual: con la historia del padre y su commit encima.
    expect(remoteLog(`main..cla-2`)).toBe("feat: cla-2\nfeat: cla-1");
    expect(sql(`SELECT kind, title FROM decisions`)).toEqual([{ kind: "note", title: expect.stringContaining("cla-2") }]);
  });
});

describe("pr.publish con stackMode local y padres remotos", () => {
  function localProjectCtx(issue: CachedIssue): ActionCtx {
    const defs = createDefs({ store });
    createProjects({ store, defs }).update(projectId, { stackMode: "local" }, "cli");
    defs.register("flow", FlowDef);
    const flow = defs.save({
      kind: "flow", slug: "publish-local", scope: "user", source: "cli",
      body: {
        schema: 1, id: "publish-local", name: "Publicar local", trigger: { type: "manual" }, start: "publish",
        nodes: { publish: { type: "action", action: "pr.publish", args: {}, on: { ok: "@done", local: "@done" } } },
      },
    });
    const actionCtx = ctx();
    store.db.$client.prepare(
      `INSERT INTO runs (id, project_id, subject_type, subject_id, flow_def_id, flow_version, roles, lane, status, writes, params, rounds, started_at)
       VALUES (?, ?, 'issue', ?, ?, ?, '{}', 'dev', 'running', 1, '{}', '{}', 0)`,
    ).run(actionCtx.runId, projectId, issue.id, flow.id, flow.version);
    return actionCtx;
  }

  test("con dos padres abiertos guarda el hijo local con todos sus padres, sin push ni POST pulls", async () => {
    const { issue, branch, parents } = await twoParents();
    await workspaces.combineBase({ repo: "repo_r1", issueId: issue.id, branch, parents });
    const actionCtx = localProjectCtx(issue);
    const push = vi.spyOn(workspaces, "push");
    const requestsBefore = github.requests.length;

    const result = await publishPr("cla-3", branch, { "c.txt": "c1\ntres\n" }, undefined, actionCtx);

    expect(result).toEqual({ outcome: "local", output: { prId: expect.any(String), branch: "cla-3", base: "cla-1", head: localRef("cla-3") } });
    expect(sql(`SELECT state, number, node_id, base_ref, head_sha, issue_id, run_id FROM pull_requests WHERE head_ref = 'cla-3'`)).toEqual([
      { state: "local", number: null, node_id: null, base_ref: "cla-1", head_sha: localRef("cla-3"), issue_id: issue.id, run_id: actionCtx.runId },
    ]);
    expect(sql(`SELECT parent.number AS parent FROM pr_parents JOIN pull_requests parent ON parent.id = parent_id ORDER BY parent.number`)).toEqual([{ parent: 1 }, { parent: 2 }]);
    expect(push).not.toHaveBeenCalled();
    expect(() => remoteSha("cla-3")).toThrow();
    expect(github.requests.slice(requestsBefore).filter((r) => r.method === "POST" && r.path === `/repos/${REPO}/pulls`)).toEqual([]);
    expect(sql(`SELECT remote_sha FROM workspaces WHERE branch = 'cla-3'`)).toEqual([{ remote_sha: null }]);
  });

  test("si se mergea un padre combinado antes de publicar, guarda el hijo local con el padre restante", async () => {
    const { issue, branch, parents } = await twoParents();
    await workspaces.combineBase({ repo: "repo_r1", issueId: issue.id, branch, parents });
    const actionCtx = localProjectCtx(issue);
    const push = vi.spyOn(workspaces, "push");
    const requestsBefore = github.requests.length;

    const result = await publishPr("cla-3", branch, { "c.txt": "c1\ntres\n" }, () => {
      github.pr(1).merge({ sha: squashOnMain("cla-1") });
    }, actionCtx);

    expect(result).toMatchObject({ outcome: "local", output: { branch: "cla-3", base: "cla-2", head: localRef("cla-3") } });
    expect(parentsOf(branch)).toEqual(["cla-2"]);
    expect(git("log", "--format=%s|%P", `${row(branch)!.head_sha}..cla-3`)).toBe(`feat: cla-3|${row(branch)!.head_sha}`);
    expect(sql(`SELECT state, number, base_ref FROM pull_requests WHERE head_ref = 'cla-3'`)).toEqual([{ state: "local", number: null, base_ref: "cla-2" }]);
    expect(sql(`SELECT parent.number AS parent FROM pr_parents JOIN pull_requests parent ON parent.id = parent_id`)).toEqual([{ parent: 2 }]);
    expect(push).not.toHaveBeenCalled();
    expect(() => remoteSha("cla-3")).toThrow();
    expect(github.requests.slice(requestsBefore).filter((r) => r.method === "POST" && r.path === `/repos/${REPO}/pulls`)).toEqual([]);
  });

  test("si se mergean todos los padres combinados antes de publicar, publica remoto sobre main", async () => {
    const { issue, branch, parents } = await twoParents();
    await workspaces.combineBase({ repo: "repo_r1", issueId: issue.id, branch, parents });
    const actionCtx = localProjectCtx(issue);
    const push = vi.spyOn(workspaces, "push");
    const requestsBefore = github.requests.length;

    const result = await publishPr("cla-3", branch, { "c.txt": "c1\ntres\n" }, () => {
      github.pr(1).merge({ sha: squashOnMain("cla-1") });
      github.pr(2).merge({ sha: squashOnMain("cla-2") });
    }, actionCtx);

    expect(result).toMatchObject({ outcome: "ok", output: { pr: { number: 3 }, head: remoteSha("cla-3") } });
    expect(github.pulls().find((p) => p.number === 3)?.base.ref).toBe("main");
    expect(row(branch)?.status).toBe("dissolved");
    expect(() => localRef(branch)).toThrow();
    expect(remoteLog(`${remoteSha("main")}..cla-3`, "%s|%P")).toBe(`feat: cla-3|${remoteSha("main")}`);
    expect(sql(`SELECT state, number, base_ref FROM pull_requests WHERE head_ref = 'cla-3'`)).toEqual([{ state: "open", number: 3, base_ref: "main" }]);
    expect(sql(`SELECT * FROM pr_parents`)).toEqual([]);
    expect(push).toHaveBeenCalledOnce();
    expect(github.requests.slice(requestsBefore).filter((r) => r.method === "POST" && r.path === `/repos/${REPO}/pulls`)).toHaveLength(1);
  });

  test("si se mergea el único padre apilado antes de publicar, publica remoto sobre main", async () => {
    await openPr("cla-1", "main", { "a.txt": "a1\nuno\na3\n" });
    const actionCtx = localProjectCtx(await newIssue("Con un padre"));
    const push = vi.spyOn(workspaces, "push");
    const requestsBefore = github.requests.length;

    const result = await publishPr("cla-2", "cla-1", { "b.txt": "b1\ndos\n" }, () => {
      github.pr(1).merge({ sha: squashOnMain("cla-1") });
    }, actionCtx);

    expect(result).toMatchObject({ outcome: "ok", output: { pr: { number: 2 }, head: remoteSha("cla-2") } });
    expect(github.pulls().find((p) => p.number === 2)?.base.ref).toBe("main");
    expect(remoteLog(`${remoteSha("main")}..cla-2`, "%s|%P")).toBe(`feat: cla-2|${remoteSha("main")}`);
    expect(sql(`SELECT state, number, base_ref FROM pull_requests WHERE head_ref = 'cla-2'`)).toEqual([{ state: "open", number: 2, base_ref: "main" }]);
    expect(sql(`SELECT * FROM pr_parents`)).toEqual([]);
    expect(push).toHaveBeenCalledOnce();
    expect(github.requests.slice(requestsBefore).filter((r) => r.method === "POST" && r.path === `/repos/${REPO}/pulls`)).toHaveLength(1);
  });
});

describe("stack.restack con una base combinada", () => {
  /** Los dos padres, la base combinada y el PR de `cla-3` sobre ella. */
  async function combinedPr() {
    const parents = await twoParents();
    await workspaces.combineBase({ repo: "repo_r1", issueId: parents.issue.id, branch: parents.branch, parents: parents.parents });
    const child = await openPr("cla-3", parents.branch, { "c.txt": "c1\ntres\n" }, parents.issue);
    return { ...parents, child: child.number };
  }

  const run = (number: number) => restack.run(restack.args.parse({ pr: { account: ACCOUNT, repo: REPO, number } }), ctx());
  const prBase = (number: number) => github.pulls().find((p) => p.number === number)?.base.ref;

  test("al mergear un padre recalcula la base con el que queda y el PR cambia de base", async () => {
    const { branch, child } = await combinedPr();
    const before = row(branch)!.head_sha;
    const squash = squashOnMain("cla-1");
    github.pr(1).merge({ sha: squash });

    const result = await run(1);

    expect(result.outcome).toBe("ok");
    expect(result.output).toMatchObject({ children: [{ pr: { number: child }, branch: "cla-3", status: "restacked", commits: 1, base: "cla-2" }] });
    // La base nueva: la branch por defecto de hoy (con el squash) y un merge del padre que queda.
    const after = row(branch)!;
    expect(after).toMatchObject({ status: "active" });
    expect(after.head_sha).not.toBe(before);
    expect(parentsOf(branch)).toEqual(["cla-2"]);
    expect(git("log", "--first-parent", "--format=%s", `${squash}..${after.head_sha}`)).toBe(`Merge branch 'cla-2' into ${branch}`);
    expect(localRef(branch)).toBe(after.head_sha);
    // El PR queda sobre esa base con su único commit propio y apunta al padre que queda.
    expect(remoteLog(`${after.head_sha}..cla-3`, "%s|%P")).toBe(`feat: cla-3|${after.head_sha}`);
    expect(prBase(child)).toBe("cla-2");
    expect(sql(`SELECT parent.number AS parent FROM pr_parents JOIN pull_requests parent ON parent.id = parent_id`)).toEqual([{ parent: 2 }]);
    expect(sql(`SELECT base_ref FROM workspaces WHERE branch = 'cla-3'`)).toEqual([{ base_ref: branch }]);
  });

  test("al mergear el último padre la base se disuelve y el PR queda sobre la branch por defecto", async () => {
    const { branch, child } = await combinedPr();
    github.pr(1).merge({ sha: squashOnMain("cla-1") });
    await run(1);
    const second = squashOnMain("cla-2");
    github.pr(2).merge({ sha: second });

    const result = await run(2);

    expect(result.output).toMatchObject({ children: [{ pr: { number: child }, status: "restacked", commits: 1, base: "main" }] });
    expect(row(branch)?.status).toBe("dissolved");
    expect(() => localRef(branch)).toThrow();
    expect(remoteLog(`${second}..cla-3`, "%s|%P")).toBe(`feat: cla-3|${second}`);
    expect(prBase(child)).toBe("main");
    expect(sql(`SELECT * FROM pr_parents`)).toEqual([]);
    expect(sql(`SELECT base_ref FROM workspaces WHERE branch = 'cla-3'`)).toEqual([{ base_ref: "main" }]);
  });

  test("mergear el padre que no era la base del PR deja la base en el otro y no cambia la de GitHub", async () => {
    const { branch, child } = await combinedPr();
    github.pr(2).merge({ sha: squashOnMain("cla-2") });

    const result = await run(2);

    expect(result.output).toMatchObject({ children: [{ pr: { number: child }, status: "restacked", base: "cla-1" }] });
    expect(parentsOf(branch)).toEqual(["cla-1"]);
    expect(prBase(child)).toBe("cla-1");
    expect(github.requests.filter((r) => r.method === "PATCH")).toEqual([]);
  });

  test("si los padres que quedan chocan con la base nueva: nada se mueve y se pide resolver la base (pr.baseConflict)", async () => {
    const { branch, child } = await combinedPr();
    const head = remoteSha("cla-3");
    // Alguien deja en main un cambio de b.txt distinto del de `cla-2`, y mergea `cla-1`.
    elsewhere((g, dir) => {
      g("checkout", "--quiet", "main");
      mkdirSync(dirname(join(dir, "b.txt")), { recursive: true });
      writeFileSync(join(dir, "b.txt"), "b1\notro\n");
      g("commit", "--quiet", "--all", "--message", "fix: b");
      g("push", "--quiet", "origin", "main");
    });
    github.pr(1).merge({ sha: squashOnMain("cla-1") });

    const result = await run(1);

    expect(result.outcome).toBe("conflict");
    expect(result.output).toMatchObject({ children: [{ pr: { number: child }, status: "conflict", files: ["b.txt"] }] });
    expect(remoteSha("cla-3")).toBe(head);
    expect(prBase(child)).toBe("cla-1");
    expect(row(branch)?.status).toBe("conflict");
    expect(sql(`SELECT kind FROM decisions WHERE kind = 'alert'`)).toEqual([]);
    expect(sql(`SELECT * FROM events WHERE type = 'pr.conflict'`)).toEqual([]);
    const asked = sql<{ payload: string }>(`SELECT payload FROM events WHERE type = 'pr.baseConflict'`).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
    expect(asked).toMatchObject([{ number: child, base: branch, resolveBranch: branch.replace("clanker/base/", "clanker/resolve/"), defaultBranch: "main", files: ["b.txt"] }]);
  });

  test("si otro rearmó la base y rehízo el PR por fuera, sale del último merge hacia la base que trae su historia", async () => {
    const { branch, child } = await combinedPr();
    // Alguien rearma la base a mano (merges de otra persona: commits distintos de los registrados) y rehace `cla-3` encima.
    const rebuilt = elsewhere((g) => {
      const other = ["-c", "user.name=Otra Persona", "-c", "user.email=otra@example.com"];
      g("checkout", "--quiet", "-b", "rebuild", "origin/main");
      g(...other, "merge", "--quiet", "--no-ff", "origin/cla-1", "--message", `Merge branch 'cla-1' into ${branch}`);
      g(...other, "merge", "--quiet", "--no-ff", "origin/cla-2", "--message", `Merge branch 'cla-2' into ${branch}`);
      const base = g("rev-parse", "HEAD");
      g(...other, "cherry-pick", "origin/cla-3");
      g("push", "--quiet", "--force", "origin", "HEAD:cla-3");
      return base;
    });
    expect(rebuilt).not.toBe(row(branch)!.head_sha);
    const squash = squashOnMain("cla-1");
    github.pr(1).merge({ sha: squash });

    const result = await run(1);

    expect(result.outcome).toBe("ok");
    expect(result.output).toMatchObject({ children: [{ pr: { number: child }, branch: "cla-3", status: "restacked", commits: 1, base: "cla-2" }] });
    const after = row(branch)!.head_sha!;
    expect(remoteLog(`${after}..cla-3`, "%s|%P")).toBe(`feat: cla-3|${after}`);
  });

  test("una fila vieja de la issue no frena el restack de un PR relanzado a mano sobre un solo padre: se retira y se restackea normal", async () => {
    const { issue, branch, parents } = await twoParents();
    // La corrida anterior de la issue dejó su base combinada activa; la relanzaron a mano apilada sobre `cla-1`.
    await workspaces.combineBase({ repo: "repo_r1", issueId: issue.id, branch, parents });
    const child = await openPr("cla-3", "cla-1", { "c.txt": "c1\ntres\n" }, issue);
    const squash = squashOnMain("cla-1");
    github.pr(1).merge({ sha: squash });

    const result = await run(1);

    expect(result.outcome).toBe("ok");
    expect(result.output).toMatchObject({ children: [{ pr: { number: child.number }, branch: "cla-3", status: "restacked", commits: 1, base: "main" }] });
    expect(remoteLog(`${squash}..cla-3`, "%s|%P")).toBe(`feat: cla-3|${squash}`);
    expect(prBase(child.number)).toBe("main");
    expect(row(branch)?.status).toBe("dissolved");
    expect(() => localRef(branch)).toThrow();
    expect(sql(`SELECT * FROM pr_parents`)).toEqual([]);
  });

  test("la fila vieja se conserva si otro PR abierto de la issue podría seguir usándola", async () => {
    const { issue, branch, parents } = await twoParents();
    await workspaces.combineBase({ repo: "repo_r1", issueId: issue.id, branch, parents });
    await openPr("cla-3", branch, { "c.txt": "c1\ntres\n" }, issue);
    await openPr("cla-4", "cla-1", { "c.txt": "c1\ncuatro\n" }, issue);
    github.pr(1).merge({ sha: squashOnMain("cla-1") });

    const result = await run(1);

    const { children } = result.output as { children: { branch: string; status: string; base?: string }[] };
    expect(children.find((c) => c.branch === "cla-4")).toMatchObject({ status: "restacked", base: "main" });
    expect(row(branch)?.status).toBe("active");
  });
});
