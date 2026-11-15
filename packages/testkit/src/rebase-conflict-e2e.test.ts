import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunId } from "@clanker/api";
import { afterEach, describe, expect, test, vi } from "vitest";
import { REPO, startTechleadScenario, type BotTurn, type TechleadScenario } from "./techlead-scenario";

// La plantilla "Rebase por conflicto" (`rebase-conflicto`, `docs/design.html#d-flows`) de punta a punta: una
// issue publica su PR con `techlead-clasico`, la base se mueve y deja el PR en conflicto, el evento
// `pr.conflict` arranca el flujo en el core real y el dev fake (`fixtures/runs/rebase-conflicto`) lo resuelve.
// Todo contra el GitHub simulado y un remoto git real, sin ningún LLM.

vi.setConfig({ testTimeout: 60_000 });

const fixtures = (name: string) => join(dirname(fileURLToPath(import.meta.url)), "../fixtures/runs/rebase-conflicto", name);

/** Lo que el bot contesta a los dos `/review` del techlead y al de después del rebase. */
const BOT: BotTurn[] = [{ findings: ["Falta incluir el monto en el mensaje del error"] }, "lgtm", "lgtm"];

let scenario: TechleadScenario | undefined;
afterEach(async () => {
  await scenario?.cleanup();
  scenario = undefined;
});

/** El PR de la issue ya publicado, y la base movida con un `src/transfer.ts` que choca con el suyo. */
async function conflictedPr(options: { fixtures: string; draft: boolean; flowParams?: Record<string, unknown> }) {
  scenario = await startTechleadScenario({ bot: BOT, fixtures: [fixtures(options.fixtures)] });
  const { client, store, repo, github, project } = scenario;
  const { run } = await scenario.run();
  expect(await scenario.finished(run.id)).toMatchObject({ status: "done" });
  if (options.flowParams) await client.projects.update({ id: project.id, flowParams: options.flowParams });
  if (!options.draft) scenario.pr().setDraft(false);

  const branch = github.pulls()[0]!.head.ref;
  const published = scenario.remoteLog(branch);
  writeFileSync(join(repo.dir, "src/transfer.ts"), 'export function createTransfer(amount: number) {\n  return { amount, status: "pending" };\n}\n');
  repo.git("add", "--all");
  repo.git("commit", "--quiet", "--message", "feat: transfers start pending");
  repo.git("push", "--quiet", "origin", "main");
  const main = repo.git("rev-parse", "HEAD");

  // Lo que Watch emite al ver el PR en conflicto; `stack.restack` anota el mismo evento.
  const pr = store.db.$client.prepare("SELECT id FROM pull_requests").get() as { id: string };
  store.tx((tx) =>
    tx.emit({
      type: "pr.conflict",
      origin: "watch",
      projectId: project.id,
      subject: { type: "pr", id: pr.id },
      payload: { repo: REPO, number: 1, sha: published[0]!.sha, base: "main" },
    }),
  );
  const started = store.db.$client
    .prepare("SELECT runs.id FROM runs JOIN defs ON defs.id = runs.flow_def_id WHERE defs.slug = 'rebase-conflicto'")
    .all() as { id: string }[];
  expect(started).toHaveLength(1);
  return { branch, published, main, runId: started[0]!.id as RunId };
}

const nodesOf = (run: { steps: { nodeId: string; outcome: string | null }[] }) => run.steps.map((s) => [s.nodeId, s.outcome]);
const noteTitles = (runId: RunId) => scenario!.store.events.since(0, { types: ["decision.opened"], runId }).map((e) => (e.payload as { title: string }).title);

