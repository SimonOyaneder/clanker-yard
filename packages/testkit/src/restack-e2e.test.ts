import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FlowDef, RepoId, RunId } from "@clanker/api";
import { createWorkspaces, newId } from "@clanker/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ACCOUNT, REPO, startTechleadScenario, type TechleadScenario } from "./techlead-scenario";
import { seedPr } from "@clanker/core/testing";

// Las plantillas `restack` (`pr.merged`) y `restack-rewritten` (`pr.base_rewritten`) con su tramo de
// `/review` (`docs/design.html#d-flows`, plantillas) de punta a punta: una cadena de 3 PRs del sistema en el
// GitHub simulado y un remoto git real, el core real con el runtime fake y los eventos de Watch emitidos a mano.
// El bot contesta LGTM, así que ningún paso es de un agente: solo los drafts que el restack pushea piden `/review`.

vi.setConfig({ testTimeout: 60_000 });

let scenario: TechleadScenario | undefined;
let work: string | undefined;
afterEach(async () => {
  await scenario?.cleanup();
  scenario = undefined;
  if (work) rmSync(work, { recursive: true, force: true });
  work = undefined;
});

const ref = (number: number) => ({ account: ACCOUNT, repo: REPO, number });

/**
 * Tres PRs del sistema encadenados: `cla-1` sobre `main`, `cla-2` sobre `cla-1` y `cla-3` sobre `cla-2`. `draft`
 * dice cuáles de los dos de arriba están en draft. Como `pr.publish`, deja cada PR `owned` y `cla-2` y `cla-3`
 * colgando de su padre en `pr_parents`.
 */
