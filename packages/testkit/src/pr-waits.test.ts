import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrRef, type FlowDef } from "@clanker/api";
import {
  createAgents,
  createArtifacts,
  createConnections,
  createDefs,
  createFileSecrets,
  createFlows,
  createPacks,
  createPrs,
  openStore,
  prWaits,
  reviewRequestBotAction,
  type Connections,
  type Flows,
  type Packs,
  type Store,
} from "@clanker/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { createFakeRuntime } from "./fake-runtime";
import { tempGitRepo, type TempGitRepo } from "./git";
import { startGitHubSim, type GitHubSim, type SimPr } from "./github-sim";

// `pr.botReview`, `pr.ci`, `pr.merged` y `review.requestBot` sobre el GitHub simulado, dentro del motor
// de flujos real: el sondeo (`probe`), el signal (`match`) y el plazo (`timeout`) de cada wait.

vi.setConfig({ testTimeout: 20_000 });

const TOKEN = "github_pat_UNIQUE-0123456789";
const ACCOUNT = "octocat";
const REPO = "octocat/secret-project";
const BRANCH = "cla-55";
const PR: PrRef = { account: ACCOUNT, repo: REPO, number: 1 };

let dir: string;
let store: Store;
let origin: TempGitRepo;
let sim: GitHubSim;
let connections: Connections;
let packs: Packs;
let flows: Flows;
let pr: SimPr;
/** Lo que cada nodo `capture` recibió, en orden. */
let captured: Record<string, unknown>[];
/** Lo que el bot "hace" en cada punto del flujo (`sim.script`): lo guiona cada test. */
let scripts: Record<string, () => void>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "clanker-waits-"));
  store = openStore({ path: ":memory:" });
  origin = tempGitRepo({
    remote: true,
    commits: [{ message: "chore: base", files: { "a.txt": "a\n" } }],
    branches: { [BRANCH]: [{ message: "feat: change", files: { "b.txt": "b\n" } }] },
  });
  sim = await startGitHubSim({ origin, token: TOKEN });
  pr = sim.openPr({ head: BRANCH });
  connections = createConnections(store, createFileSecrets({ dir }), { github: { baseUrl: sim.baseUrl } });
  await connections.connect({ provider: "github", account: ACCOUNT, scopes: [], token: TOKEN }, "core");

  const defs = createDefs(store);
  packs = createPacks({ defs });
  const packDir = join(dir, "pack");
  mkdirSync(packDir);
  writeFileSync(
    join(packDir, "pack.json"),
    JSON.stringify({
      id: "acme",
      version: 1,
      activate: { githubOrgs: ["octocat"] },
      actors: { ignore: "\\[bot\\]$" },
      reviewBot: {
        logins: ["review-bot[bot]"],
        request: { type: "comment", body: "/review" },
        lgtm: { reviewState: "APPROVED", bodyMatch: "LGTM", sameSha: true },
      },
      ciRules: { ignoreChecks: ["merge-queue"], knownFlaky: ["e2e"] },
    }),
  );
  await packs.load(packDir);

  flows = createFlows({
    store,
    defs,
    agents: createAgents({ store, defs, runtime: createFakeRuntime({ fixtures: [], speed: Infinity }) }),
    artifacts: createArtifacts({ store, dir: join(dir, "artifacts") }),
    roles: () => undefined,
    workspaceOf: () => ({ path: dir, base: "main" }),
    // Un tick cada 20 ms y un sondeo por tick: lo que pasa en GitHub mientras el wait espera lo resuelve el siguiente.
    tickMs: 20,
    probeEverySec: 0.01,
  });
  for (const wait of Object.values(prWaits(createPrs({ connections, packs })))) flows.registerWait(wait);
  flows.registerAction(reviewRequestBotAction({ connections, packs }));
  captured = [];
  flows.registerAction({
    name: "capture",
    args: z.record(z.string(), z.unknown()),
    outcomes: ["ok"],
    effects: "local",
    run: (args) => {
      captured.push(args);
      return Promise.resolve({ outcome: "ok" });
    },
  });
  flows.registerAction({
    name: "sim.script",
    args: z.object({ step: z.string() }),
    outcomes: ["ok"],
    effects: "local",
    run: ({ step }) => {
      scripts[step]?.();
      return Promise.resolve({ outcome: "ok" });
    },
  });
  scripts = {};
});