describe("rebase-conflicto con el core real", () => {
  test("un PR en draft con el conflicto resuelto queda sobre la base, pusheado con lease, y sigue con pr-feedback", async () => {
    const { branch, main, runId } = await conflictedPr({ fixtures: "resolved", draft: true });
    const { repo, github } = scenario!;

    const run = await scenario!.finished(runId);

    expect(run).toMatchObject({ status: "done", outcome: "done", flow: { slug: "rebase-conflicto" }, lane: "maintenance" });
    // Los params salen del trigger: el PR, su repo, su branch y la base del evento.
    expect(run.params).toMatchObject({ pr: { account: "acme", repo: REPO, number: 1 }, branch, base: "main", rebaseNonDraft: "auto" });
    expect(nodesOf(run).filter(([node]) => !String(node).startsWith("lr-"))).toEqual([
      ["ws", "ok"],
      ["rebase", "conflict"],
      ["resolve", "resolved"],
      ["policy", "proceed"],
      ["continue", "clean"],
      ["checks", "ok"],
      ["commit", "ok"],
      ["push", "draft"],
      ["feedback", "done"],
    ]);

    // Los dos commits del PR sobre la punta nueva de la base, con el conflicto resuelto juntando los dos lados.
    const after = scenario!.remoteLog(branch);
    expect(after.map((c) => c.subject)).toEqual(["test(transfers): log a created transfer", "feat(transfers): validate and round the transfer amount"]);
    expect(repo.git("--git-dir", repo.remoteDir!, "merge-base", "main", branch)).toBe(main);
    const merged = repo.git("--git-dir", repo.remoteDir!, "show", `${branch}:src/transfer.ts`);
    expect(merged).toContain('status: "pending"');
    expect(merged).toContain("amount must be positive");
    expect(merged).not.toContain("<<<<<<<");

    // Ya no hay conflicto en GitHub, y el PR sigue en draft: el flujo de feedback le pidió `/review` otra vez.
    expect(github.pulls()[0]).toMatchObject({ draft: true, state: "open" });
    expect(scenario!.pr().node().comments.map((c) => c.body.split("\n")[0])).toEqual(["/review", "/review", "/review"]);
    expect(scenario!.pr().node().mergeable).toBe("MERGEABLE");
    expect(noteTitles(runId)).toEqual([]);

    // El worktree queda suelto y sin un rebase detenido.
    expect(scenario!.store.db.$client.prepare("SELECT state, holder_run_id AS holder FROM workspaces").all()).toEqual([{ state: "idle", holder: null }]);
  });

  test("con behavior en un PR draft deja aplicada la resolución conservadora, sigue y deja una nota que no bloquea", async () => {
    const { branch, main, runId } = await conflictedPr({ fixtures: "behavior", draft: true });

    const run = await scenario!.finished(runId);

    expect(run).toMatchObject({ status: "done", outcome: "done" });
    expect(nodesOf(run).filter(([node]) => !String(node).startsWith("lr-")).slice(0, 6)).toEqual([
      ["ws", "ok"],
      ["rebase", "conflict"],
      ["resolve", "behavior"],
      ["behavior-check", "proceed"],
      ["continue", "clean"],
      ["checks", "ok"],
    ]);
    // La nota del agente y la del flujo: ninguna estaciona la corrida.
    expect(noteTitles(runId)).toEqual(["Estado inicial de la transfer", "Resolver el conflicto exigía decidir comportamiento: se aplicó la resolución más conservadora, revísala"]);
    expect(scenario!.repo.git("--git-dir", scenario!.repo.remoteDir!, "merge-base", "main", branch)).toBe(main);
    expect(scenario!.store.events.since(0, { types: ["run.parked"], runId })).toEqual([]);
  });

  test("con behavior en un PR fuera de draft estaciona solo esa corrida, sin pushear, y seguir deja la nota de pedir /review", async () => {
    const { branch, published, main, runId } = await conflictedPr({ fixtures: "behavior", draft: false });
    const { client, repo, store } = scenario!;

    const parked = await scenario!.finished(runId);

    expect(parked.status).toBe("parked");
    expect(nodesOf(parked).slice(0, 5)).toEqual([
      ["ws", "ok"],
      ["rebase", "conflict"],
      ["resolve", "behavior"],
      ["behavior-check", "ask"],
      ["behavior-gate", null],
    ]);
    const [gate] = await client.decisions.list({ runId: runId, status: ["pending"] });
    expect(gate).toMatchObject({ kind: "gate", options: ["continue", "abort"] });
    // El PR sigue en conflicto, en el remoto y en GitHub: nada se pusheó.
    expect(scenario!.remoteLog(branch)).toEqual(published);
    expect(scenario!.pr().node().mergeable).toBe("CONFLICTING");
    expect(store.events.since(0, { types: ["run.parked"], runId }).map((e) => e.payload)).toMatchObject([{ reason: "gate", decisionId: gate!.id }]);

    await client.decisions.resolve({ id: gate!.id, option: "continue" });
    await vi.waitFor(async () => expect((await client.runs.get({ id: runId })).status).toBe("done"), { timeout: 20_000, interval: 100 });

    const run = await client.runs.get({ id: runId });
    expect(nodesOf(run).slice(4)).toEqual([
      ["behavior-gate", "continue"],
      ["continue", "clean"],
      ["checks", "ok"],
      ["commit", "ok"],
      ["push", "ready"],
    ]);
    expect(repo.git("--git-dir", repo.remoteDir!, "merge-base", "main", branch)).toBe(main);
    // Fuera de draft no hay pr-feedback: queda la nota para que alguien pida `/review`.
    expect(noteTitles(runId)).toContain("Pide /review: el PR salió del conflicto y ya no está en draft");
    expect(scenario!.pr().node().comments.map((c) => c.body.split("\n")[0])).toEqual(["/review", "/review"]);
  });

  test("con rebaseNonDraft: ask del proyecto, un PR fuera de draft pregunta aunque no haya behavior, y abort deja el PR como estaba", async () => {
    const { branch, published, runId } = await conflictedPr({ fixtures: "resolved", draft: false, flowParams: { rebaseNonDraft: "ask" } });
    const { client, store } = scenario!;

    const parked = await scenario!.finished(runId);

    expect(parked.params).toMatchObject({ rebaseNonDraft: "ask" });
    expect(nodesOf(parked).slice(2)).toEqual([
      ["resolve", "resolved"],
      ["policy", "ask"],
      ["ask", null],
    ]);
    const [gate] = await client.decisions.list({ runId: runId, status: ["pending"] });
    expect(gate).toMatchObject({ kind: "gate", options: ["continue", "abort"] });

    await client.decisions.resolve({ id: gate!.id, option: "abort" });
    await vi.waitFor(async () => expect(["parked", "running", "queued"]).not.toContain((await client.runs.get({ id: runId })).status), { timeout: 20_000, interval: 100 });

    const run = await client.runs.get({ id: runId });
    expect(run.outcome).toBe("blocked");
    expect(nodesOf(run).slice(4)).toEqual([
      ["ask", "abort"],
      ["abort", "ok"],
    ]);
    // El rebase detenido se abortó: el worktree está limpio, en la branch del PR y en su punta de siempre.
    const { path } = store.db.$client.prepare("SELECT path FROM workspaces").get() as { path: string };
    const git = (...args: string[]) => scenario!.repo.git("-C", path, ...args);
    expect(git("status", "--porcelain")).toBe("");
    expect(git("symbolic-ref", "--short", "HEAD")).toBe(branch);
    expect(git("rev-parse", "HEAD")).toBe(published[0]!.sha);
    expect(scenario!.remoteLog(branch)).toEqual(published);
  });
});
