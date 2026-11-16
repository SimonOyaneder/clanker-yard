import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createArtifacts,
  createAskpass,
  createConnections,
  createDefs,
  createFileSecrets,
  createGitRemote,
  createPacks,
  createRecipes,
  createSlots,
  createWorkspaces,
  newId,
  openStore,
  prPublishAction,
  createLegacyBranchRenamer,
  type ActionCtx,
  type Askpass,
  type LegacyBranchRenamer,
  type Store,
  type Workspaces,
} from "@clanker/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tempGitRepo, type TempGitRepo } from "./git";
import { startGitHubSim, type GitHubSim } from "./github-sim";

// `branches.renameLegacy` sobre repos git reales, un remoto bare y el GitHub simulado.

vi.setConfig({ testTimeout: 30_000 });

const TOKEN = "github_pat_UNIQUE-0123456789";
const ACCOUNT = "octocat";
const REPO = "octocat/secret-project";

let dataDir: string;
let store: Store;
let repo: TempGitRepo;
let askpass: Askpass;
let workspaces: Workspaces;
let github: GitHubSim;
let publish: ReturnType<typeof prPublishAction>;
let renamer: LegacyBranchRenamer;

const ISSUES: Record<string, { id: string; projectId: string; ref: { key: string }; title: string; branchName?: string }> = {
  iss_parent: { id: "iss_parent", projectId: "prj_1", ref: { key: "ENG-1" }, title: "Parent change", branchName: "simon/eng-1-parent-change" },
  iss_child: { id: "iss_child", projectId: "prj_1", ref: { key: "ENG-2" }, title: "Child change" },
};

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "clanker-rename-"));
  store = openStore({ path: ":memory:" });
  store.db.$client.exec("PRAGMA foreign_keys = OFF");
  repo = tempGitRepo({ remote: true, commits: [{ message: "chore: base", files: { "a.txt": "a1\n" } }] });
  github = await startGitHubSim({ origin: repo, repo: REPO, token: TOKEN });

  askpass = createAskpass();
  const connections = createConnections(store, createFileSecrets({ dir: join(dataDir, "secrets") }), { github: { baseUrl: github.baseUrl } });
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
  const defs = createDefs(store);
  const packs = createPacks({ defs });
  const recipes = createRecipes({ store, defs, workspaces, artifacts: createArtifacts({ store, dir: join(dataDir, "artifacts") }), slots: createSlots({ store }) });
  publish = prPublishAction({ store, workspaces, recipes, repos, connections, packs });
  renamer = createLegacyBranchRenamer({
    store,
    repos: { config: repos },
    issues: { get: (id) => ISSUES[id] as never },
    connections,
  });
});

