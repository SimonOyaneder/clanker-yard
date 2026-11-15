import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FlowDef, type RunId } from "@clanker/api";
import {
  createAgents,
  createArtifacts,
  createAskpass,
  createConnections,
  createDefs,
  createFileSecrets,
  createFlows,
  createGitRemote,
  createPacks,
  createRecipes,
  createSlots,
  createWorkspaces,
  newId,
  openStore,
  PermanentActionError,
  prPublishAction,
  workspaceAcquireAction,
  type ActionCtx,
  type Askpass,
  type Connections,
  type Defs,
  type Flows,
  type PrPublishDeps,
  type Store,
  type WorkspaceLease,
  type Workspaces,
} from "@clanker/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { tempGitRepo, type TempGitRepo } from "./git";
import { startGitHubSim, type GitHubSim } from "./github-sim";

// Se prueba aquí y no en el core: necesita repos git reales (tempGitRepo) y un remoto bare. GitHub es el
// simulado (`startGitHubSim`): nunca GitHub ni tokens reales.

vi.setConfig({ testTimeout: 20_000 });

const TOKEN = "github_pat_UNIQUE-0123456789";
const ACCOUNT = "octocat";
const REPO = "octocat/secret-project";
const BRANCH = "cla-53";
const BODY = [
  "## Contexto",
  "",
  "Por qué se hace.",
  "",
  "## Rollback",
  "",
  "Revertir el commit.",
  "",
  "## Tests",
  "",
  "- [x] Tests unitarios",
].join("\n");

let dataDir: string;
let store: Store;
let repo: TempGitRepo;
let askpass: Askpass;
let connections: Connections;
let workspaces: Workspaces;
let github: GitHubSim;
let defs: Defs;
let deps: PrPublishDeps;
let publish: ReturnType<typeof prPublishAction>;
let lease: WorkspaceLease;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "clanker-publish-"));
  store = openStore({ path: ":memory:" });
  repo = tempGitRepo({
    remote: true,
    commits: [{ message: "chore: base", files: { "a.txt": "a\n" } }],
  });
  github = await startGitHubSim({ origin: repo, repo: REPO, token: TOKEN });

  askpass = createAskpass();
  connections = createConnections(store, createFileSecrets({ dir: join(dataDir, "secrets") }), {
    github: { baseUrl: github.baseUrl },
  });
  await connections.connect({ provider: "github", account: ACCOUNT, scopes: [], token: TOKEN }, "core");
  const repos = () => ({
    path: repo.dir,
    defaultBranch: "main",
    remote: { url: `file://${repo.remoteDir}`, repo: REPO, account: ACCOUNT },
  });
  workspaces = createWorkspaces({
    store,
    dataDir,
    repos,
    identity: { name: "Clanker Yard", email: "yard@clanker.invalid" },
    remote: createGitRemote({ askpass, connections }),
  });
  defs = createDefs(store);
  const packs = createPacks({ defs });
  const packDir = join(dataDir, "pack");
  mkdirSync(packDir);
  writeFileSync(
    join(packDir, "pack.json"),
    JSON.stringify({ id: "acme", version: 1, activate: { githubOrgs: ["octocat"] }, conventions: { pr: { omitSections: ["Rollback"] } } }),
  );
  await packs.load(packDir);
  deps = {
    store,
    workspaces,
    recipes: createRecipes({ store, defs, workspaces, artifacts: createArtifacts({ store, dir: join(dataDir, "artifacts") }), slots: createSlots({ store }) }),
    repos,
    connections,
    packs,
  };
  publish = prPublishAction(deps);
  lease = await workspaces.acquire({ repo: "r1", branch: BRANCH, base: "main", runId: newId("run") });
  write("feature.txt", "una feature\n");
});

