import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  prPushLeaseAction,
  prRebaseApprovalAction,
  workspaceAttachAction,
  workspaceCommitAfterRebaseAction,
  workspaceRebaseAbortAction,
  workspaceRebaseAction,
  type ActionCtx,
  type Askpass,
  type Recipes,
  type Store,
  type Workspaces,
} from "@clanker/core";
import { afterEach, beforeEach, describe, expect, test} from "vitest";
import { tempGitRepo, type TempGitRepo } from "./git";
import { startGitHubSim, type GitHubSim } from "./github-sim";

// Las acciones del rebase de un PR abierto (`workspace.attach`, `workspace.rebase`, `pr.pushLease`) y el
// `afterRebase` de `recipe.check`, sobre repos git reales, un remoto bare y el GitHub simulado.

const TOKEN = "github_pat_UNIQUE-0123456789";
const ACCOUNT = "octocat";
const REPO = "octocat/secret-project";
const BRANCH = "cla-75";
const RECIPE = { version: 1, commands: { ok: "true" }, checks: ["ok"], afterRebase: ["echo hook > hook.txt"] };

let dataDir: string;
let store: Store;
let repo: TempGitRepo;
let askpass: Askpass;
let workspaces: Workspaces;
let recipes: Recipes;
let github: GitHubSim;
let attachAction: ReturnType<typeof workspaceAttachAction>;
let rebaseAction: ReturnType<typeof workspaceRebaseAction>;
let pushLease: ReturnType<typeof prPushLeaseAction>;
let approval: ReturnType<typeof prRebaseApprovalAction>;
let commitAfter: ReturnType<typeof workspaceCommitAfterRebaseAction>;
let abort: ReturnType<typeof workspaceRebaseAbortAction>;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "clanker-rebase-pr-"));
  store = openStore({ path: ":memory:" });
  repo = tempGitRepo({
    remote: true,
    commits: [{ message: "chore: base", files: { "a.txt": "a1\na2\na3\n", "b.txt": "b\n", ".clanker/recipe.json": JSON.stringify(RECIPE) } }],
  });
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
  const packDir = join(dataDir, "pack");
  mkdirSync(packDir);
  writeFileSync(
    join(packDir, "pack.json"),
    JSON.stringify({ id: "acme", version: 1, activate: { githubOrgs: ["octocat"] }, conventions: { councilPrefix: "[clanker-council] " } }),
  );
  await packs.load(packDir);
  recipes = createRecipes({ store, defs, workspaces, artifacts: createArtifacts({ store, dir: join(dataDir, "artifacts") }), slots: createSlots({ store }) });
  const prs = createPrs({ connections, packs });
  const rebasePr = { store, workspaces, repoConfig: repos, prs };
  attachAction = workspaceAttachAction(workspaces);
  rebaseAction = workspaceRebaseAction(rebasePr);
  pushLease = prPushLeaseAction(rebasePr);
  approval = prRebaseApprovalAction(rebasePr);
  commitAfter = workspaceCommitAfterRebaseAction(workspaces);
  abort = workspaceRebaseAbortAction(workspaces);

  // El PR ya publicado: un commit sobre a.txt.
  const lease = await workspaces.acquire({ repo: "repo_00000000000000000000000001", branch: BRANCH, base: "main", runId: newId("run") });
  writeFileSync(join(lease.path, "a.txt"), "a1\nmine\na3\n");
  const publish = prPublishAction({ store, workspaces, recipes, repoConfig: repos, connections, packs });
  const { workspaceId, path, branch, baseSha, fencingToken } = lease;
  const published = await publish.run(
    publish.args.parse({
      ws: { workspaceId, path, branch, baseSha, fencingToken },
      plan: { commits: [{ message: "feat: mine", hunks: ["h1"], tests: [] }], pr: { title: "[CLA-75] rebase", body: "" } },
    }),
    ctx(),
  );
  expect(published.outcome).toBe("ok");
  workspaces.release(lease);
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
    key: "run:rebase:1",
    signal: new AbortController().signal,
    async once(stage, fn) {
      if (saved.has(stage)) return saved.get(stage) as never;
      const result = await fn();
      saved.set(stage, JSON.parse(JSON.stringify(result)));
      return result;
    },
  };
}

