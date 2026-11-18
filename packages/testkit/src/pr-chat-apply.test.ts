import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient, type Client, type RepoId, type RunId } from "@clanker/api";
import { hashUiKey, isolatedUiKey } from "@clanker/api/node";
import { createConnections, createFileSecrets, createRepos, createWorkspaces, newId, openStore, type Store } from "@clanker/core";
import { seedPr } from "@clanker/core/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tempGitRepo, type TempGitRepo } from "./git";
import { startGitHttpServer } from "./git-http";
import { startGitHubSim, type GitHubSim } from "./github-sim";
import { labeledFake } from "./labeled-fake";
import { startCore } from "./start-core";

// Aplicar la propuesta del chat de un PR (`chat-aplicar` y `chat-aplicar-local`) con el core real, un remoto git
// real y el GitHub simulado. El agente es el fake con el id de `claude-sdk`: la receta corre de verdad.

vi.setConfig({ testTimeout: 60_000 });

const ACCOUNT = "octocat";
const REPO = "octocat/web";
const TOKEN = "github_pat_UNIQUE-chat-apply";
/** El check falla si queda un TODO en `one.txt`: así una propuesta puede dejar los checks rojos. */
const RECIPE = { version: 1, commands: { lint: "! grep -q TODO one.txt" }, checks: ["lint"] };

let dir: string;
let fixtures: string;
let store: Store;
let repo: TempGitRepo;
let github: GitHubSim;
let closeGit: () => Promise<void>;
let core: Awaited<ReturnType<typeof startCore>> | undefined;
let client: Client;
let repoId: RepoId;
let clone: string;
let serverUrl: string;

/** Arranca el core: después de escribir los guiones, que el fake lee al crearse. */
async function boot() {
  const connections = createConnections({ store, secrets: createFileSecrets({ dir: join(dir, "secrets") }), github: { baseUrl: github.baseUrl } });
  await connections.connect({ provider: "github", account: ACCOUNT, scopes: [], token: TOKEN }, "core");
  core = await startCore({
    store,
    dataDir: dir,
    connections,
    runtimes: [labeledFake("claude-sdk", { fixtures, speed: Infinity })],
    scheduler: false,
    gitUrl: () => serverUrl,
    coreVersion: "0.0.0",
    onShutdown: () => {},
    pause: () => Promise.resolve(),
    uiKeyHash: hashUiKey(isolatedUiKey(dir)),
  });
  client = createClient({ url: core.server.url, token: core.server.token, origin: "ui", uiKey: isolatedUiKey(dir) });
}

const git = (...args: string[]) => repo.git("-C", clone, ...args);
const remoteSha = (branch: string) => repo.git("--git-dir", repo.remoteDir!, "rev-parse", `refs/heads/${branch}`);
const remoteLog = (range: string) => repo.git("--git-dir", repo.remoteDir!, "log", "--format=%s", range).split("\n").filter(Boolean);

/** Un commit de `branch` sobre la punta de `base` en el remoto, pusheado. */
function commit(branch: string, base: string, files: Record<string, string>, message = `feat: ${branch}`) {
  git("checkout", "--quiet", "-B", branch, `origin/${base}`);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(clone, path)), { recursive: true });
    writeFileSync(join(clone, path), content);
  }
  git("add", "--all");
  git("commit", "--quiet", "--message", message);
  git("push", "--quiet", "--force", "origin", branch);
  git("fetch", "--quiet", "origin");
}

function chatScript(round: number, files: Record<string, string>, summary: string) {
  const effects = Object.entries(files).map(([path, content]) => `  - write:\n      path: ${path}\n      content: ${JSON.stringify(content)}\n`).join("");
  const proposal = JSON.stringify({ summary, items: [{ id: "c1", change: summary, path: Object.keys(files)[0] }] });
  writeFileSync(join(fixtures, `chat.r${round}.yaml`), `match: { mode: turn }\neffects:\n${effects}result:\n  status: success\n  structured:\n    outcome: ok\n    summary: ${JSON.stringify(summary)}\n    payload:\n      reply: ${JSON.stringify(summary)}\n      proposal: ${proposal}\n`);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "clanker-chat-apply-"));
  fixtures = join(dir, "fixtures");
  mkdirSync(fixtures);
  store = openStore({ path: join(dir, "clanker.db") });
  repo = tempGitRepo({
    remote: true,
    commits: [{ message: "chore: base", files: { "base.txt": "base\n", ".clanker/recipe.json": `${JSON.stringify(RECIPE)}\n` } }],
  });
  repo.git("--git-dir", repo.remoteDir!, "config", "http.receivepack", "true");
  const gitServer = await startGitHttpServer(repo.remoteDir!, { user: ACCOUNT, password: TOKEN });
  closeGit = () => gitServer.close();
  github = await startGitHubSim({ origin: repo, repo: REPO, account: ACCOUNT, token: TOKEN });
  clone = join(dir, "clone");
  repo.git("clone", "--quiet", repo.remoteDir!, clone);
  serverUrl = gitServer.url;
  repoId = createRepos({ store }).add({ name: "web", path: repo.dir, remote: REPO });
});