afterEach(async () => {
  await flows.close();
  await sim.close();
  origin.cleanup();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const flow = (nodes: FlowDef["nodes"], start: string): FlowDef => ({
  schema: 1,
  id: "waits",
  name: "Waits de PR",
  trigger: { type: "manual" },
  params: { pr: "PrRef" },
  start,
  nodes,
});

/** Corre el flujo y espera a que termine; devuelve cómo terminó. */
async function run(def: FlowDef): Promise<{ status: string; outcome: string | null; steps: [string, string | null][] }> {
  flows.save(def);
  const runId = flows.start("waits", { type: "issue", id: "CLA-55" }, { pr: PR });
  await new Promise<void>((resolve) => {
    const filter = { runId, types: ["run.finished" as const, "run.parked" as const] };
    if (store.events.since(0, filter).length > 0) return resolve();
    const off = store.events.subscribe(() => {
      off();
      resolve();
    }, filter);
  });
  const view = flows.getRun(runId);
  return { status: view.status, outcome: view.outcome, steps: view.steps.map((s) => [s.nodeId, s.outcome]) };
}

/** Ejecuta `fn` cuando el primer wait del flujo ya quedó esperando: lo que pasa "mientras espera". */
function whenWaiting(fn: () => void) {
  const off = store.events.subscribe(() => {
    off();
    setImmediate(fn);
  }, { types: ["step.waiting" as const] });
}

const OUTCOMES: Record<string, string[]> = { "pr.botReview": ["lgtm", "findings"], "pr.ci": ["ok", "fail"], "pr.merged": ["merged", "closed"] };

/** Cada outcome del wait sigue a `capture`; el plazo vencido falla la corrida. */
const waitNode = (event: string, args: Record<string, unknown>, timeoutSec = 30) => ({
  type: "wait" as const,
  event,
  args: { pr: "$run.params.pr", ...args },
  timeoutSec,
  on: { ...Object.fromEntries(OUTCOMES[event]!.map((outcome) => [outcome, "capture"])), timeout: "@failed" },
});
const captureNode = (from: string) => ({ type: "action" as const, action: "capture", args: { out: `$${from}` }, on: { ok: "@done" as const } });

/** `review.requestBot` → lo que el bot haga → `pr.botReview` con `after: requestedAt`. */
const botFlow = (timeoutSec?: number) =>
  flow(
    {
      request: { type: "action", action: "review.requestBot", args: { pr: "$run.params.pr" }, on: { ok: "script", none: "@blocked" } },
      script: { type: "action", action: "sim.script", args: { step: "afterRequest" }, on: { ok: "bot" } },
      bot: waitNode("pr.botReview", { after: "$request.requestedAt" }, timeoutSec),
      capture: captureNode("bot"),
    },
    "request",
  );

const ciFlow = (timeoutSec?: number) =>
  flow({ ci: waitNode("pr.ci", {}, timeoutSec), capture: captureNode("ci") }, "ci");

describe("pr.botReview", () => {
  test("lgtm: la review del bot posterior a la petición, sobre el head actual", async () => {
    scripts.afterRequest = () => pr.botLgtm();

    const result = await run(botFlow());

    expect(result).toMatchObject({ status: "done", steps: [["request", "ok"], ["script", "ok"], ["bot", "lgtm"], ["capture", "ok"]] });
    expect(captured).toEqual([{ out: expect.objectContaining({ sha: pr.headSha(), reviewId: expect.any(Number) }) }]);
  });

  test("findings: un ítem por thread abierto del bot, con su lugar y su texto", async () => {
    scripts.afterRequest = () => {
      pr.botFindings([{ path: "b.txt", line: 1, body: "Falta validar el monto" }, "Revisa el nombre"]);
      pr.thread("octocat", "esto es de un humano");
    };

    const result = await run(botFlow());

    expect(result.steps.map(([node]) => node)).toEqual(["request", "script", "bot", "capture"]);
    expect(result.steps[2]).toEqual(["bot", "findings"]);
    const { items } = (captured[0] as { out: { items: unknown[] } }).out;
    expect(items).toEqual([
      { id: expect.any(String), kind: "bot", path: "b.txt", line: 1, text: "Falta validar el monto" },
      { id: expect.any(String), kind: "bot", path: "src/index.ts", line: 1, text: "Revisa el nombre" },
    ]);
  });

  test("sondeo: si el bot responde mientras el wait espera, el siguiente sondeo lo resuelve", async () => {
    whenWaiting(() => pr.botLgtm());

    const result = await run(botFlow());

    expect(result.steps.find(([node]) => node === "bot")).toEqual(["bot", "lgtm"]);
  });

  test("signal: el evento del PR resuelve el wait con su estado, sin que el sondeo vea nada", async () => {
    const prs = createPrs({ connections, packs });
    const current = await prs.get(PR);
    const bot = (state: "lgtm" | "findings") => ({ state, sha: current.headSha, reviewId: 7, at: "2026-12-01T00:00:00Z", findings: [] });
    whenWaiting(() => {
      // Otro PR: no es de este wait. El del PR sí, aunque en GitHub el bot no haya dicho nada todavía.
      flows.signal({ type: "pr.botReview", pr: { ...PR, number: 2 }, state: { ...current, bot: bot("findings") } });
      flows.signal({ type: "pr.ci", pr: PR, state: { ...current, bot: bot("findings") } });
      flows.signal({ type: "pr.botReview", pr: PR, state: { ...current, bot: bot("lgtm") } });
    });

    const result = await run(flow({ bot: waitNode("pr.botReview", { after: 0 }), capture: captureNode("bot") }, "bot"));

    expect(result).toMatchObject({ status: "done", steps: [["bot", "lgtm"], ["capture", "ok"]] });
    expect(captured).toEqual([{ out: { sha: current.headSha, reviewId: 7 } }]);
  });

  test("una review anterior a la petición no cuenta: sin respuesta nueva vence con timeout", async () => {
    pr.botFindings(["algo viejo"]);

    const result = await run(botFlow(0.3));

    expect(result).toMatchObject({ status: "failed", outcome: "failed" });
    expect(result.steps.at(-1)).toEqual(["bot", "timeout"]);
    expect(captured).toEqual([]);
  });

  test("un LGTM de un commit anterior (el head se movió) no cuenta", async () => {
    scripts.afterRequest = () => pr.botLgtm({ sha: "0".repeat(40) });

    const result = await run(botFlow(0.3));

    expect(result.steps.at(-1)).toEqual(["bot", "timeout"]);
  });
});

describe("pr.ci", () => {
  test("ok: los checks que cuentan en verde (merge-queue, ignorado, no cuenta)", async () => {
    pr.check("unit", "success", { required: true });
    pr.check("merge-queue", "failure");

    const result = await run(ciFlow());

    expect(result).toMatchObject({ status: "done", steps: [["ci", "ok"], ["capture", "ok"]] });
    expect(captured).toEqual([{ out: { sha: pr.headSha() } }]);
  });

  test("fail: apenas un check que cuenta falla, con una falla por check y el flaky conocido marcado", async () => {
    pr.check("unit", "failure", { required: true });
    pr.check("e2e", "failure");
    pr.check("lint", "pending");

    const result = await run(ciFlow());

    expect(result.steps[0]).toEqual(["ci", "fail"]);
    expect(captured).toEqual([
      {
        out: {
          sha: pr.headSha(),
          failures: [
            { id: "ci:unit", kind: "ci", text: `El check unit falló en ${pr.headSha().slice(0, 7)}.` },
            { id: "ci:e2e", kind: "ci", text: `El check e2e falló en ${pr.headSha().slice(0, 7)}.`, flaky: true },
          ],
        },
      },
    ]);
  });

  test("sondeo: pendiente (o sin checks todavía) sigue esperando hasta que el CI termina", async () => {
    pr.ci("pending");
    whenWaiting(() => pr.ci("green"));

    const result = await run(ciFlow());

    expect(result.steps[0]).toEqual(["ci", "ok"]);
  });

  test("timeout: un CI que no termina en el plazo cierra con timeout", async () => {
    pr.ci("pending");

    const result = await run(ciFlow(0.3));

    expect(result).toMatchObject({ status: "failed" });
    expect(result.steps).toEqual([["ci", "timeout"]]);
  });

  test("el CI de un commit nuevo empieza de cero: lo verde del anterior no vale", async () => {
    pr.ci("green");
    origin.git("checkout", BRANCH);
    writeFileSync(join(origin.dir, "c.txt"), "c\n");
    origin.git("add", "--all");
    origin.git("commit", "--message", "fix: fixup");
    origin.git("push", "origin", BRANCH);
    origin.git("checkout", "main");

    const result = await run(ciFlow(0.3));

    expect(result.steps).toEqual([["ci", "timeout"]]);
  });
});

describe("pr.merged", () => {
  const mergedFlow = (timeoutSec?: number) => flow({ merged: waitNode("pr.merged", {}, timeoutSec), capture: captureNode("merged") }, "merged");

  test("merged: con el sha del merge", async () => {
    whenWaiting(() => pr.merge());

    const result = await run(mergedFlow());

    expect(result.steps[0]).toEqual(["merged", "merged"]);
    expect(captured).toEqual([{ out: { sha: pr.headSha() } }]);
  });

  test("closed: lo cerraron sin mergear", async () => {
    whenWaiting(() => void connections.githubClient(ACCOUNT).request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { owner: "octocat", repo: "secret-project", pull_number: 1, state: "closed" }));

    const result = await run(mergedFlow());

    expect(result.steps[0]).toEqual(["merged", "closed"]);
  });

  test("timeout: un PR que sigue abierto vence", async () => {
    const result = await run(mergedFlow(0.3));

    expect(result.steps).toEqual([["merged", "timeout"]]);
  });
});