async function chain(draft: { second: boolean; third: boolean }) {
  scenario = await startTechleadScenario({ watch: false, bot: ["lgtm", "lgtm"] });
  const { repo, github, store } = scenario;
  work = mkdtempSync(join(tmpdir(), "clanker-restack-e2e-"));
  const clone = join(work, "clone");
  repo.git("clone", "--quiet", repo.remoteDir!, clone);
  const git = (...args: string[]) => repo.git("-C", clone, ...args);

  /** Un commit de `branch` sobre la punta de `base` en el remoto, pusheado. */
  const commit = (branch: string, base: string, file: string, content: string) => {
    git("checkout", "--quiet", "-B", branch, `origin/${base}`);
    mkdirSync(dirname(join(clone, file)), { recursive: true });
    writeFileSync(join(clone, file), content);
    git("add", "--all");
    git("commit", "--quiet", "--message", `feat: ${branch}`);
    git("push", "--quiet", "--force", "origin", branch);
  };
  commit("cla-1", "main", "one.txt", "one\n");
  commit("cla-2", "cla-1", "two.txt", "two\n");
  commit("cla-3", "cla-2", "three.txt", "three\n");

  const repoId = (store.db.$client.prepare("SELECT id FROM repos").get() as { id: RepoId }).id;
  const specs = [
    { head: "cla-1", base: "main", draft: true },
    { head: "cla-2", base: "cla-1", draft: draft.second },
    { head: "cla-3", base: "cla-2", draft: draft.third },
  ];
  // Cada PR cuelga del anterior.
  const rows: string[] = [];
  specs.forEach(({ head, base, draft: isDraft }, index) => {
    const pr = github.openPr({ head, base, title: head, draft: isDraft });
    expect(pr.number).toBe(index + 1);
    rows.push(seedPr(store, { repoId, number: pr.number, headRef: head, baseRef: base, headSha: pr.headSha(), isDraft, parents: rows.slice(-1) }));
  });

  const remoteSha = (branch: string) => repo.git("--git-dir", repo.remoteDir!, "rev-parse", `refs/heads/${branch}`);
  const remoteLog = (range: string) => repo.git("--git-dir", repo.remoteDir!, "log", "--format=%s", range).split("\n").filter(Boolean);

  /**
   * Lo que Watch emite para el PR `number` (`pr.merged` con el squash ya en `main`, o `pr.base_rewritten` tras un
   * amend) y la corrida que arranca.
   */
  async function emit(event: "pr.merged" | "pr.base_rewritten", number = 1) {
    let payload: Record<string, unknown>;
    if (event === "pr.merged") {
      git("fetch", "--quiet", "origin");
      git("checkout", "--quiet", "-B", "main", "origin/main");
      git("merge", "--squash", "--quiet", `origin/cla-${number}`);
      git("commit", "--quiet", "--message", `feat: cla-${number} (#${number})`);
      git("push", "--quiet", "origin", "main");
      github.pr(number).merge({ sha: git("rev-parse", "HEAD") });
      payload = { repo: REPO, number };
    } else {
      const from = remoteSha("cla-1");
      git("checkout", "--quiet", "cla-1");
      writeFileSync(join(clone, "one.txt"), "one v2\n");
      git("add", "--all");
      git("commit", "--quiet", "--amend", "--message", "feat: cla-1 (reescrito)");
      git("push", "--quiet", "--force", "origin", "cla-1");
      payload = { repo: REPO, number: 1, from, to: remoteSha("cla-1") };
    }
    const subject = rows[number - 1]!;
    store.tx((tx) => tx.emit({ type: event, origin: "watch", projectId: scenario!.project.id, subject: { type: "pr", id: subject }, payload }));
    const started = store.db.$client
      .prepare("SELECT runs.id FROM runs JOIN defs ON defs.id = runs.flow_def_id WHERE defs.slug = ? AND runs.subject_id = ?")
      .all(event === "pr.merged" ? "restack" : "restack-rewritten", subject) as { id: string }[];
    expect(started).toHaveLength(1);
    return scenario!.finished(started[0]!.id as RunId);
  }

  /** Los PRs que pasaron por `restack-feedback` y los pasos de cada `pr-feedback` que corrió. */
  function feedbackRuns() {
    const children = store.db.$client
      .prepare(
        `SELECT runs.id, runs.params, runs.outcome, defs.slug FROM runs JOIN defs ON defs.id = runs.flow_def_id
         WHERE defs.slug IN ('restack-feedback', 'pr-feedback') ORDER BY runs.id`,
      )
      .all() as { id: string; params: string; outcome: string; slug: string }[];
    return {
      prs: children.filter((c) => c.slug === "restack-feedback").map((c) => (JSON.parse(c.params) as { pr: { number: number } }).pr.number),
      outcomes: children.map((c) => [c.slug, c.outcome]),
      agentSteps: (store.db.$client.prepare("SELECT count(*) AS n FROM step_runs WHERE node_id IN ('triage', 'fix', 'light', 'route', 'ci-triage')").get() as { n: number }).n,
    };
  }

  const comments = (number: number) => github.pr(number).node().comments.map((c) => c.body.split("\n")[0]);
  return { emit, feedbackRuns, comments, remoteSha, remoteLog, git, rows };
}