/** Un commit de `files` en `branch` del remoto, hecho por otro (otro PR mergeado, una persona), y el fetch de `attach`. */
function elsewhere(branch: string, files: Record<string, string>): string {
  const dir = join(dataDir, `other-${Math.random().toString(36).slice(2)}`);
  repo.git("clone", "--quiet", repo.remoteDir!, dir);
  const git = (...args: string[]) => repo.git("-C", dir, ...args);
  git("checkout", "--quiet", branch);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git("add", "--all");
  git("commit", "--quiet", "--message", "chore: elsewhere");
  git("push", "--quiet", "origin", branch);
  return git("rev-parse", "HEAD");
}

/** `workspace.attach` como la corrida de mantenimiento, y el `$ws` que los demás nodos reciben. */
async function attach() {
  const run = ctx();
  const result = await attachAction.run(attachAction.args.parse({ repo: "repo_00000000000000000000000001", branch: BRANCH, base: "main" }), run);
  expect(result.outcome).toBe("ok");
  const { workspaceId, path, branch, baseSha, fencingToken } = result.output as { workspaceId: string; path: string; branch: string; baseSha: string; fencingToken: number };
  return { workspaceId, path, branch, baseSha, fencingToken };
}

type Ws = Awaited<ReturnType<typeof attach>>;
const rebase = (ws: Ws, extra: { base?: string | null; continue?: boolean } = {}) => rebaseAction.run(rebaseAction.args.parse({ ws, ...extra }), ctx());
const push = (ws: Ws) => pushLease.run(pushLease.args.parse({ ws }), ctx());
const local = (ws: Ws, ...args: string[]) => repo.git("-C", ws.path, ...args);
const remoteSha = () => repo.git("--git-dir", repo.remoteDir!, "rev-parse", `refs/heads/${BRANCH}`);

