import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createAgents } from "../../agents/agents";
import { createRuntimeRegistry, type AgentRuntime } from "../../agents/runtime";
import { createArtifacts } from "../../artifacts/artifacts";
import { createDefs } from "../../defs/defs";
import { createFlows } from "../../flows/flows";
import { git } from "../../git/git";
import { createRepos } from "../../repos/repos";
import { newId } from "../../store/conventions";
import { pullRequests, workspaces } from "../../store/schema";
import { openStore } from "../../store/store";
import { APPLY_LOCAL_PATCH } from "../../template/flows";
import { createWorkspaces, workspaceAcquireAction } from "../../workspaces/workspaces";
import { prById } from "../pr-rows";
import { prApplyLocalPatchAction } from "./apply-local-patch";

const runtime: AgentRuntime = {
  id: "fake",
  capabilities: { costPerTurn: true },
  start: () => Promise.reject(new Error("el flujo no usa agentes")),
  resume: () => Promise.reject(new Error("el flujo no usa agentes")),
};
const IDENTITY = { name: "Test", email: "test@example.com" };
const PATCH = [
  "diff --git a/code.txt b/code.txt", "--- a/code.txt", "+++ b/code.txt",
  "@@ -1 +1 @@", "-before", "+after", "",
].join("\n");

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "clanker-apply-patch-"));
  const checkout = join(dir, "checkout");
  mkdirSync(checkout);
  const primary = (...args: string[]) => git(checkout, args);
  await primary("init", "-b", "main");
  await primary("config", "user.name", IDENTITY.name);
  await primary("config", "user.email", IDENTITY.email);
  await primary("config", "commit.gpgsign", "false");
  writeFileSync(join(checkout, "code.txt"), "before\n");
  writeFileSync(join(checkout, ".gitignore"), "ignored.txt\n");
  await primary("add", ".");
  await primary("commit", "-m", "feat: inicial");
  await primary("branch", "parent");

  const store = openStore({ path: ":memory:" });
  const repos = createRepos({ store });
  const repo = repos.add({ name: "demo", path: checkout });
  const dataDir = join(dir, "data");
  const identityOf = () => Promise.resolve(IDENTITY);
  const branch = "local-pr";
  const base = "parent";
  const seed = createWorkspaces({ store, dataDir, repoConfig: repos.config, identityOf });
  const lease = await seed.acquire({ repo, branch, base, runId: newId("run") });
  seed.release(lease);
  // A partir de aquí, un fetch o la preparación de la receta deben fallar el test.
  await primary("remote", "add", "origin", join(dir, "no-origin"));
  const worktreeSetup = vi.fn(() => { throw new Error("no debe correr setup"); });
  const ws = createWorkspaces({ store, dataDir, repoConfig: repos.config, identityOf, worktreeSetup });

  const inWorktree = (...args: string[]) => git(lease.path, args);
  writeFileSync(join(lease.path, "local.txt"), "PR anterior\n");
  await inWorktree("add", "local.txt");
  await inWorktree("commit", "-m", "feat: PR antes del patch");
  const head = await inWorktree("rev-parse", "HEAD");
  const prId = newId("pr");
  store.db.insert(pullRequests).values({
    id: prId, repoId: repo, headRef: branch, baseRef: base, headSha: head,
    state: "local", isDraft: true, owned: true, title: "PR local",
  }).run();

  const defs = createDefs({ store });
  const flows = createFlows({
    store, defs,
    agents: createAgents({ store, defs, runtimes: createRuntimeRegistry([runtime], {}) }),
    artifacts: createArtifacts({ store, dir: join(dir, "artifacts") }),
    roles: () => undefined,
  });
  const stopRelease = store.events.subscribe(({ runId }) => {
    if (runId) ws.releaseHeldBy(runId);
  }, { types: ["run.finished"] });
  flows.registerAction(workspaceAcquireAction(ws));
  const action = prApplyLocalPatchAction({ store });
  const params = { prId, repo, branch, base, head, patch: PATCH };
  async function run(patchFlow = action, changes: Partial<typeof params> = {}) {
    flows.registerAction(patchFlow);
    flows.save(APPLY_LOCAL_PATCH, { scope: "builtin" });
    await flows.recover();
    const runId = await flows.start("apply-local-patch", { type: "pr", id: prId }, { ...params, ...changes }, { repoId: repo, by: "mcp" });
    await vi.waitFor(() => {
      expect(store.events.since(0, { types: ["run.finished"], runId })).toHaveLength(1);
    }, { timeout: 10_000 });
    return flows.getRun(runId);
  }
  return {
    run, action, store, head, prId, checkout, primary, inWorktree, lease, worktreeSetup,
    pr: () => prById(store.db, prId),
    workspace: () => store.db.select().from(workspaces).where(eq(workspaces.id, lease.workspaceId)).get()!,
    async close() {
      await flows.close();
      stopRelease();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("apply-local-patch", () => {
  let fixture: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => { fixture = await setup(); });
  afterEach(async () => { await fixture?.close(); });

  test("agrega un solo commit en el worktree, actualiza sus puntas y no toca el checkout ni la receta", async () => {
    const f = fixture;
    writeFileSync(join(f.checkout, "code.txt"), "cambio ajeno\n");
    await f.primary("add", "code.txt");
    const before = await f.primary("status", "--porcelain");

    expect(await f.run()).toMatchObject({ status: "done", lane: "maintenance" });

    const tip = await f.inWorktree("rev-parse", "HEAD");
    expect(await f.inWorktree("rev-parse", "HEAD^")).toBe(f.head);
    expect(await f.inWorktree("show", "HEAD:code.txt")).toBe("after");
    expect(await f.inWorktree("status", "--porcelain")).toBe("");
    expect(await f.primary("status", "--porcelain")).toBe(before);
    expect(readFileSync(join(f.checkout, "code.txt"), "utf8")).toBe("cambio ajeno\n");
    expect(f.worktreeSetup).not.toHaveBeenCalled();
    expect(f.pr()).toMatchObject({ state: "local", headSha: tip, headChangedAt: expect.any(Number) });
    expect(f.workspace()).toMatchObject({ state: "idle", headSha: tip, remoteSha: null });
    expect(f.store.events.since(0, { types: ["pr.changed", "pr.base_rewritten", "pr.opened"] })).toMatchObject([
      { type: "pr.changed", subject: { type: "pr", id: f.prId } },
    ]);
  });

  test("si el commit se movió antes del corte, persiste la misma punta sin aplicar el patch otra vez", async () => {
    const f = fixture;
    let prepared: string | undefined;
    const run = await f.run({
      ...f.action,
      retry: { max: 1, backoffSec: [0] },
      run: (args, ctx) => f.action.run(args, {
        ...ctx,
        once: <T>(stage: string, fn: () => Promise<T>) => ctx.once(stage, fn).then(async (value) => {
          if (!prepared) {
            prepared = String(value);
            await f.inWorktree("merge", "--ff-only", prepared);
            expect(f.pr()?.headSha).toBe(f.head);
            throw new Error("corte después del fast-forward");
          }
          return value;
        }),
      }),
    });

    expect(run).toMatchObject({ status: "done" });
    expect(await f.inWorktree("rev-parse", "HEAD")).toBe(prepared);
    expect(await f.inWorktree("rev-parse", "HEAD^")).toBe(f.head);
    expect(f.pr()?.headSha).toBe(prepared);
    expect(f.store.events.since(0, { types: ["pr.changed"] })).toHaveLength(1);
  });

  test("rechaza un HEAD obsoleto, aunque todavía no se haya actualizado la fila", async () => {
    const f = fixture;
    await f.inWorktree("commit", "--allow-empty", "-m", "chore: otro commit");
    const otherHead = await f.inWorktree("rev-parse", "HEAD");

    expect(await f.run()).toMatchObject({ status: "failed" });
    expect(await f.inWorktree("rev-parse", "HEAD")).toBe(otherHead);
    expect(f.pr()?.headSha).toBe(f.head);
  });

  test("rechaza un worktree sucio y conserva sus cambios", async () => {
    const f = fixture;
    writeFileSync(join(f.lease.path, "code.txt"), "cambio local\n");
    await f.inWorktree("add", "code.txt");
    writeFileSync(join(f.lease.path, "untracked.txt"), "archivo local\n");

    expect(await f.run()).toMatchObject({ status: "failed" });
    expect(await f.inWorktree("rev-parse", "HEAD")).toBe(f.head);
    expect(await f.inWorktree("status", "--porcelain")).toBe("M  code.txt\n?? untracked.txt");
    expect(f.pr()?.headSha).toBe(f.head);
  });

  test("un patch incompatible no cambia el worktree ni la fila", async () => {
    const f = fixture;
    expect(await f.run(f.action, { patch: PATCH.replace("-before", "-otro") })).toMatchObject({ status: "failed" });
    expect(await f.inWorktree("rev-parse", "HEAD")).toBe(f.head);
    expect(await f.inWorktree("status", "--porcelain")).toBe("");
    expect(f.pr()?.headSha).toBe(f.head);
  });

  test("no sobreescribe un archivo ignorado para el que el patch agrega una versión trackeada", async () => {
    const f = fixture;
    const path = join(f.lease.path, "ignored.txt");
    writeFileSync(path, "archivo local\n");
    const patch = [
      "diff --git a/ignored.txt b/ignored.txt", "new file mode 100644", "--- /dev/null",
      "+++ b/ignored.txt", "@@ -0,0 +1 @@", "+nuevo", "",
    ].join("\n");

    expect(await f.run(f.action, { patch })).toMatchObject({ status: "failed" });
    expect(readFileSync(path, "utf8")).toBe("archivo local\n");
    expect(await f.inWorktree("rev-parse", "HEAD")).toBe(f.head);
  });
});
