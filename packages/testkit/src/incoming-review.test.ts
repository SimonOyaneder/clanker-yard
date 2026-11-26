import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@clanker/api";
import { createConnections, createFileSecrets, createRepos, openStore, type Core } from "@clanker/core";
import { expect, test, vi } from "vitest";
import { createFakeRuntime } from "./fake-runtime";
import { tempGitRepo } from "./git";
import { seedDb } from "./home";
import { startCore } from "./start-core";

test("dos arranques del core real: Watch retoma la espera y completa la review sobre un PR ajeno", async () => {
  const home = seedDb("empty");
  const store = openStore({ path: home.dbPath });
  const repo = tempGitRepo({ branches: { incoming: [{ message: "feat: add file", files: { "file.txt": "a\n" } }] }, remote: true });
  let core: Core | undefined;
  try {
    const remote = "example/incoming-test";
    const account = "viewer";
    const head = repo.git("rev-parse", "incoming");
    const base = repo.git("rev-parse", "main");
    const first = vi.fn();
    const written: string[] = [];
    let reviewState: "draft" | "published" = "draft";
    let prState = "OPEN";
    const connections = createConnections({ store, secrets: createFileSecrets({ dir: home.path }), github: { fetch: async (url, options) => {
      const route = new URL(String(url));
      if (route.pathname === "/search/issues") {
        const incoming = route.searchParams.get("q")?.includes("review-requested:@me");
        return Response.json({ items: incoming ? [{ number: 1 }] : [], total_count: incoming ? 1 : 0 });
      }
      if (route.pathname === "/graphql") {
        const { query, variables } = JSON.parse(String(options?.body)) as { query: string; variables: { body?: string; review?: string; q?: string; account?: string } };
        const inboxPr = { number: 1, isDraft: true, viewerDidAuthor: false, state: prState, title: "Add file", url: `https://github.com/${remote}/pull/1`,
          repository: { nameWithOwner: remote }, draft: { totalCount: Number(reviewState === "draft") },
          published: { totalCount: Number(reviewState === "published") } };
        if (query.includes("query InboxSearch")) {
          expect(variables.account).toBe(account);
          const match = variables.q?.includes(reviewState === "draft" ? "review-requested:" : "reviewed-by:");
          expect(variables.q).toContain("-author:@me");
          const unrelated = [
            { ...inboxPr, number: 2, url: `${inboxPr.url}2`, viewerDidAuthor: true },
            { ...inboxPr, number: 3, url: `${inboxPr.url}3`, timelineItems: { nodes: [{ requestedReviewer: {} }], pageInfo: { hasNextPage: false } } },
          ];
          return Response.json({ data: { search: { nodes: match && prState === "OPEN" ? [inboxPr, ...(variables.q?.includes("reviewed-by") ? unrelated : [])] : [],
            pageInfo: { hasNextPage: false } } } });
        }
        if (query.includes("query InboxTracked")) return Response.json({ data: { p0: inboxPr } });
        if (query.includes("query IncomingRequest")) {
          first();
          return Response.json({ data: { repository: { pullRequest: { id: "pr", title: "Add file", body: "", state: "OPEN",
            headRefName: "incoming", baseRefName: "main", baseRefOid: base, headRefOid: head,
            reviewRequests: { nodes: [{ id: "assignment", requestedReviewer: { isViewer: true } }], pageInfo: { hasNextPage: false } },
            reviews: { nodes: [{ id: "my-draft", viewerDidAuthor: true }] },
          } } } });
        }
        if (query.includes("mutation IncomingFinding") && variables.review === "my-draft") {
          written.push(variables.body!);
          return Response.json({ data: { addPullRequestReviewThread: { thread: { id: "thread" } } } });
        }
      }
      if (options?.method === "GET" && route.pathname.startsWith(`/repos/${remote}/`)) return Response.json([]);
      throw new Error(`Request inesperada: ${String(url)}`);
    } } });
    await connections.connect({ provider: "github", account, scopes: [], token: "demo" }, "core");
    createRepos({ store }).add({ name: "incoming-test", path: repo.dir, remote });
    const fixtures = join(home.path, "fixtures");
    mkdirSync(fixtures);
    for (const role of ["incoming-specialist", "incoming-lead"]) {
      const result = { outcome: "ok", summary: "revisado", payload: { findings: [{ path: "file.txt", line: 1, comment: "comentario pendiente", evidence: "file.txt:1" }] } };
      writeFileSync(join(fixtures, `${role}.r0.yaml`), JSON.stringify({ match: { mode: "review" }, events: [], result: { status: "success", structured: result } }));
    }
    for (const area of ["bugs", "patterns", "ops", "lead", "voz"]) writeFileSync(join(fixtures, `${area}.md`), area);
    const boot = () => startCore({
      store, dataDir: home.path, connections, gitUrl: () => `file://${repo.remoteDir}`, watch: true, scheduler: false,
      incomingReview: { repos: [remote], references: fixtures }, runtimes: [createFakeRuntime({ fixtures, speed: Infinity })],
      env: { CORE_RUNTIME: "fake" }, coreVersion: "0.0.0", onShutdown() {},
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    core = await boot();
    await vi.waitFor(() => expect(first).toHaveBeenCalled(), { timeout: 10_000 });
    await core.close();
    expect(written).toEqual([]);
    vi.setSystemTime(Date.now() + 300_001);
    core = await boot();
    const client = createClient({ url: core.server.url, token: core.server.token, origin: "cli" });
    await vi.waitFor(async () => {
      const [run] = await client.runs.list({});
      expect(run).toBeDefined();
      const detail = await client.runs.get({ id: run!.id });
      expect(detail.status, JSON.stringify(detail.steps.map((s) => [s.nodeId, s.status, s.error]))).toBe("done");
    }, { timeout: 12_000 });
    expect(written).toEqual(["comentario pendiente"]);
    expect((await client.prs.inbox({})).rows).toMatchObject([{ review: "draft", run: "done" }]);
    reviewState = "published";
    expect((await client.prs.inbox({})).rows).toMatchObject([{ review: "published", run: "done" }]);
    for (prState of ["MERGED", "CLOSED"]) expect((await client.prs.inbox({})).rows).toEqual([]);
    expect(repo.git("branch", "--show-current")).toBe("main");
  } finally {
    await core?.close();
    vi.useRealTimers();
    store.close();
    repo.cleanup();
    home.cleanup();
  }
}, 30_000);