describe("restack con el core real", () => {
  test("mergear el PR de abajo restackea solo al que queda sobre main y solo el draft que se pusheó pide /review", async () => {
    const { emit, feedbackRuns, comments, remoteLog, remoteSha } = await chain({ second: true, third: false });
    const third = remoteSha("cla-3");

    const run = await emit("pr.merged");

    expect(run).toMatchObject({ status: "done", outcome: "done", flow: { slug: "restack" }, lane: "maintenance" });
    expect(run.params).toMatchObject({ pr: ref(1), externalRounds: 3 });
    expect(run.steps.map((s) => [s.nodeId, s.outcome])).toEqual([
      ["restack", "ok"],
      ["promote", "done"],
      ["feedback", "done"],
      ["feedback[0]", "done"],
    ]);

    // El segundo quedó sobre el squash del de abajo con su commit propio; el tercero no se pushea (su CI no corre).
    expect(remoteLog("main..cla-2")).toEqual(["feat: cla-2"]);
    expect(remoteSha("cla-3")).toBe(third);
    const { github } = scenario!;
    expect(github.pulls().map((p) => [p.number, p.base.ref])).toEqual([[1, "main"], [2, "main"], [3, "cla-2"]]);
    expect(feedbackRuns()).toEqual({
      prs: [2],
      outcomes: [["restack-feedback", "done"], ["pr-feedback", "done"]],
      agentSteps: 0,
    });
    expect(comments(2)).toEqual(["/review"]);
    expect(comments(3)).toEqual([]);
    expect(github.pulls()[1]).toMatchObject({ number: 2, draft: true });
  });

  test("un draft nieto espera a que se mergee su padre: entonces queda sobre main y es el único que pide /review", async () => {
    const { emit, feedbackRuns, comments, remoteLog, remoteSha } = await chain({ second: false, third: true });
    const third = remoteSha("cla-3");

    expect(await emit("pr.merged")).toMatchObject({ status: "done", outcome: "done" });
    expect(remoteSha("cla-3")).toBe(third);
    expect(feedbackRuns().prs).toEqual([]);

    const run = await emit("pr.merged", 2);

    expect(run).toMatchObject({ status: "done", outcome: "done" });
    expect(remoteLog("main..cla-3")).toEqual(["feat: cla-3"]);
    expect(scenario!.github.pulls().map((p) => [p.number, p.base.ref])).toEqual([[1, "main"], [2, "main"], [3, "main"]]);
    expect(feedbackRuns().prs).toEqual([3]);
    expect(comments(2)).toEqual([]);
    expect(comments(3)).toEqual(["/review"]);
    // El worktree del nieto quedó sobre su punta nueva, sin un rebase detenido.
    const { path } = scenario!.store.db.$client.prepare("SELECT path FROM workspaces WHERE branch = 'cla-3'").get() as { path: string };
    expect(scenario!.repo.git("-C", path, "status", "--porcelain")).toBe("");
    expect(scenario!.repo.git("-C", path, "rev-parse", "HEAD")).toBe(remoteSha("cla-3"));
  });

  test("sin drafts que cambien el flujo termina sin ninguna rama de feedback ni agentes", async () => {
    const { emit, feedbackRuns, comments, remoteLog } = await chain({ second: false, third: false });

    const run = await emit("pr.merged");

    expect(run).toMatchObject({ status: "done", outcome: "done" });
    expect(run.steps.map((s) => [s.nodeId, s.outcome])).toEqual([
      ["restack", "ok"],
      ["promote", "done"],
      ["feedback", "done"],
    ]);
    expect(remoteLog("main..cla-2")).toEqual(["feat: cla-2"]);
    expect(feedbackRuns()).toEqual({ prs: [], outcomes: [], agentSteps: 0 });
    expect([comments(2), comments(3)]).toEqual([[], []]);
  });
});