describe("rebase por conflicto de un PR abierto", () => {
  test("attach, rebase limpio y pushLease: el PR queda sobre la base nueva, pusheado con lease", async () => {
    const moved = elsewhere("main", { "b.txt": "b-main\n" });
    const ws = await attach();

    const rebased = await rebase(ws);
    const pushed = await push(ws);

    expect(rebased).toEqual({ outcome: "clean", output: { baseSha: moved, head: local(ws, "rev-parse", "HEAD") } });
    expect(local(ws, "log", "--format=%s", `${moved}..HEAD`)).toBe("feat: mine");
    expect(remoteSha()).toBe(local(ws, "rev-parse", "HEAD"));
    expect(pushed).toEqual({ outcome: "draft", output: { head: remoteSha(), pr: { account: ACCOUNT, repo: REPO, number: 1 } } });
    expect(workspaces.baseSha(ws)).toBe(moved);
  });

  test("pushLease da ready si el PR ya salió de draft", async () => {
    elsewhere("main", { "b.txt": "b-main\n" });
    const ws = await attach();
    await rebase(ws);
    github.pr(1).setDraft(false);

    const pushed = await push(ws);

    expect(pushed.outcome).toBe("ready");
    expect(remoteSha()).toBe(local(ws, "rev-parse", "HEAD"));
  });

  test("conflict entrega los archivos para el agente y continue termina cuando no quedan marcas", async () => {
    const moved = elsewhere("main", { "a.txt": "a1\nmain\na3\n" });
    const ws = await attach();

    const conflict = await rebase(ws);
    expect(conflict).toMatchObject({ outcome: "conflict", output: { conflicts: ["a.txt"] } });

    const pending = await rebase(ws, { continue: true });
    expect(pending).toMatchObject({ outcome: "conflict", output: { conflicts: ["a.txt"], failures: expect.stringContaining("Quedan marcas") } });

    writeFileSync(join(ws.path, "a.txt"), "a1\nmain+mine\na3\n");
    const done = await rebase(ws, { continue: true });
    const pushed = await push(ws);

    expect(done).toMatchObject({ outcome: "clean", output: { baseSha: moved } });
    expect(remoteSha()).toBe(local(ws, "rev-parse", "HEAD"));
    expect(pushed.outcome).toBe("draft");
  });

  test("un PR con threads [clanker-council] no se rebasea", async () => {
    elsewhere("main", { "b.txt": "b-main\n" });
    github.pr(1).councilThread("el nombre no calza");
    const ws = await attach();
    const before = local(ws, "rev-parse", "HEAD");

    await expect(rebase(ws)).rejects.toThrow(PermanentActionError);
    await expect(rebase(ws)).rejects.toThrow(/council/);

    expect(local(ws, "rev-parse", "HEAD")).toBe(before);
    expect(local(ws, "status", "--porcelain")).toBe("");
  });

  test("una precondición que no se cumple es PermanentActionError: no se reintenta", async () => {
    const ws = await attach();
    writeFileSync(join(ws.path, "sucio.txt"), "x\n");

    await expect(rebase(ws)).rejects.toThrow(PermanentActionError);
  });

  test("un rebase que falla sin conflicto da error y la branch queda igual", async () => {
    elsewhere("main", { "b.txt": "b-main\n" });
    const ws = await attach();
    const before = local(ws, "rev-parse", "HEAD");
    const hook = join(repo.dir, ".git", "hooks", "pre-rebase");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);

    const result = await rebase(ws);

    expect(result).toMatchObject({ outcome: "error", output: { failures: expect.stringContaining("sin conflictos") } });
    expect(local(ws, "rev-parse", "HEAD")).toBe(before);
    expect(local(ws, "symbolic-ref", "--short", "HEAD")).toBe(BRANCH);
  });

  test("pushLease con un lease rechazado (alguien más pusheó) no se reintenta", async () => {
    elsewhere("main", { "b.txt": "b-main\n" });
    const ws = await attach();
    await rebase(ws);
    elsewhere(BRANCH, { "z.txt": "z\n" });

    await expect(push(ws)).rejects.toThrow(PermanentActionError);
    await expect(push(ws)).rejects.toThrow(/alguien más pusheó/);
  });

  test("pushLease de un PR ya mergeado lanza", async () => {
    elsewhere("main", { "b.txt": "b-main\n" });
    const ws = await attach();
    await rebase(ws);
    github.pr(1).merge();

    await expect(push(ws)).rejects.toThrow(/ya está mergeado/);
  });

  test("sin PR abierto de la branch no hay a qué rebasear", async () => {
    const ws = await attach();
    store.db.$client.prepare("UPDATE pull_requests SET state = 'closed'").run();

    await expect(rebase(ws)).rejects.toThrow(/no tiene un PR abierto/);
    await expect(push(ws)).rejects.toThrow(/no tiene un PR abierto/);
  });
  test("un PR que el sistema no abrió (lo descubrió Watch) no se rebasea ni se pushea", async () => {
    elsewhere("main", { "b.txt": "b-main\n" });
    const ws = await attach();
    store.db.$client.prepare("UPDATE pull_requests SET owned = 0").run();
    const before = remoteSha();

    await expect(rebase(ws)).rejects.toThrow(/no lo abrió Clanker Yard/);
    await expect(push(ws)).rejects.toThrow(PermanentActionError);
    expect(remoteSha()).toBe(before);
  });
});

describe("recipe.check con afterRebase", () => {
  const check = (ws: Ws, afterRebase?: boolean) =>
    recipes.checkAction.run(recipes.checkAction.args.parse({ ws, scope: "all", ...(afterRebase !== undefined && { afterRebase }) }), ctx());

  test("corre los comandos afterRebase de la receta antes de los checks, y solo si se pide", async () => {
    const ws = await attach();

    await check(ws);
    expect(existsSync(join(ws.path, "hook.txt"))).toBe(false);

    const result = await check(ws, true);

    expect(readFileSync(join(ws.path, "hook.txt"), "utf8")).toBe("hook\n");
    expect(result).toMatchObject({ outcome: "ok", output: { checks: [{ name: "afterRebase", ok: true }, { name: "ok", ok: true }] } });
  });

  test("un afterRebase rojo es fail con su extracto y no corre los checks", async () => {
    const ws = await attach();
    writeFileSync(
      join(ws.path, ".clanker/recipe.json"),
      JSON.stringify({ ...RECIPE, afterRebase: ["echo se rompio >&2; exit 3"] }),
    );

    const result = await check(ws, true);

    expect(result).toMatchObject({ outcome: "fail", output: { failures: expect.stringContaining("[afterRebase] exit 3") } });
    expect((result.output as { checks: unknown[] }).checks).toHaveLength(1);
  });
});

