import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RunId } from "@clanker/api";
import { newId } from "@clanker/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ACCOUNT, REPO, startTechleadScenario, type TechleadScenario } from "./techlead-scenario";

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

  const repoId = (store.db.$client.prepare("SELECT id FROM repos").get() as { id: string }).id;
  const insert = store.db.$client.prepare(
    "INSERT INTO pull_requests (id, repo_id, number, node_id, head_ref, base_ref, head_sha, state, is_draft, owned) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, 1)",
  );
  const rows = [1, 2, 3].map(() => newId("pr"));
  const specs = [
    { head: "cla-1", base: "main", draft: true },
    { head: "cla-2", base: "cla-1", draft: draft.second },
    { head: "cla-3", base: "cla-2", draft: draft.third },
  ];
  specs.forEach(({ head, base, draft: isDraft }, index) => {
    const pr = github.openPr({ head, base, title: head, draft: isDraft });
    expect(pr.number).toBe(index + 1);
    insert.run(rows[index]!, repoId, pr.number, `PR_${pr.number}`, head, base, pr.headSha(), isDraft ? 1 : 0);
  });
  store.db.$client.prepare("INSERT INTO pr_parents (child_id, parent_id) VALUES (?, ?), (?, ?)").run(rows[1]!, rows[0]!, rows[2]!, rows[1]!);

  const remoteSha = (branch: string) => repo.git("--git-dir", repo.remoteDir!, "rev-parse", `refs/heads/${branch}`);
  const remoteLog = (range: string) => repo.git("--git-dir", repo.remoteDir!, "log", "--format=%s", range).split("\n").filter(Boolean);

  /** Lo que Watch emite para el PR 1 (`pr.merged` con el squash ya en `main`, o `pr.base_rewritten` tras un amend) y la corrida que arranca. */
  async function emit(event: "pr.merged" | "pr.base_rewritten") {
    let payload: Record<string, unknown>;
    if (event === "pr.merged") {
      git("checkout", "--quiet", "-B", "main", "origin/main");
      git("merge", "--squash", "--quiet", "origin/cla-1");
      git("commit", "--quiet", "--message", "feat: cla-1 (#1)");
      git("push", "--quiet", "origin", "main");
      github.pr(1).merge({ sha: git("rev-parse", "HEAD") });
      payload = { repo: REPO, number: 1 };
    } else {
      const from = remoteSha("cla-1");
      git("checkout", "--quiet", "cla-1");
      writeFileSync(join(clone, "one.txt"), "one v2\n");
      git("add", "--all");
      git("commit", "--quiet", "--amend", "--message", "feat: cla-1 (reescrito)");
      git("push", "--quiet", "--force", "origin", "cla-1");
      payload = { repo: REPO, number: 1, from, to: remoteSha("cla-1") };
    }
    store.tx((tx) => tx.emit({ type: event, origin: "watch", projectId: scenario!.project.id, subject: { type: "pr", id: rows[0]! }, payload }));
    const started = store.db.$client
      .prepare("SELECT runs.id FROM runs JOIN defs ON defs.id = runs.flow_def_id WHERE defs.slug = ?")
      .all(event === "pr.merged" ? "restack" : "restack-rewritten") as { id: string }[];
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
  test("mergear el PR de abajo restackea la cadena y solo el draft que se pusheó pide /review", async () => {
    const { emit, feedbackRuns, comments, remoteLog } = await chain({ second: true, third: false });

    const run = await emit("pr.merged");

    expect(run).toMatchObject({ status: "done", outcome: "done", flow: { slug: "restack" }, lane: "maintenance" });
    expect(run.params).toMatchObject({ pr: ref(1), externalRounds: 3 });
    expect(run.steps.map((s) => [s.nodeId, s.outcome])).toEqual([
      ["restack", "ok"],
      ["feedback", "done"],
      ["feedback[0]", "done"],
    ]);

    // Los dos PRs de arriba quedaron sobre el squash del de abajo, con sus commits propios; el tercero sigue sobre el segundo.
    expect(remoteLog("main..cla-3")).toEqual(["feat: cla-3", "feat: cla-2"]);
    const { github } = scenario!;
    expect(github.pulls().map((p) => [p.number, p.base.ref])).toEqual([[1, "main"], [2, "main"], [3, "cla-2"]]);

    // El tercero también se restackeó, pero está listo: no vuelve a pedir review. El segundo pasó por pr-feedback.
    expect(feedbackRuns()).toEqual({
      prs: [2],
      outcomes: [["restack-feedback", "done"], ["pr-feedback", "done"]],
      agentSteps: 0,
    });
    expect(comments(2)).toEqual(["/review"]);
    expect(comments(3)).toEqual([]);
    expect(github.pulls()[1]).toMatchObject({ number: 2, draft: true });
  });

  test("un draft nieto toma su worktree de la branch de su padre y es el único que pide /review", async () => {
    const { emit, feedbackRuns, comments, remoteLog } = await chain({ second: false, third: true });

    const run = await emit("pr.merged");

    expect(run).toMatchObject({ status: "done", outcome: "done" });
    expect(remoteLog("main..cla-3")).toEqual(["feat: cla-3", "feat: cla-2"]);
    expect(feedbackRuns().prs).toEqual([3]);
    expect(comments(2)).toEqual([]);
    expect(comments(3)).toEqual(["/review"]);
    // El worktree del nieto quedó sobre la punta nueva del padre, sin un rebase detenido.
    const { path } = scenario!.store.db.$client.prepare("SELECT path FROM workspaces WHERE branch = 'cla-3'").get() as { path: string };
    expect(scenario!.repo.git("-C", path, "status", "--porcelain")).toBe("");
    expect(scenario!.repo.git("-C", path, "rev-parse", "HEAD")).toBe(scenario!.repo.git("--git-dir", scenario!.repo.remoteDir!, "rev-parse", "refs/heads/cla-3"));
  });

  test("sin drafts que cambien el flujo termina sin ninguna rama de feedback ni agentes", async () => {
    const { emit, feedbackRuns, comments, remoteLog } = await chain({ second: false, third: false });

    const run = await emit("pr.merged");

    expect(run).toMatchObject({ status: "done", outcome: "done" });
    expect(run.steps.map((s) => [s.nodeId, s.outcome])).toEqual([
      ["restack", "ok"],
      ["feedback", "done"],
    ]);
    expect(remoteLog("main..cla-3")).toEqual(["feat: cla-3", "feat: cla-2"]);
    expect(feedbackRuns()).toEqual({ prs: [], outcomes: [], agentSteps: 0 });
    expect([comments(2), comments(3)]).toEqual([[], []]);
  });
});

describe("restack-rewritten con el core real", () => {
  test("reescribir la branch del PR de abajo restackea a los de arriba y pide /review solo al draft que se pusheó", async () => {
    const { emit, feedbackRuns, comments, remoteLog, remoteSha, rows } = await chain({ second: true, third: false });
    const before = remoteSha("cla-2");

    const run = await emit("pr.base_rewritten");

    expect(run).toMatchObject({ status: "done", outcome: "done", flow: { slug: "restack-rewritten" } });
    expect(remoteSha("cla-2")).not.toBe(before);
    expect(remoteLog("cla-1..cla-3")).toEqual(["feat: cla-3", "feat: cla-2"]);
    expect(feedbackRuns().prs).toEqual([2]);
    expect(comments(2)).toEqual(["/review"]);
    expect(comments(3)).toEqual([]);
    // La base de los hijos no cambia: siguen colgando del PR reescrito.
    const parents = scenario!.store.db.$client.prepare("SELECT child_id, parent_id FROM pr_parents ORDER BY child_id").all();
    expect(parents).toHaveLength(2);
    expect(parents).toContainEqual({ child_id: rows[1], parent_id: rows[0] });
  });
});