describe("restack-rewritten con el core real", () => {
  test("como subflujo con prId local omite pr y restackea al hijo sin publicarlo", async () => {
    scenario = await startTechleadScenario({ watch: false });
    const { repo, store, client, project, github, home } = scenario;
    const repoId = (store.db.$client.prepare("SELECT id FROM repos").get() as { id: RepoId }).id;
    repo.git("checkout", "--quiet", "-b", "root");
    writeFileSync(join(repo.dir, "root.txt"), "root\n");
    repo.git("add", "--all");
    repo.git("commit", "--quiet", "--message", "feat: root");
    repo.git("push", "--quiet", "origin", "root");
    const root = github.openPr({ head: "root" });
    const rootId = seedPr(store, { repoId, number: root.number, headRef: "root", headSha: root.headSha() });
    const workspaces = createWorkspaces({
      store,
      dataDir: home.path,
      repoConfig: () => ({ path: repo.dir, defaultBranch: "main" }),
      identityOf: async () => ({ name: "Ana Pérez", email: "ana@example.com" }),
    });
    const rows = [rootId];
    for (const [branch, base] of [["local-a", "root"], ["local-b", "local-a"]] as const) {
      const lease = await workspaces.acquire({ repo: repoId, branch, base, runId: newId("run") });
      writeFileSync(join(lease.path, `${branch}.txt`), `${branch}\n`);
      repo.git("-C", lease.path, "add", "--all");
      repo.git("-C", lease.path, "commit", "--quiet", "--message", `feat: ${branch}`);
      const head = repo.git("-C", lease.path, "rev-parse", "HEAD");
      workspaces.release(lease);
      rows.push(seedPr(store, { repoId, number: null, state: "local", headRef: branch, baseRef: base, headSha: head, title: branch, body: "", parents: rows.slice(-1) }));
    }
    const lease = await workspaces.acquire({ repo: repoId, branch: "local-a", base: "root", runId: newId("run") });
    const from = repo.git("-C", lease.path, "rev-parse", "HEAD");
    writeFileSync(join(lease.path, "local-a.txt"), "local-a v2\n");
    repo.git("-C", lease.path, "add", "--all");
    repo.git("-C", lease.path, "commit", "--quiet", "--amend", "--message", "feat: local-a v2");
    const to = repo.git("-C", lease.path, "rev-parse", "HEAD");
    workspaces.release(lease);
    store.db.$client.prepare("UPDATE pull_requests SET head_sha = ? WHERE id = ?").run(to, rows[1]!);
    const flow: FlowDef = {
      schema: 1,
      id: "restack-local-test",
      name: "Restack local test",
      trigger: { type: "manual" },
      params: { repo: "RepoRef", prId: "string", from: "string", to: "string" },
      start: "children",
      nodes: {
        children: {
          type: "flow",
          flow: "restack-rewritten",
          params: { repo: "$run.params.repo", prId: "$run.params.prId", from: "$run.params.from", to: "$run.params.to" },
          on: { done: "@done", blocked: "@blocked", failed: "@failed" },
        },
      },
    };
    await client.defs.create({ kind: "flow", slug: flow.id, scope: "user", body: flow });
    const issue = await client.issues.createLocal({ projectId: project.id, title: "Restack local" });
    const started = await client.runs.start({ projectId: project.id, issueId: issue.id, flow: flow.id, params: { repo: repoId, prId: rows[1]!, from, to } });

    const run = await scenario.finished(started.id);

    expect(run).toMatchObject({ status: "done", outcome: "done" });
    const child = store.db.$client
      .prepare("SELECT runs.params, runs.outcome FROM runs JOIN defs ON defs.id = runs.flow_def_id WHERE defs.slug = 'restack-rewritten'")
      .get() as { params: string; outcome: string };
    expect(child.outcome).toBe("done");
    expect(JSON.parse(child.params)).toMatchObject({ pr: null, prId: rows[1] });
    expect(repo.git("log", "--format=%s|%P", `${to}..local-b`)).toBe(`feat: local-b|${to}`);
    expect(github.pulls()).toHaveLength(1);
    expect(() => repo.git("--git-dir", repo.remoteDir!, "rev-parse", "refs/heads/local-b")).toThrow();
    expect(store.events.since(0, { types: ["pr.base_rewritten"] })).toEqual([]);
  });

  test("reescribir la branch del PR de abajo no pushea a los de arriba ni les pide /review", async () => {
    const { emit, feedbackRuns, comments, remoteSha, rows } = await chain({ second: true, third: false });
    const before = [remoteSha("cla-2"), remoteSha("cla-3")];

    const run = await emit("pr.base_rewritten");

    expect(run).toMatchObject({ status: "done", outcome: "done", flow: { slug: "restack-rewritten" } });
    expect([remoteSha("cla-2"), remoteSha("cla-3")]).toEqual(before);
    expect(feedbackRuns().prs).toEqual([]);
    expect([comments(2), comments(3)]).toEqual([[], []]);
    // Siguen colgando del PR reescrito: se restackean cuando se mergee.
    const parents = scenario!.store.db.$client.prepare("SELECT child_id, parent_id FROM pr_parents ORDER BY child_id").all();
    expect(parents).toHaveLength(2);
    expect(parents).toContainEqual({ child_id: rows[1], parent_id: rows[0] });
  });
});