describe("lo que el flujo de rebase por conflicto pide además", () => {
  const PR = { account: ACCOUNT, repo: REPO, number: 1 };
  const approve = (behavior: boolean, policy: "auto" | "ask") => approval.run(approval.args.parse({ pr: PR, behavior, policy }), ctx());

  test.each([
    { draft: true, behavior: false, policy: "auto", outcome: "proceed" },
    { draft: true, behavior: true, policy: "ask", outcome: "proceed" },
    { draft: false, behavior: false, policy: "auto", outcome: "proceed" },
    { draft: false, behavior: false, policy: "ask", outcome: "ask" },
    { draft: false, behavior: true, policy: "auto", outcome: "ask" },
  ] as const)("pr.rebaseApproval con draft=$draft, behavior=$behavior y rebaseNonDraft=$policy da $outcome", async ({ draft, behavior, policy, outcome }) => {
    github.pr(1).setDraft(draft);

    expect(await approve(behavior, policy)).toEqual({ outcome, output: { draft } });
  });

  test("pr.rebaseApproval de un PR cerrado lanza", async () => {
    github.pr(1).merge();

    await expect(approve(false, "auto")).rejects.toThrow(PermanentActionError);
  });

  test("workspace.commitAfterRebase commitea lo que dejó el afterRebase, y pushLease lo pushea", async () => {
    const moved = elsewhere("main", { "b.txt": "b-main\n" });
    const ws = await attach();
    await rebase(ws);
    await recipes.checkAction.run(recipes.checkAction.args.parse({ ws, scope: "all", afterRebase: true }), ctx());
    expect(local(ws, "status", "--porcelain")).toBe("?? hook.txt");

    const committed = await commitAfter.run(commitAfter.args.parse({ ws }), ctx());
    await push(ws);

    expect(committed).toEqual({ outcome: "ok", output: { committed: true, head: local(ws, "rev-parse", "HEAD") } });
    expect(local(ws, "log", "--format=%s", `${moved}..HEAD`).split("\n")).toEqual(["chore: update generated files after rebase", "feat: mine"]);
    expect(local(ws, "status", "--porcelain")).toBe("");
    expect(repo.git("--git-dir", repo.remoteDir!, "show", `${BRANCH}:hook.txt`)).toBe("hook");
  });

  test("workspace.commitAfterRebase sin cambios no hace nada", async () => {
    elsewhere("main", { "b.txt": "b-main\n" });
    const ws = await attach();
    await rebase(ws);
    const head = local(ws, "rev-parse", "HEAD");

    const result = await commitAfter.run(commitAfter.args.parse({ ws }), ctx());

    expect(result).toEqual({ outcome: "ok", output: { committed: false, head } });
  });

  test("workspace.rebaseAbort deja la branch como estaba antes del rebase y sin él no hace nada", async () => {
    elsewhere("main", { "a.txt": "a1\nmain\na3\n" });
    const ws = await attach();
    const before = local(ws, "rev-parse", "HEAD");
    expect(await rebase(ws)).toMatchObject({ outcome: "conflict" });

    const first = await abort.run(abort.args.parse({ ws }), ctx());
    const second = await abort.run(abort.args.parse({ ws }), ctx());

    expect([first.output, second.output]).toEqual([{ aborted: true }, { aborted: false }]);
    expect(local(ws, "rev-parse", "HEAD")).toBe(before);
    expect(local(ws, "symbolic-ref", "--short", "HEAD")).toBe(BRANCH);
    expect(local(ws, "status", "--porcelain")).toBe("");
  });
});
