import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileJsonSchema, Role, type RunId } from "@clanker/api";
import {
  clankerLoopTemplate,
  createAgents,
  createArtifacts,
  createConnections,
  createDefs,
  createFileSecrets,
  createFlows,
  createPacks,
  createPrs,
  createRecipes,
  createSlots,
  createWorkspaces,
  openStore,
  prPushFixupsAction,
  prReplyAction,
  prWaits,
  reviewRequestBotAction,
  workspaceAcquireAction,
  workspaceSyncBaseAction,
  type Flows,
  type RunView,
  type Store,
} from "@clanker/core";
import { afterEach, describe, expect, test } from "vitest";
import { createFakeRuntime } from "./fake-runtime";
import { registerFlowStubs, type FlowStubsOptions } from "./flow-stubs";
import { tempGitRepo } from "./git";
import { startGitHubSim } from "./github-sim";

// Las plantillas de flujo de "equipo clanker-loop" (`techlead-clasico` y `pr-feedback`) con los roles de la
// plantilla, el runtime fake y acciones y waits stub: lo que ninguna implementación real todavía cubre.
// `pr.reply` y `review.requestBot` son las reales, contra el GitHub simulado (`startGitHubSim`) con un pack
// que tiene bot de review: el PR de los stubs (`acme/web#1`) existe ahí.

const fixtures = (...names: string[]) => names.map((name) => join(dirname(fileURLToPath(import.meta.url)), "../fixtures/runs/techlead-clasico", name));
const { flows: templates } = clankerLoopTemplate;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface SetupOptions extends FlowStubsOptions {
  fixtures?: string[];
  /** Registra las acciones reales que ya existen en el core en lugar de sus stubs. */
  real?: boolean;
  /**
   * Registra `pr.botReview` y `pr.ci` reales sobre el GitHub simulado en lugar de sus stubs. Las reviews
   * del bot que ya hay en el PR son anteriores a la petición, así que no cuentan: el bot da LGTM apenas
   * `review.requestBot` le pide la review.
   */
  waits?: boolean;
}

const BOT = "review-bot[bot]";
const PACK = {
  id: "acme",
  version: 1,
  activate: { githubOrgs: ["acme"] },
  reviewBot: {
    logins: [BOT],
    request: { type: "comment", body: "/review" },
    lgtm: { reviewState: "APPROVED" },
    resolvableAuthors: [BOT],
  },
  conventions: { commentPrefix: "[clanker] " },
};

