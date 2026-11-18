import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPROVE_LOCAL_PUBLISH, createClient, DECLINE_LOCAL_PUBLISH, RunId } from "@clanker/api";
import { hashUiKey, isolatedUiKey } from "@clanker/api/node";
import { createConnections, createFileSecrets, createRepos, createWorkspaces, newId, openStore } from "@clanker/core";
import { seedPr } from "@clanker/core/testing";
import { Client as McpClient, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, test, vi } from "vitest";
import { tempGitRepo } from "./git";
import { startGitHttpServer } from "./git-http";
import { startGitHubSim } from "./github-sim";
import { labeledFake } from "./labeled-fake";
import { startCore } from "./start-core";

const LOGIN = "octocat";
const REPO = "octocat/demo";
const TOKEN = "github_pat_LOCAL_TEST";
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup(check = "true") {
  const dir = mkdtempSync(join(tmpdir(), "clanker-local-publish-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const fixtures = join(dir, "fixtures");
  mkdirSync(fixtures);
  const workRepo = tempGitRepo({
    remote: true,
    commits: [{ message: "chore: base", files: { ".clanker/recipe.json": JSON.stringify({ version: 1, commands: { test: check }, checks: ["test"] }) } }],
  });
  cleanup.push(workRepo.cleanup);
  workRepo.git("--git-dir", workRepo.remoteDir!, "config", "http.receivepack", "true");
  const git = await startGitHttpServer(workRepo.remoteDir!, { user: LOGIN, password: TOKEN });
  cleanup.push(git.close);
  const github = await startGitHubSim({ origin: workRepo, repo: REPO, account: LOGIN, token: TOKEN });
  cleanup.push(github.close);
  const store = openStore({ path: join(dir, "clanker.db") });
  cleanup.push(store.close);
  const repoConfig = () => ({ path: workRepo.dir, defaultBranch: "main" });
  const repoId = createRepos({ store }).add({ name: "demo", path: workRepo.dir, remote: REPO });
  const workspaces = createWorkspaces({
    store, dataDir: dir, repoConfig, identityOf: async () => ({ name: "Clanker Test", email: "test@clanker.invalid" }),
  });
  const ws = await workspaces.acquire({ repo: repoId, branch: "local-pr", base: "main", runId: newId("run") });
  writeFileSync(join(ws.path, "feature.txt"), "feature\n");
  workRepo.git("-C", ws.path, "add", "feature.txt");
  workRepo.git("-C", ws.path, "commit", "-m", "feat: local");
  const head = workRepo.git("-C", ws.path, "rev-parse", "HEAD");
  workspaces.release(ws);
  const id = seedPr(store, { state: "local", repoId, headRef: ws.branch, number: null, title: "Función local", body: "Descripción", headSha: head, isDraft: true });
  const connections = createConnections({ store, secrets: createFileSecrets({ dir: join(dir, "secrets") }), github: { baseUrl: github.baseUrl } });
  await connections.connect({ provider: "github", account: LOGIN, scopes: [], token: TOKEN }, "core");
  const uiKey = isolatedUiKey(dir);
  const core = await startCore({
    store, dataDir: dir, connections, scheduler: false, gitUrl: () => git.url, coreVersion: "test",
    runtimes: [labeledFake("claude-sdk", { fixtures, speed: Infinity })],
    onShutdown: () => {}, uiKeyHash: hashUiKey(uiKey),
  });
  cleanup.push(() => core.close());
  const clientOpts = { url: core.server.url, token: core.server.token };
  return {
    id, head, ws, github,
    cli: createClient({ ...clientOpts, origin: "cli" }),
    ui: createClient({ ...clientOpts, origin: "ui", uiKey }),
    untrustedUi: createClient({ ...clientOpts, origin: "ui" }),
    mcp: async () => {
      const mcp = new McpClient({ name: "test", version: "0.0.0" });
      cleanup.push(() => mcp.close());
      const url = new URL("/mcp", core.server.url);
      await mcp.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${core.server.token}` } } }));
      return mcp;
    },
    remoteHead: () => workRepo.git("--git-dir", workRepo.remoteDir!, "rev-parse", `refs/heads/${ws.branch}`),
  };
}

test("MCP y CLI solo solicitan; la app aprueba el borrador exacto sin cambiar el id", async () => {
  const h = await setup();
  const mcp = await h.mcp();
  const request = await mcp.callTool({ name: "request_local_pr_publish", arguments: { id: h.id } });
  expect(request.isError).not.toBe(true);
  const { decisionId } = await h.cli.prs.requestLocalPublish({ id: h.id });
  expect(request.content).toEqual([{ type: "text", text: expect.stringContaining(decisionId) }]);
  expect(await h.ui.decisions.get({ id: decisionId })).toMatchObject({ status: "pending", runId: null, options: [APPROVE_LOCAL_PUBLISH, DECLINE_LOCAL_PUBLISH] });
  const input = { id: decisionId, option: APPROVE_LOCAL_PUBLISH };
  await expect(h.cli.decisions.resolve(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(h.untrustedUi.decisions.resolve(input)).rejects.toMatchObject({ status: 403 });
  expect(await mcp.callTool({ name: "resolve_decision", arguments: input })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("FORBIDDEN") }] });
  expect(h.github.requests).toEqual([]);
  expect(h.remoteHead).toThrow();

  const settled = await Promise.allSettled([h.ui.decisions.resolve(input), h.ui.decisions.resolve(input)]);
  const approved = settled.find((answer) => answer.status === "fulfilled")?.value;
  expect(settled.filter((answer) => answer.status === "fulfilled")).toHaveLength(1);
  expect(approved).toMatchObject({ status: "answered", resolvedBy: "ui", runId: expect.any(String) });
  await vi.waitFor(async () => expect(await h.cli.runs.get({ id: approved!.runId! })).toMatchObject({ status: "done" }), { timeout: 10_000 });
  expect(h.remoteHead()).toBe(h.head);
  const [published] = await h.cli.prs.list({ ids: [h.id] });
  expect(published).toMatchObject({ id: h.id, local: null, ref: { account: LOGIN, repo: REPO, number: expect.any(Number) } });
  expect(h.github.requests.filter((r) => r.method === "POST" && r.path.endsWith("/pulls"))).toHaveLength(1);
});

test("si cambia la descripción exige otra aprobación; rechazarla no crea corridas", async () => {
  const h = await setup();
  const { decisionId } = await h.cli.prs.requestLocalPublish({ id: h.id });
  await h.cli.prs.updateLocal({ id: h.id, body: "" });
  await expect(h.ui.decisions.resolve({ id: decisionId, option: APPROVE_LOCAL_PUBLISH })).rejects.toThrow("cambió");
  const fresh = await h.cli.prs.requestLocalPublish({ id: h.id });
  expect(fresh.decisionId).not.toBe(decisionId);
  expect(await h.ui.decisions.get({ id: decisionId })).toMatchObject({ status: "superseded" });
  expect(await h.ui.decisions.resolve({ id: fresh.decisionId, option: DECLINE_LOCAL_PUBLISH })).toMatchObject({ status: "answered", runId: null });
  expect(await h.cli.runs.list({})).toEqual([]);
  expect(h.remoteHead).toThrow();
});

test("un patch mueve la punta solo en la máquina e invalida una solicitud previa", async () => {
  const h = await setup();
  const { decisionId } = await h.cli.prs.requestLocalPublish({ id: h.id });
  const patch = "diff --git a/feature.txt b/feature.txt\n--- a/feature.txt\n+++ b/feature.txt\n@@ -1 +1 @@\n-feature\n+revisado\n";
  const { runId } = await h.cli.prs.applyLocalPatch({ id: h.id, head: h.head, patch });
  await vi.waitFor(async () => expect(await h.cli.runs.get({ id: runId })).toMatchObject({ status: "done" }), { timeout: 10_000 });
  const detail = await h.cli.prs.localDetail({ id: h.id });
  expect(detail.head).not.toBe(h.head);
  expect(detail.commits.map(({ sha }) => sha)).toEqual([h.head, detail.head]);
  expect(detail.patch).toContain("+revisado");
  await expect(h.ui.decisions.resolve({ id: decisionId, option: APPROVE_LOCAL_PUBLISH })).rejects.toThrow("cambió");
  expect(h.remoteHead).toThrow();
});

test.each(["false", "echo no aprobado >> feature.txt"])("un check fallido o que altera el worktree no publica: %s", async (check) => {
  const h = await setup(check);
  const { decisionId } = await h.cli.prs.requestLocalPublish({ id: h.id });
  const { runId } = await h.ui.decisions.resolve({ id: decisionId, option: APPROVE_LOCAL_PUBLISH });
  const id = RunId.parse(runId);
  await vi.waitFor(async () => expect(await h.cli.runs.get({ id })).toMatchObject({ status: "failed" }), { timeout: 10_000 });
  expect(h.remoteHead).toThrow();
  expect(h.github.requests.filter((r) => r.method === "POST")).toEqual([]);
});
