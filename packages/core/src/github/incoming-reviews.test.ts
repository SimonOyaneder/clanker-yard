import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { git } from "../git/git";
import { createRepos } from "../repos/repos";
import { incomingReviews } from "../store/schema";
import { harness, okReport } from "../testing/flows-harness";
import { createGitHubClient } from "./client";
import { createIncomingReviews } from "./incoming-reviews";
import { incomingTemplate } from "./incoming-template";

describe("review entrante desde Watch hasta el borrador", () => {
  test.each(["manual", "new", "stale", "withdrawn", "empty", "retry", "discarded"] as const)("desde la asignación: %s", async (scenario) => {
    const existing = scenario !== "new";
    let request = "request-1";
    let draft = existing ? "manual" : "";
    let head = "";
    let base = "";
    let creates = 0;
    const comments = ["comentario personal"];
    const finding = { path: "x.rb", line: 1, comment: "valida el resultado", evidence: "caso de entrada vacía" };
    let onLead: (() => Promise<void>) | undefined;
    let headReviews = 0;
    let transient = false;
    let incoming: ReturnType<typeof createIncomingReviews>;
    const h = harness({ roles: incomingTemplate.roles, workspaceOf: (id) => incoming.workspace(id), script: async (call) => {
      if (call.spec?.systemPrompt.includes("Lee lead.md") || call.prompt.includes("Lee lead.md")) {
        headReviews++;
        await onLead?.();
      }
      const findings = scenario === "empty" ? [] : [finding];
      if (scenario === "retry") findings.push({ ...finding, line: 2, comment: "segundo hallazgo" });
      return okReport({ findings });
    } });
    try {
      const path = join(h.home.dir, "repo");
      mkdirSync(path);
      await git(path, ["init", "-b", "main"]);
      const commit = (text: string) => git(path, ["-c", "user.name=Ana", "-c", "user.email=a@example.org", "commit", "--allow-empty", "-m", text]);
      await commit("base");
      base = await git(path, ["rev-parse", "HEAD"]);
      writeFileSync(join(path, "x.rb"), "example\n");
      await git(path, ["add", "x.rb"]);
      await commit("change");
      head = await git(path, ["rev-parse", "HEAD"]);
      onLead = async () => {
        if (headReviews !== 1) return;
        if (scenario === "stale") {
          await commit("push durante el council");
          head = await git(path, ["rev-parse", "HEAD"]);
        }
        if (scenario === "withdrawn") request = "otra solicitud";
        if (scenario === "discarded") draft = "";
      };
      const client = createGitHubClient({ tokens: { kind: "pat", token: async () => "demo" }, fetch: async (url, options) => {
        const json = (body: unknown) => Response.json(body);
        if (String(url).includes("/search/issues")) return json({ total_count: 1, items: [{ number: 17 }] });
        if (String(url).endsWith("/graphql")) {
          const vars = JSON.parse(String(options?.body)) as { query: string; variables: Record<string, string> };
          if (vars.query.includes("query IncomingRequest") && transient) {
            transient = false;
            comments.pop(); // se borró mientras el paso esperaba recuperar la conexión
            return new Response("red caída", { status: 503 });
          }
          if (vars.query.includes("query IncomingRequest")) return json({ data: { repository: { pullRequest: {
            state: "OPEN", id: "pr", headRefOid: head, baseRefOid: base, headRefName: "feature", baseRefName: "main", title: "PR ajeno", body: "",
            reviews: { nodes: draft ? [{ id: draft, viewerDidAuthor: true }] : [] },
            reviewRequests: { nodes: [{ id: request, requestedReviewer: { isViewer: true } }], pageInfo: { hasNextPage: false } },
          } } } });
          if (vars.query.includes("mutation IncomingDraft")) {
            creates++;
            draft = "created";
            return json({ data: { addPullRequestReview: { pullRequestReview: { id: draft } } } });
          }
          if (vars.query.includes("mutation IncomingFinding")) {
            expect(vars.variables.review).toBe(draft);
            comments.push(vars.variables.body!);
            if (scenario === "retry" && vars.variables.body === finding.comment) transient = true;
            return json({ data: { addPullRequestReviewThread: { thread: { id: "thread" } } } });
          }
        }
        if (String(url).includes("/repos/example/repo/")) return json([]);
        throw new Error(`Inesperado: ${String(url)}`);
      } });
      const repos = createRepos({ store: h.store, remote: (repo) => ({ url: path, repo, account: "ana" }) });
      repos.add({ name: "repo", path, remote: "example/repo" });
      const references = join(h.home.dir, "references");
      mkdirSync(references);
      for (const area of ["bugs", "ops", "tests", "patterns", "framework", "lead", "voz"]) {
        writeFileSync(join(references, `${area}.md`), area.repeat(5000)); // las rúbricas no caben inline en un brief
      }
      const service = () => createIncomingReviews({ store: h.store, artifacts: h.artifacts, dataDir: h.home.dir, references, reportsDir: h.home.dir, enabled: ["example/repo"], repos,
        connections: { githubClient: () => client }, workspaces: { fetch: async () => "ok", fetchPr: async () => "ok" } });
      incoming = service();
      h.flows.registerAction(incoming.snapshot);
      h.flows.registerAction({ ...incoming.draft, retry: { max: 2, backoffSec: [0] } });
      h.defs.save({ kind: "profile", slug: "incoming-medio", scope: "user", body: incomingTemplate.profiles["incoming-medio"]!, source: "ui" });
      h.save(incomingTemplate.flows[0]);
      await incoming.poll("ana", 0, h.flows);
      await service().poll("ana", 299_999, h.flows);
      const rows = () => h.store.db.select().from(incomingReviews).all();
      expect(rows()[0]?.runId).toBeNull();
      await service().poll("ana", 300_000, h.flows);
      const run = rows()[0]!.runId!;
      await h.finished(run);
      const aborted = scenario === "withdrawn" || scenario === "discarded";
      expect(h.flows.getRun(run).steps.map((s) => [s.nodeId, s.outcome, s.error])).toContainEqual(["draft", aborted ? "gone" : "ok", null]);
      expect(h.calls).toHaveLength(scenario === "stale" ? 14 : 7);
      expect(creates).toBe(existing ? 0 : 1);
      if (aborted || scenario === "empty") {
        expect(comments).toEqual(["comentario personal"]);
        return;
      }
      expect(comments).toEqual(["comentario personal", scenario === "retry" ? "segundo hallazgo" : finding.comment]);
      comments.pop(); // Simón filtró este hallazgo en GitHub.
      await commit("otro push");
      head = await git(path, ["rev-parse", "HEAD"]);
      await service().poll("ana", 600_000, h.flows);
      expect(rows().map((r) => r.runId)).toEqual([run]);
      expect(comments).toEqual(["comentario personal"]);
      request = "request-2";
      await incoming.poll("ana", 900_000, h.flows);
      expect(rows()).toHaveLength(2);
      expect(rows()[1]?.runId).toBeNull();
      await incoming.cleanup(run);
    } finally {
      await h.cleanup();
    }
  }, 30_000);
});