async function setup(options: SetupOptions = {}) {
  const store = openStore({ path: ":memory:" });
  const dir = mkdtempSync(join(tmpdir(), "clanker-techlead-"));

  const origin = tempGitRepo({ remote: true, branches: { "cla-1": [{ message: "feat: algo", files: { "b.txt": "b\n" } }] } });
  const sim = await startGitHubSim({ origin, repo: "acme/web", account: "acme", token: "ghp_acme", bot: BOT });
  const connections = createConnections(store, createFileSecrets({ dir: join(dir, "secrets") }), { github: { baseUrl: sim.baseUrl } });
  await connections.connect({ provider: "github", account: "acme", scopes: [], token: "ghp_acme" }, "core");
  const defs = createDefs(store);
  const packs = createPacks({ defs });
  mkdirSync(join(dir, "pack"));
  writeFileSync(join(dir, "pack", "pack.json"), JSON.stringify(PACK));
  await packs.load(join(dir, "pack"));
  const pr = sim.openPr({ head: "cla-1", draft: true });

  const runtime = createFakeRuntime({ fixtures: options.fixtures ?? [], speed: Infinity });
  const agents = createAgents({ store, defs, runtime });
  for (const [slug, body] of Object.entries(clankerLoopTemplate.roles)) {
    defs.save({ kind: "role", slug, scope: "builtin", body, source: "import" });
  }
  defs.save({ kind: "profile", slug: "eco", scope: "builtin", body: clankerLoopTemplate.profiles.eco!, source: "import" });
  const artifacts = createArtifacts({ store, dir: join(dir, "artifacts") });
  const flows = createFlows({
    store,
    defs,
    agents,
    artifacts,
    roles: (id) => {
      const def = defs.resolve("role", id);
      if (!def) return undefined;
      const { modes } = Role.parse(def.body);
      return {
        modes: Object.fromEntries(
          Object.entries(modes).map(([name, m]) => [name, { outcomes: m.outcomes, payload: m.payload ? compileJsonSchema(m.payload) : undefined }]),
        ),
      };
    },
    workspaceOf: () => ({ path: dir, base: "main" }),
  });
  const unusedRepos = () => {
    throw new Error("no se usa");
  };
  const workspaces = createWorkspaces({
    store,
    dataDir: join(dir, "workspaces"),
    repos: unusedRepos,
    identity: { name: "Test", email: "test@clanker.invalid" },
  });
  // Los tests que recorren `pr.pushFixups` (publicar un PR de verdad y empujarle fixups) corren en `techlead-e2e.test.ts`.
  flows.registerAction(prPushFixupsAction({ store, workspaces, repos: unusedRepos, prs: createPrs({ connections, packs }) }));
  flows.registerAction(prReplyAction({ connections, packs, pause: () => Promise.resolve() }));
  const requestBot = reviewRequestBotAction({ connections, packs });
  flows.registerAction(
    options.waits
      ? {
          ...requestBot,
          run: async (args, ctx) => {
            const result = await requestBot.run(args, ctx);
            pr.botLgtm();
            return result;
          },
        }
      : requestBot,
  );
  const skip = [...(options.skip ?? [])];
  if (options.waits) {
    for (const wait of Object.values(prWaits(createPrs({ connections, packs })))) flows.registerWait(wait);
    skip.push("pr.botReview", "pr.ci");
  }
  if (options.real) {
    flows.registerAction(workspaceAcquireAction(workspaces));
    flows.registerAction(workspaceSyncBaseAction(workspaces));
    flows.registerAction(createRecipes({ store, defs, workspaces, artifacts, slots: createSlots({ store }) }).checkAction);
    skip.push("workspace.acquire", "workspace.syncBase", "recipe.check");
  }
  const stubs = registerFlowStubs(flows, { script: options.script, skip, outputs: options.outputs });
  cleanups.push(async () => {
    await flows.close();
    await sim.close();
    origin.cleanup();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { flows, store, stubs, pr };
}

/** Guarda `pr-feedback` y después `techlead-clasico`, que lo llama. */
function saveTemplates(flows: Flows) {
  return [flows.save(templates["pr-feedback"]!, { scope: "builtin", source: "import" }), flows.save(templates["techlead-clasico"]!, { scope: "builtin", source: "import" })];
}

function finished(store: Store, runId: RunId): Promise<void> {
  const filter = { runId, types: ["run.finished" as const, "run.parked" as const] };
  return new Promise((resolve) => {
    if (store.events.since(0, filter).length > 0) return resolve();
    const off = store.events.subscribe(() => {
      off();
      resolve();
    }, filter);
  });
}

async function runTechlead(flows: Flows, store: Store, params: Record<string, unknown> = {}) {
  const runId = flows.start("techlead-clasico", { type: "issue", id: "CLA-1" }, { repo: "rep_1", base: "main", ...params }, { profile: "eco" });
  await finished(store, runId);
  return { runId, run: flows.getRun(runId), nodes: topLevel(flows.getRun(runId)) };
}

/** Los nodos que recorrió la corrida, sin las ramas de un parallel (`rv-*`, `lr-*`). */
const topLevel = (run: RunView) => run.steps.map((s) => s.nodeId).filter((id) => !/^(rv|lr)-/.test(id));

const notes = (store: Store, runId: RunId) =>
  store.events.since(0, { types: ["decision.opened"] }).filter((e) => e.runId === runId).map((e) => (e.payload as { title: string }).title);

describe("validación", () => {
  test.each([false, true])("las dos plantillas validan y se guardan (acciones y waits reales donde existen: %s)", async (real) => {
    const { flows } = await setup({ real, waits: real });

    const saved = saveTemplates(flows);

    expect(saved.map((s) => [s.version, s.warnings])).toEqual([[1, []], [1, []]]);
  });

  test("techlead-clasico pide pr-feedback: sin él no valida", async () => {
    const { flows } = await setup();

    expect(flows.validate(templates["techlead-clasico"]).errors).toContainEqual({ path: "nodes.feedback.flow", message: 'el flujo "pr-feedback" no existe' });
  });

  test.each([false, true])("council valida, es de mantenimiento y no pide ni bot ni squash (acciones y waits reales donde existen: %s)", async (real) => {
    const { flows } = await setup({ real, waits: real });

    const saved = flows.save(templates.council!, { scope: "builtin", source: "import" });

    expect([saved.version, saved.warnings]).toEqual([1, []]);
    const { trigger, lane, nodes } = templates.council!;
    expect([trigger, lane]).toEqual([{ type: "pr.comment" }, "maintenance"]);
    const actions = Object.values(nodes).flatMap((node) => (node.type === "action" ? [node.action] : []));
    expect(actions).toEqual(["workspace.attach", "council.threads", "recipe.check", "pr.pushFixups", "pr.reply"]);
  });

  test("params con 3 rondas por defecto y maxSteps 200", () => {
    const { params, limits } = templates["techlead-clasico"]!;

    expect(params).toMatchObject({ reviewRounds: { default: 3 }, checkRounds: { default: 3 }, externalRounds: { default: 3 } });
    expect(limits).toEqual({ maxCostUsd: null, maxSteps: 200 });
    expect(templates["pr-feedback"]!.params).toMatchObject({ externalRounds: { default: 3 } });
  });
});

describe("techlead-clasico con el runtime fake", () => {
  test("camino feliz: de la issue al PR draft, con el bot en LGTM y el CI verde", async () => {
    const { flows, store, stubs, pr } = await setup({ fixtures: fixtures("base", "reviews-ok") });
    saveTemplates(flows);

    const { runId, run, nodes } = await runTechlead(flows, store);

    expect(run).toMatchObject({ status: "done", outcome: "done", rounds: {} });
    expect(nodes).toEqual(["ws", "plan", "plan-check", "implement", "checks", "reviews", "sync", "commit", "publish", "feedback"]);
    // plan-check solo corre si el plan trae dudas de la issue.
    expect(run.steps.find((s) => s.nodeId === "plan-check")).toMatchObject({ status: "done", outcome: "skipped" });
    expect(stubs.calls["pr.publish"]).toEqual([expect.objectContaining({ draft: true, plan: expect.objectContaining({ pr: expect.any(Object) }) })]);
    expect(notes(store, runId)).toEqual([]);

    const [feedback] = flows.listRuns().filter((r) => r.parentRunId === runId);
    expect(feedback).toMatchObject({ flow: { slug: "pr-feedback" }, outcome: "done", status: "done" });
    expect(flows.getRun(feedback!.id).steps.map((s) => [s.nodeId, s.outcome])).toEqual([
      ["bot-req", "ok"],
      ["bot-wait", "lgtm"],
      ["ci-wait", "ok"],
    ]);
    expect(feedback!.params).toMatchObject({ externalRounds: 3, pr: { repo: "acme/web", number: 1 } });
    // `review.requestBot` es la real: le pidió review al bot del pack con su comando.
    expect(pr.node().comments.map((c) => c.body.split("\n")[0])).toEqual(["/review"]);
  });

  test("con las rondas de review agotadas sigue a sync con una nota y termina el PR", async () => {
    const { flows, store } = await setup({ fixtures: fixtures("base", "reviews-changes") });
    saveTemplates(flows);

    const { runId, run, nodes } = await runTechlead(flows, store);

    expect(run).toMatchObject({ status: "done", outcome: "done", rounds: { review: 3 } });
    // Tres rondas de fix (cada una con sus checks y sus reviews) y la cuarta pasada de reviews se agota.
    expect(nodes).toEqual([
      "ws", "plan", "plan-check", "implement", "checks",
      ...["reviews", "fix", "checks", "reviews", "fix", "checks", "reviews", "fix", "checks", "reviews"],
      "sync", "commit", "publish", "feedback",
    ]);
    expect(run.steps.filter((s) => s.nodeId === "reviews").map((s) => s.outcome)).toEqual(["changes", "changes", "changes", "changes"]);
    expect(notes(store, runId)).toEqual(["Quedan 🔴/🟡 tras las rondas de review"]);
  });

  test("reviewRounds del proyecto pisa el default sin tocar el flujo", async () => {
    const { flows, store } = await setup({ fixtures: fixtures("base", "reviews-changes") });
    saveTemplates(flows);

    const { run } = await runTechlead(flows, store, { reviewRounds: 1 });

    expect(run).toMatchObject({ status: "done", rounds: { review: 1 } });
    expect(run.steps.filter((s) => s.nodeId === "fix")).toHaveLength(1);
  });

  test("con tests rojos tras las rondas de checks sigue a las reviews con una nota", async () => {
    const { flows, store } = await setup({
      fixtures: fixtures("base", "reviews-ok"),
      script: { "recipe.check": ["fail", "fail", "fail", "fail"] },
    });
    saveTemplates(flows);

    const { runId, run, nodes } = await runTechlead(flows, store, { checkRounds: 3 });

    expect(run).toMatchObject({ status: "done", outcome: "done" });
    expect(nodes.slice(4, 12)).toEqual(["checks", "fix", "checks", "fix", "checks", "fix", "checks", "reviews"]);
    expect(notes(store, runId)).toEqual(["Tests o lint siguen rojos"]);
  });

  test("un conflicto con la base tras las rondas de fix termina la corrida en failed", async () => {
    const { flows, store } = await setup({
      fixtures: fixtures("base", "reviews-ok"),
      script: { "workspace.syncBase": ["conflict", "conflict", "conflict"] },
    });
    saveTemplates(flows);

    const { run } = await runTechlead(flows, store);

    expect(run).toMatchObject({ status: "failed", outcome: "failed" });
    expect(run.steps.filter((s) => s.nodeId === "sync").map((s) => s.outcome)).toEqual(["conflict", "conflict", "conflict"]);
  });
});

describe("council con el runtime fake", () => {
  test("sin threads abiertos termina en done sin tocar nada", async () => {
    const { flows, store, stubs } = await setup({ script: { "council.threads": ["none"] } });
    flows.save(templates.council!, { scope: "builtin", source: "import" });

    const runId = flows.start("council", { type: "pr", id: "pr_1" }, { pr: { account: "acme", repo: "acme/web", number: 1 }, repo: "rep_1", branch: "cla-1", base: "main" }, { profile: "eco" });
    await finished(store, runId);

    const run = flows.getRun(runId);
    expect(run).toMatchObject({ status: "done", outcome: "done", lane: "maintenance" });
    expect(topLevel(run)).toEqual(["ws", "threads"]);
    expect(stubs.calls["workspace.attach"]).toEqual([{ repo: "rep_1", branch: "cla-1", base: "main" }]);
  });
});

describe("pr-feedback con el runtime fake", () => {
  test("un CI rojo ajeno cierra el feedback con una nota", async () => {
    const { flows, store } = await setup({
      fixtures: fixtures("base", "reviews-ok", "feedback"),
      script: { "pr.ci": ["fail"] },
    });
    saveTemplates(flows);

    const { runId, run } = await runTechlead(flows, store);

    expect(run).toMatchObject({ status: "done", outcome: "done" });
    const [feedback] = flows.listRuns().filter((r) => r.parentRunId === runId);
    expect(topLevel(flows.getRun(feedback!.id))).toEqual(["bot-req", "bot-wait", "ci-wait", "ci-triage"]);
    expect(notes(store, feedback!.id)).toEqual(["CI rojo ajeno o flaky"]);
  });
});

describe("pr-feedback con los waits reales sobre el GitHub simulado", () => {
  test("el bot da LGTM y el CI está verde: pide la review, espera y termina", async () => {
    const { flows, store, pr } = await setup({ fixtures: fixtures("base", "reviews-ok"), waits: true });
    pr.ci("green");
    saveTemplates(flows);

    const { runId, run } = await runTechlead(flows, store);

    expect(run).toMatchObject({ status: "done", outcome: "done" });
    const [feedback] = flows.listRuns().filter((r) => r.parentRunId === runId);
    expect(flows.getRun(feedback!.id).steps.map((s) => [s.nodeId, s.outcome])).toEqual([
      ["bot-req", "ok"],
      ["bot-wait", "lgtm"],
      ["ci-wait", "ok"],
    ]);
  });

  test("un check rojo cierra el feedback con la nota del CI ajeno", async () => {
    const { flows, store, pr } = await setup({ fixtures: fixtures("base", "reviews-ok", "feedback"), waits: true });
    pr.ci("red");
    saveTemplates(flows);

    const { runId, run } = await runTechlead(flows, store);

    expect(run).toMatchObject({ status: "done", outcome: "done" });
    const [feedback] = flows.listRuns().filter((r) => r.parentRunId === runId);
    expect(topLevel(flows.getRun(feedback!.id))).toEqual(["bot-req", "bot-wait", "ci-wait", "ci-triage"]);
    expect(notes(store, feedback!.id)).toEqual(["CI rojo ajeno o flaky"]);
  });
});