afterEach(async () => {
  await askpass.close();
  await github.close();
  repo.cleanup();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function ctx(): ActionCtx {
  const saved = new Map<string, unknown>();
  return {
    runId: newId("run"),
    stepId: newId("stp"),
    key: "run:rename:1",
    signal: new AbortController().signal,
    async once(stage, fn) {
      if (saved.has(stage)) return saved.get(stage) as never;
      const result = await fn();
      saved.set(stage, JSON.parse(JSON.stringify(result)));
      return result;
    },
  };
}

async function openPr(branch: string, base: string): Promise<number> {
  const lease = await workspaces.acquire({ repo: "r1", branch, base, runId: newId("run") });
  writeFileSync(join(lease.path, `${branch}.txt`), `${branch}\n`);
  const { workspaceId, path, baseSha, fencingToken } = lease;
  const published = await publish.run(
    publish.args.parse({
      ws: { workspaceId, path, branch, baseSha, fencingToken },
      plan: { commits: [{ message: `feat: ${branch}`, hunks: ["h1"], tests: [] }], pr: { title: `[${branch}] cambio`, body: "" } },
    }),
    ctx(),
  );
  expect(published.outcome).toBe("ok");
  workspaces.release(lease);
  return (published.output as { pr: { number: number } }).pr.number;
}

function addRun(subjectId: string, status: "running" | "done", params: Record<string, unknown> = {}) {
  store.db.$client
    .prepare(
      "INSERT INTO runs (id, subject_type, subject_id, flow_def_id, flow_version, roles, lane, status, writes, params, rounds, started_at) VALUES (?, 'issue', ?, 'f', 1, '{}', 'dev', ?, 1, ?, '{}', 1)",
    )
    .run(newId("run"), subjectId, status, JSON.stringify(params));
}

const prRows = () =>
  store.db.$client.prepare("SELECT number, head_ref, base_ref FROM pull_requests ORDER BY number").all() as { number: number; head_ref: string; base_ref: string }[];

const remoteHas = (branch: string): boolean => {
  try {
    repo.git("-C", repo.remoteDir!, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
};

describe("branches.renameLegacy", () => {
  test("renombra la remota, la local y el core; el hijo apilado queda sobre la base nueva y el siguiente push va a la branch nueva", async () => {
    const parent = await openPr("iss_parent", "main");
    const child = await openPr("iss_child", "iss_parent");
    addRun("iss_parent", "done", { repo: "r1" });

    const results = await renamer.renameLegacy({});

    expect(results).toEqual([
      { repo: "r1", number: parent, from: "iss_parent", to: "eng-1-parent-change", status: "renamed" },
      { repo: "r1", number: child, from: "iss_child", to: "eng-2-child-change", status: "renamed" },
    ]);
    expect(remoteHas("iss_parent")).toBe(false);
    expect(remoteHas("eng-1-parent-change")).toBe(true);
    expect(github.pulls().map((p) => [p.number, p.head.ref, p.base.ref])).toEqual([
      [parent, "eng-1-parent-change", "main"],
      [child, "eng-2-child-change", "eng-1-parent-change"],
    ]);

    expect(prRows().map((r) => [r.number, r.head_ref, r.base_ref])).toEqual([
      [parent, "eng-1-parent-change", "main"],
      [child, "eng-2-child-change", "eng-1-parent-change"],
    ]);
    expect(JSON.parse(String(store.db.$client.prepare("SELECT params FROM runs").get()?.params))).toEqual({ repo: "r1", branch: "eng-1-parent-change" });

    const lease = await workspaces.acquire({ repo: "r1", branch: "eng-1-parent-change", base: "main", runId: newId("run") });
    expect(repo.git("-C", lease.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("eng-1-parent-change");
    expect(() => repo.git("-C", repo.dir, "rev-parse", "--verify", "--quiet", "refs/heads/iss_parent")).toThrow();
    repo.git("-C", lease.path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "fix: otro");
    const head = repo.git("-C", lease.path, "rev-parse", "HEAD");
    expect(await workspaces.push(lease)).toBe("ok");
    expect(repo.git("-C", repo.remoteDir!, "rev-parse", "refs/heads/eng-1-parent-change")).toBe(head);
    expect(remoteHas("iss_parent")).toBe(false);
  });

  test("salta la issue con una corrida viva y la reporta", async () => {
    const parent = await openPr("iss_parent", "main");
    addRun("iss_parent", "running");

    const results = await renamer.renameLegacy({});

    expect(results).toEqual([expect.objectContaining({ number: parent, from: "iss_parent", status: "skipped", reason: expect.stringContaining("sigue viva") })]);
    expect(remoteHas("iss_parent")).toBe(true);
    expect(prRows()[0]?.head_ref).toBe("iss_parent");
  });

  test("dry-run lista viejo y nuevo sin cambiar nada", async () => {
    const parent = await openPr("iss_parent", "main");
    const requests = github.requests.length;

    const results = await renamer.renameLegacy({ dryRun: true });

    expect(results).toEqual([{ repo: "r1", number: parent, from: "iss_parent", to: "eng-1-parent-change", status: "planned" }]);
    expect(github.requests.slice(requests).filter((r) => r.method !== "GET")).toEqual([]);
    expect(remoteHas("iss_parent")).toBe(true);
    expect(prRows()[0]?.head_ref).toBe("iss_parent");
  });

  test("no toca las branches que no parten con iss_", async () => {
    await openPr("eng-9-ya-con-nombre", "main");
    expect(await renamer.renameLegacy({})).toEqual([]);
  });
});