afterEach(async () => {
  await core?.close();
  core = undefined;
  await github.close();
  await closeGit();
  store.close();
  repo.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

/** Un PR remoto del sistema sobre lo que ya está en el remoto. */
function remotePr(head: string, base: string, parents: string[] = []) {
  const pr = github.openPr({ head, base, title: head, draft: false });
  return seedPr(store, { repoId, number: pr.number, headRef: head, baseRef: base, headSha: pr.headSha(), isDraft: false, title: head, parents });
}

async function settled(prId: string) {
  let snapshot!: Awaited<ReturnType<Client["chats"]["get"]>>;
  await vi.waitFor(async () => {
    snapshot = await client.chats.get({ prId });
    expect(snapshot.chat.busy).toBe(false);
  }, { timeout: 15_000, interval: 20 });
  return snapshot;
}

/** Manda un pedido al chat del PR y espera su propuesta. */
async function propose(prId: string, text: string) {
  const { chat } = await client.chats.get({ prId });
  await client.chats.send({ chatId: chat.id, text });
  const done = await settled(prId);
  expect(done.proposal?.status).toBe("draft");
  return { chatId: chat.id, rev: done.proposal!.rev };
}

/** Aplica y espera a que la propuesta salga de `applying`. */
async function apply(prId: string, chatId: string, rev: number) {
  const { runId } = await client.chats.apply({ chatId: chatId as never, rev });
  let snapshot!: Awaited<ReturnType<Client["chats"]["get"]>>;
  await vi.waitFor(async () => {
    snapshot = await client.chats.get({ prId });
    expect(snapshot.proposal?.status).not.toBe("applying");
  }, { timeout: 30_000, interval: 50 });
  return { runId: runId as RunId, snapshot, run: await client.runs.get({ id: runId }) };
}

describe("aplicar la propuesta del chat", () => {
  test("PR remoto con un hijo apilado: un fixup squasheado con push con lease, y el hijo sobre la punta nueva", async () => {
    commit("cla-1", "main", { "one.txt": "uno\n" });
    commit("cla-2", "cla-1", { "two.txt": "dos\n" });
    const a = remotePr("cla-1", "main");
    const b = remotePr("cla-2", "cla-1", [a]);
    const before = remoteSha("cla-1");
    chatScript(1, { "one.txt": "uno corregido\n" }, "Corrige uno");
    await boot();
    const { chatId, rev } = await propose(a, "corrige uno");

    const { snapshot, run } = await apply(a, chatId, rev);

    expect(run).toMatchObject({ status: "done", flow: { slug: "chat-aplicar" }, lane: "maintenance" });
    expect(snapshot.proposal).toMatchObject({ rev, status: "applied", result: { sha: remoteSha("cla-1"), children: [{ prId: b, status: "restacked", head: remoteSha("cla-2") }] } });
    expect(remoteSha("cla-1")).not.toBe(before);
    expect(remoteLog("main..cla-1")).toEqual(["feat: cla-1"]);
    expect(repo.git("--git-dir", repo.remoteDir!, "show", "cla-1:one.txt")).toBe("uno corregido");
    expect(remoteLog("main..cla-2")).toEqual(["feat: cla-2", "feat: cla-1"]);
    expect(repo.git("--git-dir", repo.remoteDir!, "merge-base", "--is-ancestor", "cla-1", "cla-2") === "").toBe(true);
    expect(snapshot.messages.at(-1)).toMatchObject({ role: "system", text: expect.stringContaining("restackeado") });
    // El restack marcó la reescritura: Watch no relanza `restack-rewritten` por ella.
    const marks = store.db.$client.prepare("SELECT key FROM watch_marks WHERE pr_id = ? AND kind = 'pr.base_rewritten'").all(a) as { key: string }[];
    expect(marks).toEqual([{ key: `${before}>${remoteSha("cla-1")}` }]);
  });

  test("PR local con un hijo local: commits en la máquina, sin ningún push", async () => {
    commit("cla-1", "main", { "one.txt": "uno\n" });
    const remote = remotePr("cla-1", "main");
    repo.git("fetch", "--quiet", "origin");
    // Como los deja `pr.publish` en un stack local: cada branch sale de un worktree de Clanker Yard.
    const workspaces = createWorkspaces({
      store,
      dataDir: dir,
      repoConfig: () => ({ path: repo.dir, defaultBranch: "main" }),
      identityOf: async () => ({ name: "Ana Pérez", email: "ana@example.com" }),
    });
    const local = async (branch: string, base: string, files: Record<string, string>, parents: string[]) => {
      const lease = await workspaces.acquire({ repo: repoId, branch, base, runId: newId("run") });
      for (const [path, content] of Object.entries(files)) writeFileSync(join(lease.path, path), content);
      repo.git("-C", lease.path, "add", "--all");
      repo.git("-C", lease.path, "commit", "--quiet", "--message", `feat: ${branch}`);
      workspaces.release(lease);
      return seedPr(store, { repoId, number: null, nodeId: null, headRef: branch, baseRef: base, headSha: repo.git("rev-parse", branch), state: "local", isDraft: true, title: branch, parents });
    };
    const a = await local("cla-2", "cla-1", { "three.txt": "tres\n" }, [remote]);
    const b = await local("cla-3", "cla-2", { "four.txt": "cuatro\n" }, [a]);
    const pushes = github.requests.length;
    chatScript(1, { "three.txt": "tres corregido\n" }, "Corrige tres");
    await boot();
    const { chatId, rev } = await propose(a, "corrige tres");

    const { snapshot, run } = await apply(a, chatId, rev);

    expect(run).toMatchObject({ status: "done", flow: { slug: "chat-aplicar-local" } });
    expect(snapshot.proposal).toMatchObject({ status: "applied", result: { children: [{ prId: b, status: "restacked" }] } });
    expect(repo.git("show", "cla-2:three.txt")).toBe("tres corregido");
    expect(repo.git("log", "--format=%s", "origin/cla-1..cla-2")).toBe("feat: cla-2");
    expect(repo.git("log", "--format=%s", "origin/cla-1..cla-3").split("\n")).toEqual(["feat: cla-3", "feat: cla-2"]);
    expect(() => remoteSha("cla-2")).toThrow();
    expect(() => remoteSha("cla-3")).toThrow();
    expect(github.requests.slice(pushes).filter((r) => r.method !== "GET" && r.path !== "/graphql")).toEqual([]);
  });

  test("propuesta stale: el PR avanzó y no calza, el PR queda igual", async () => {
    commit("cla-1", "main", { "one.txt": "uno\n" });
    const a = remotePr("cla-1", "main");
    chatScript(1, { "one.txt": "uno corregido\n" }, "Corrige uno");
    await boot();
    const { chatId, rev } = await propose(a, "corrige uno");
    // Alguien empuja otro cambio a la misma línea; Watch lo vería y movería la fila.
    commit("cla-1", "cla-1", { "one.txt": "uno de otro\n" }, "fix: otro cambio");
    const moved = remoteSha("cla-1");
    store.db.$client.prepare("UPDATE pull_requests SET head_sha = ? WHERE id = ?").run(moved, a);
    expect((await client.chats.get({ prId: a })).proposal?.status).toBe("stale");
    await expect(client.chats.apply({ chatId, rev })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("rehaga") });
    // Aunque la fila no lo supiera todavía, la corrida no aplica sobre una punta que no calza.
    store.db.$client.prepare("UPDATE pull_requests SET head_sha = (SELECT base_sha FROM pr_chat_proposals) WHERE id = ?").run(a);

    const { snapshot, run } = await apply(a, chatId, rev);

    expect(run.steps.map((s) => [s.nodeId, s.outcome])).toEqual([["ws", "ok"], ["apply", "stale"]]);
    expect(snapshot.proposal?.status).toBe("stale");
    expect(remoteSha("cla-1")).toBe(moved);
    expect(snapshot.messages.at(-1)!.text).toContain("rehaga");
  });

  test("checks rojos: el dev los arregla y la propuesta sale con el arreglo", async () => {
    commit("cla-1", "main", { "one.txt": "uno\n" });
    const a = remotePr("cla-1", "main");
    chatScript(1, { "one.txt": "uno TODO\n" }, "Deja un TODO");
    writeFileSync(join(fixtures, "dev.r1.fix.yaml"), `match: { mode: fix, round: "*" }\neffects:\n  - write:\n      path: one.txt\n      content: "uno listo\\n"\nresult:\n  status: success\n  structured:\n    outcome: ok\n    summary: "Saco el TODO"\n    payload:\n      files: [one.txt]\n      rejected: []\n      deletedTests: []\n      cuts: []\n`);
    await boot();
    const { chatId, rev } = await propose(a, "deja un TODO");

    const { snapshot, run } = await apply(a, chatId, rev);

    expect(run.steps.map((s) => [s.nodeId, s.outcome]).slice(0, 5)).toEqual([["ws", "ok"], ["apply", "ok"], ["checks", "fail"], ["fix", "ok"], ["checks", "ok"]]);
    expect(snapshot.proposal?.status).toBe("applied");
    expect(repo.git("--git-dir", repo.remoteDir!, "show", "cla-1:one.txt")).toBe("uno listo");
  });
});