afterEach(async () => {
  workspaces.release(lease);
  await askpass.close();
  await github.close();
  repo.cleanup();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function write(path: string, content: string) {
  const full = join(lease.path, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const remoteSha = () => repo.git("--git-dir", repo.remoteDir!, "rev-parse", `refs/heads/${BRANCH}`);
const commitsOnBranch = () => repo.git("-C", lease.path, "log", "--format=%s", `${lease.baseSha}..HEAD`).split("\n").filter(Boolean);
const posts = () => github.requests.filter((r) => r.method === "POST");

type Plan = { commits: { message: string; hunks: string[]; tests: string[] }[]; pr: { title: string; body: string } };

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    commits: [{ message: "feat: add feature", hunks: ["h1"], tests: [] }],
    pr: { title: "[CLA-53] Add feature", body: BODY },
    ...overrides,
  };
}

function args(overrides: { plan?: Plan; draft?: boolean; dependsOn?: string[] } = {}) {
  const { workspaceId, path, branch, baseSha, fencingToken } = lease;
  return publish.args.parse({ ws: { workspaceId, path, branch, baseSha, fencingToken }, plan: plan(), ...overrides });
}

/**
 * Un `ctx.once` que guarda como el motor y, si `crashAfter` es una etapa, "muere" justo después de
 * hacer su efecto y antes de guardarla: el peor corte posible.
 */
function durableCtx(crashAfter?: string) {
  const saved = new Map<string, unknown>();
  let crash = crashAfter;
  const ctx: ActionCtx = {
    runId: newId("run"),
    stepId: newId("stp"),
    key: "run:publish:1",
    signal: new AbortController().signal,
    async once(stage, fn) {
      if (saved.has(stage)) return saved.get(stage) as never;
      const result = await fn();
      if (stage === crash) {
        crash = undefined;
        throw new Error(`corte después de ${stage}`);
      }
      saved.set(stage, JSON.parse(JSON.stringify(result)));
      return result;
    },
  };
  return ctx;
}

function openedEvents() {
  return store.events.since(0, { types: ["pr.opened"] });
}

describe("pr.publish", () => {
  test("commitea, pushea con lease y abre el PR draft con la identidad de la cuenta", async () => {
    const result = await publish.run(args(), durableCtx());

    expect(result).toEqual({
      outcome: "ok",
      output: { pr: { account: ACCOUNT, repo: REPO, number: 1 }, url: `https://github.com/${REPO}/pull/1`, head: remoteSha() },
    });
    expect(commitsOnBranch()).toEqual(["feat: add feature"]);
    expect(github.pulls()).toMatchObject([
      { number: 1, draft: true, title: "[CLA-53] Add feature", head: { ref: BRANCH, sha: remoteSha() }, base: { ref: "main" } },
    ]);
    expect(remoteSha()).toBe(repo.git("-C", lease.path, "rev-parse", "HEAD"));
    for (const request of github.requests.filter((r) => r.path === `/repos/${REPO}/pulls`)) {
      expect(request.authorization).toBe(`bearer ${TOKEN}`);
    }
  });

  test("el cuerpo sale sin las secciones omitidas ni firmas de una IA, y abre con la dependencia", async () => {
    const dirty = plan({
      pr: {
        title: "[CLA-53] Add feature\nCo-Authored-By: Claude <noreply@anthropic.com>",
        body: `${BODY}\n\nGenerated with Claude Code\n`,
      },
    });

    await publish.run(args({ plan: dirty, dependsOn: ["api#4250", "web#9"] }), durableCtx());

    const [pull] = github.pulls();
    expect(pull?.title).toBe("[CLA-53] Add feature");
    expect(pull?.body).toBe(
      ["Depende de api#4250, web#9", "", "## Contexto", "", "Por qué se hace.", "", "## Tests", "", "- [x] Tests unitarios"].join("\n"),
    );
  });

  test("las secciones omitidas se sacan con su subárbol, sin distinguir mayúsculas y sin confundir un `#` de un bloque de código", async () => {
    const body = ["## Contexto", "x", "## rollback", "```sh", "# Tests", "```", "### Pasos", "y", "## Tests", "w"].join("\n");

    await publish.run(args({ plan: plan({ pr: { title: "t", body } }) }), durableCtx());

    expect(github.pulls()[0]?.body).toBe(["## Contexto", "x", "## Tests", "w"].join("\n"));
  });

  test("un plan que no se puede aplicar vuelve al committer sin pushear ni abrir nada", async () => {
    write("otro.txt", "otro\n");

    const result = await publish.run(args(), durableCtx());

    expect(result).toMatchObject({ outcome: "replan", output: { failures: expect.stringContaining("Hunks sin asignar") } });
    expect(commitsOnBranch()).toEqual([]);
    expect(() => remoteSha()).toThrow();
    expect(github.pulls()).toEqual([]);
  });

  test("sin cambios no hay nada que publicar: replan", async () => {
    rmSync(join(lease.path, "feature.txt"));

    const result = await publish.run(args({ plan: plan({ commits: [] }) }), durableCtx());

    expect(result).toMatchObject({ outcome: "replan", output: { failures: expect.stringContaining("nada que publicar") } });
    expect(github.pulls()).toEqual([]);
  });

  test("si alguien más pusheó la branch, no se reintenta y no se abre el PR", async () => {
    repo.git("--git-dir", repo.remoteDir!, "update-ref", `refs/heads/${BRANCH}`, lease.baseSha);

    await expect(publish.run(args(), durableCtx())).rejects.toThrow(PermanentActionError);

    expect(github.pulls()).toEqual([]);
    expect(remoteSha()).toBe(lease.baseSha);
  });

  test("un 401 de GitHub deja la conexión revocada y el paso falla para reintentarse", async () => {
    github.revokeToken();

    await expect(publish.run(args(), durableCtx())).rejects.toThrow();

    expect(connections.list()).toMatchObject([{ account: ACCOUNT, status: "revoked" }]);
    expect(github.pulls()).toEqual([]);
    expect(openedEvents()).toEqual([]);
  });

  test("un PR que Watch ya había descubierto (sin owned) se adopta: queda del sistema y con pr.opened", async () => {
    store.db.$client
      .prepare("INSERT INTO pull_requests (id, repo_id, number, node_id, head_ref, base_ref, head_sha, state, is_draft, owned) VALUES (?, 'r1', 1, '', ?, 'main', '', 'open', 1, 0)")
      .run(newId("pr"), BRANCH);

    const ctx = durableCtx();
    await publish.run(args(), ctx);

    expect(store.db.$client.prepare("SELECT number, owned, run_id AS runId FROM pull_requests").all()).toEqual([{ number: 1, owned: 1, runId: ctx.runId }]);
    expect(openedEvents()).toHaveLength(1);
  });

  test("otra visita que llega con todo ya hecho no duplica commits, push ni PR", async () => {
    await publish.run(args(), durableCtx());
    const again = await publish.run(args(), durableCtx());

    // Otra clave: el commit se reconoce, el push es noop y el PR se encuentra por su branch.
    expect(again).toMatchObject({ outcome: "ok", output: { pr: { number: 1 } } });
    expect(github.pulls()).toHaveLength(1);
    expect(posts()).toHaveLength(1);
    expect(openedEvents()).toHaveLength(1);
    expect(commitsOnBranch()).toEqual(["feat: add feature"]);
  });
});

describe("un corte en cada etapa", () => {
  // `apply` es la etapa de `commits.apply`; `push` y `pr` son las de `pr.publish`.
  test.each(["apply", "push", "pr"])("tras el efecto de %s y antes de guardarlo, el reintento no duplica commits, push ni PR", async (stage) => {
    const ctx = durableCtx(stage);
    await expect(publish.run(args(), ctx)).rejects.toThrow(`corte después de ${stage}`);

    const result = await publish.run(args(), ctx);

    expect(result).toMatchObject({ outcome: "ok", output: { pr: { number: 1 }, head: remoteSha() } });
    expect(commitsOnBranch()).toEqual(["feat: add feature"]);
    expect(repo.git("--git-dir", repo.remoteDir!, "rev-list", "--count", `${lease.baseSha}..refs/heads/${BRANCH}`)).toBe("1");
    expect(posts()).toHaveLength(github.pulls().length);
    expect(github.pulls()).toHaveLength(1);
    expect(openedEvents()).toHaveLength(1);
    const rows = store.db.$client.prepare("SELECT number, owned FROM pull_requests").all();
    expect(rows).toEqual([{ number: 1, owned: 1 }]);
  });

  test("un reintento con todas las etapas guardadas devuelve lo mismo sin tocar nada", async () => {
    const ctx = durableCtx();
    const first = await publish.run(args(), ctx);
    const requests = github.requests.length;

    const second = await publish.run(args(), ctx);

    expect(second).toEqual(first);
    expect(github.requests).toHaveLength(requests);
  });
});

describe("en un flujo", () => {
  let flows: Flows;

  afterEach(async () => {
    await flows.close();
  });

  function flowWith(publishNode: object): Flows {
    const unused = {
      id: "fake" as const,
      capabilities: { structuredOutput: true, costPerTurn: true, resume: true, fork: false, steer: false },
      start: () => Promise.reject(new Error("no se usa")),
      resume: () => Promise.reject(new Error("no se usa")),
    };
    flows = createFlows({
      store,
      defs,
      agents: createAgents({ store, defs, runtime: unused }),
      artifacts: createArtifacts({ store, dir: join(dataDir, "flow-artifacts") }),
      roles: () => undefined,
      workspaceOf: workspaces.held,
    });
    flows.registerAction(workspaceAcquireAction(workspaces));
    flows.registerAction({
      name: "test.edit",
      args: z.object({}),
      outcomes: ["ok"],
      effects: "local",
      run: (_args, ctx) => {
        const held = workspaces.held(ctx.runId);
        if (!held) throw new Error("la corrida no tiene worktree");
        writeFileSync(join(held.path, "feature.txt"), "una feature\n");
        return Promise.resolve({ outcome: "ok" });
      },
    });
    flows.registerAction(publish);
    flows.save(
      FlowDef.parse({
        schema: 1,
        id: "publish-flow",
        name: "Publicar",
        trigger: { type: "manual" },
        start: "ws",
        nodes: {
          ws: {
            type: "action",
            action: "workspace.acquire",
            args: { repo: "r1", branch: "cla-53-flow", base: "main" },
            on: { ok: "edit" },
          },
          edit: { type: "action", action: "test.edit", args: {}, on: { ok: "publish" } },
          publish: publishNode,
        },
      }),
    );
    return flows;
  }

  function finished(runId: RunId): Promise<void> {
    const filter = { runId, types: ["run.finished" as const, "run.parked" as const] };
    return new Promise((resolve) => {
      if (store.events.since(0, filter).length > 0) return resolve();
      const off = store.events.subscribe(() => {
        off();
        resolve();
      }, filter);
    });
  }

  test("el PR queda enlazado a la issue y a la corrida, con pr.opened en su línea de tiempo", async () => {
    // El workspace del beforeEach no se usa aquí.
    workspaces.release(lease);
    flowWith({
      type: "action",
      action: "pr.publish",
      args: { ws: "$ws", plan: plan(), draft: true },
      on: { ok: "@done", replan: "@failed" },
    });

    const runId = flows.start("publish-flow", { type: "issue", id: "CLA-53" }, {});
    await finished(runId);

    expect(flows.getRun(runId)).toMatchObject({ status: "done", outcome: "done" });
    const [row] = store.db.$client
      .prepare("SELECT id, repo_id, number, head_ref, base_ref, state, is_draft, issue_id, run_id, owned FROM pull_requests")
      .all() as { id: string; run_id: string }[];
    expect(row).toMatchObject({
      repo_id: "r1",
      number: 1,
      head_ref: "cla-53-flow",
      base_ref: "main",
      state: "open",
      is_draft: 1,
      issue_id: "CLA-53",
      run_id: runId,
      owned: 1,
    });
    expect(openedEvents()).toMatchObject([
      { runId, subject: { type: "pr", id: row?.id }, payload: { repo: REPO, number: 1, url: `https://github.com/${REPO}/pull/1` } },
    ]);
    expect(github.pulls()).toMatchObject([{ number: 1, draft: true, head: { ref: "cla-53-flow" } }]);
    // La corrida de la issue también es la dueña del PR: un rebase o un council sobre él espera a que ella termine.
    expect(store.db.$client.prepare("SELECT claimed_pr_id FROM runs WHERE id = ?").get(runId)).toEqual({ claimed_pr_id: row?.id });
  });

  test("replan sigue el edge del flujo hacia el committer", async () => {
    workspaces.release(lease);
    flowWith({
      type: "action",
      action: "pr.publish",
      args: { ws: "$ws", plan: plan({ commits: [{ message: "feat: x", hunks: ["h9"], tests: [] }] }), draft: true },
      on: { ok: "@done", replan: "@blocked" },
    });

    const runId = flows.start("publish-flow", { type: "issue", id: "CLA-53" }, {});
    await finished(runId);

    expect(flows.getRun(runId)).toMatchObject({ status: "failed", outcome: "blocked" });
    expect(flows.getRun(runId).steps.find((s) => s.nodeId === "publish")).toMatchObject({ outcome: "replan" });
    expect(github.pulls()).toEqual([]);
  });
});
