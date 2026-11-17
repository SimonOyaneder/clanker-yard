import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FlowDef, NewProject, type RunId } from "@clanker/api";
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
  createProjects,
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
  createRuntimeRegistry,
} from "@clanker/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { tempGitRepo, type TempGitRepo } from "./git";
import { startGitHubSim, type GitHubSim } from "./github-sim";
import { seedPr } from "@clanker/core/testing";

// Se prueba aquí y no en el core: necesita repos git reales (tempGitRepo) y un remoto bare. GitHub es el
// simulado (`startGitHubSim`): nunca GitHub ni tokens reales.

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
  connections = createConnections({ store, secrets: createFileSecrets({ dir: join(dataDir, "secrets") }), github: { baseUrl: github.baseUrl } });
  await connections.connect({ provider: "github", account: ACCOUNT, scopes: [], token: TOKEN }, "core");
  const repos = () => ({
    path: repo.dir,
    defaultBranch: "main",
    remote: { url: `file://${repo.remoteDir}`, repo: REPO, account: ACCOUNT },
  });
  workspaces = createWorkspaces({
    store,
    dataDir,
    repoConfig: repos,
    identityOf: async () => ({ name: "Ana Pérez", email: "ana@example.com" }),
    remote: createGitRemote({ askpass, connections }),
  });
  defs = createDefs({ store });
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
    repoConfig: repos,
    connections,
    packs,
  };
  publish = prPublishAction(deps);
  lease = await workspaces.acquire({ repo: "repo_00000000000000000000000001", branch: BRANCH, base: "main", runId: newId("run") });
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

const remoteSha = () => repo.git("--git-dir", repo.remoteDir!, "rev-parse", `refs/heads/${lease.branch}`);
const commitsOnBranch = () => repo.git("-C", lease.path, "log", "--format=%s", `${lease.baseSha}..HEAD`).split("\n").filter(Boolean);
const posts = () => github.requests.filter((r) => r.method === "POST" && r.path === `/repos/${REPO}/pulls`);

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
function durableCtx(crashAfter?: string, runId: RunId = newId("run")) {
  const saved = new Map<string, unknown>();
  let crash = crashAfter;
  const ctx: ActionCtx = {
    runId,
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

/** Una corrida sobre una issue con esa key de un tracker cualquiera (sin pasar por el motor). Con `key` vacía, como un tracker sin key. */
function issueRun(key: string, tracker = "linear"): RunId {
  const runId = newId("run");
  const issueId = newId("iss");
  const sqlite = store.db.$client;
  sqlite.exec("PRAGMA foreign_keys = OFF");
  sqlite
    .prepare(
      `INSERT INTO issues (id, tracker, tracker_id, key, url, project_id, tracker_project, title, body, status, raw_status, priority, labels, relations, remote_updated_at)
       VALUES (?, ?, 'x', ?, '', 'prj_x', 'x', 't', '', 'in_progress', 'In Progress', 0, '[]', '{"blocks":[],"blockedBy":[],"related":[]}', 0)`,
    )
    .run(issueId, tracker, key);
  sqlite
    .prepare(
      `INSERT INTO runs (id, subject_type, subject_id, flow_def_id, flow_version, roles, lane, status, writes, params, rounds, started_at)
       VALUES (?, 'issue', ?, 'def_x', 1, '{}', 'dev', 'running', 1, '{}', '{}', 0)`,
    )
    .run(runId, issueId);
  sqlite.exec("PRAGMA foreign_keys = ON");
  return runId;
}

async function publishTitled(title: string, runId: RunId) {
  await publish.run(args({ plan: plan({ pr: { title, body: BODY } }) }), durableCtx(undefined, runId));
  return github.pulls()[0]?.title;
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

  test.each([
    ["sin key en el título", "Add feature", "[ENG-9218] Add feature"],
    ["con la key ya al inicio", "[ENG-9218] Add feature", "[ENG-9218] Add feature"],
    ["con la key al final", "Add feature [ENG-9218]", "[ENG-9218] Add feature"],
    ["con la key en medio", "Add [ENG-9218] feature", "[ENG-9218] Add feature"],
    ["con otro prefijo que no es la key", "[CLA-1] Add feature", "[ENG-9218] [CLA-1] Add feature"],
  ])("el título parte con [KEY] de la issue, %s", async (_, title, expected) => {
    expect(await publishTitled(title, issueRun("ENG-9218"))).toBe(expected);
  });

  test("sin key (corrida sin issue o tracker sin key) el título queda como lo escribió el committer", async () => {
    expect(await publishTitled("Add feature", newId("run"))).toBe("Add feature");
  });

  test("una issue sin key no agrega nada al título", async () => {
    expect(await publishTitled("Add feature", issueRun("", "local"))).toBe("Add feature");
  });

  test("el PR nuevo se asigna a la cuenta con que se publica", async () => {
    await publish.run(args(), durableCtx());

    expect(github.pulls()[0]?.assignees).toEqual([{ login: ACCOUNT }]);
  });

  test("si GitHub no deja asignar, el PR se publica igual y queda una nota", async () => {
    github.denyAssignees();

    const result = await publish.run(args(), durableCtx());

    expect(result).toMatchObject({ outcome: "ok", output: { pr: { number: 1 } } });
    expect(github.pulls()[0]?.assignees).toEqual([]);
    expect(openedEvents()).toHaveLength(1);
    expect(store.db.$client.prepare("SELECT kind, title FROM decisions").all()).toEqual([
      { kind: "note", title: `${REPO}#1 quedó sin assignee` },
    ]);
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
    seedPr(store, { repoId: "repo_00000000000000000000000001", number: 1, headRef: BRANCH, isDraft: true, owned: false });

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

describe("pr.publish local", () => {
  let runId: RunId;
  let parentId: string;

  beforeEach(async () => {
    const project = createProjects({ store, defs }).create(NewProject.parse({ slug: "local", name: "Local", tracker: "local", stackMode: "local" }), "cli");
    runId = issueRun("CLA-53");
    store.db.$client.prepare("UPDATE runs SET project_id = ? WHERE id = ?").run(project.id, runId);
    repo.git("checkout", "-b", "cla-52");
    writeFileSync(join(repo.dir, "parent.txt"), "padre\n");
    repo.git("add", ".");
    repo.git("commit", "-m", "feat: parent");
    parentId = seedPr(store, {
      repoId: "repo_00000000000000000000000001", number: null, state: "local",
      headRef: "cla-52", title: "feat: parent", headSha: repo.git("rev-parse", "HEAD"),
    });
    workspaces.release(lease);
    lease = await workspaces.acquire({ repo: "repo_00000000000000000000000001", branch: `${BRANCH}-stacked`, base: "cla-52", runId });
    write("feature.txt", "una feature\n");
  });

  function publishParent() {
    repo.git("push", "origin", "cla-52");
    github.openPr({ head: "cla-52" });
    store.db.$client.prepare("UPDATE pull_requests SET state = 'open', number = 1, node_id = 'PR_1' WHERE id = ?").run(parentId);
  }

  const localPull = () => store.db.$client.prepare("SELECT * FROM pull_requests WHERE head_ref = ?").get(lease.branch);

  test("un padre que se pasó a local (su PR viejo quedó cerrado en GitHub) sigue siendo la base: no se recalcula sin él", async () => {
    // Así lo deja pasar un PR apilado de GitHub a local: su PR se cierra y su branch remota se borra, pero la fila sigue `local`.
    repo.git("push", "origin", "cla-52");
    github.openPr({ head: "cla-52" }).close();
    repo.git("push", "origin", "--delete", "cla-52");
    const parentCommit = repo.git("rev-parse", "cla-52");

    const result = await publish.run(args(), durableCtx(undefined, runId));

    expect(result).toMatchObject({ outcome: "local", output: { base: "cla-52" } });
    expect(repo.git("-C", lease.path, "merge-base", "--is-ancestor", parentCommit, "HEAD")).toBe("");
    expect(store.events.since(0, { types: ["decision.opened"] })).toEqual([]);
  });

  test.each(["open", "local"])("guarda sobre un padre %s sin push ni PR, con título y cuerpo limpios, claim y evento", async (state) => {
    if (state === "open") publishParent();
    const push = vi.spyOn(workspaces, "push");
    const dirty = plan({ pr: { title: "Add feature [CLA-53]\nCo-Authored-By: Claude <noreply@anthropic.com>", body: `${BODY}\nGenerated with Claude Code` } });

    const result = await publish.run(args({ plan: dirty, draft: false, dependsOn: ["api#12"] }), durableCtx(undefined, runId));

    const head = repo.git("-C", lease.path, "rev-parse", "HEAD");
    const child = localPull();
    expect(result).toEqual({ outcome: "local", output: { prId: child?.id, branch: lease.branch, base: "cla-52", head } });
    expect(child).toMatchObject({
      state: "local", number: null, node_id: null, title: "[CLA-53] Add feature",
      body: ["Depende de api#12", "", "## Contexto", "", "Por qué se hace.", "", "## Tests", "", "- [x] Tests unitarios"].join("\n"),
      head_sha: head, owned: 1, is_draft: 0, run_id: runId,
      issue_id: store.db.$client.prepare("SELECT subject_id FROM runs WHERE id = ?").get(runId)?.subject_id,
    });
    expect(store.db.$client.prepare("SELECT * FROM pr_parents").all()).toEqual([{ child_id: child?.id, parent_id: parentId }]);
    expect(store.db.$client.prepare("SELECT claimed_pr_id FROM runs WHERE id = ?").get(runId)).toEqual({ claimed_pr_id: child?.id });
    expect(store.events.since(0, { types: ["pr.saved_local"] })).toMatchObject([{
      runId, subject: { type: "pr", id: child?.id }, projectId: expect.any(String),
      payload: { repo: REPO, branch: lease.branch, base: "cla-52" },
    }]);
    expect(openedEvents()).toEqual([]);
    expect(push).not.toHaveBeenCalled();
    expect(() => remoteSha()).toThrow();
    expect(posts()).toEqual([]);
    expect(commitsOnBranch()).toEqual(["feat: add feature"]);
  });

  test("sobre la branch por defecto publica en GitHub aunque el proyecto sea local", async () => {
    workspaces.release(lease);
    lease = await workspaces.acquire({ repo: "repo_00000000000000000000000001", branch: `${BRANCH}-default`, base: "main", runId });
    write("feature.txt", "una feature\n");

    const result = await publish.run(args(), durableCtx(undefined, runId));

    expect(result).toMatchObject({ outcome: "ok", output: { head: remoteSha() } });
    expect(localPull()).toMatchObject({ state: "open", base_ref: "main" });
    expect(posts()).toHaveLength(1);
    expect(store.events.since(0, { types: ["pr.saved_local"] })).toEqual([]);
  });

  test.each(["open", "local"])("en modo remote publica sobre el padre %s y guarda su vínculo", async (state) => {
    if (state === "open") publishParent();
    else repo.git("push", "origin", "cla-52");
    store.db.$client.prepare("UPDATE projects SET stack_mode = 'remote'").run();

    const result = await publish.run(args(), durableCtx(undefined, runId));

    expect(result).toMatchObject({ outcome: "ok", output: { head: remoteSha() } });
    expect(localPull()).toMatchObject({ state: "open", base_ref: "cla-52" });
    expect(store.db.$client.prepare("SELECT * FROM pr_parents").all()).toEqual([{ child_id: localPull()?.id, parent_id: parentId }]);
    expect(posts()).toHaveLength(1);
  });

  test.each(["local", "remote"])("un reintento conserva el modo %s aunque cambie la configuración del proyecto", async (mode) => {
    publishParent();
    store.db.$client.prepare("UPDATE projects SET stack_mode = ?").run(mode);
    const stage = mode === "local" ? "local" : "pr";
    const ctx = durableCtx(stage, runId);
    const push = vi.spyOn(workspaces, "push");
    await expect(publish.run(args(), ctx)).rejects.toThrow(`corte después de ${stage}`);
    const savedLocal = localPull();
    store.db.$client.prepare("UPDATE projects SET stack_mode = ?").run(mode === "local" ? "remote" : "local");

    const result = await publish.run(args(), ctx);
    const again = await publish.run(args(), ctx);

    expect(again).toEqual(result);
    expect(store.db.$client.prepare("SELECT * FROM pull_requests WHERE head_ref = ?").all(lease.branch)).toHaveLength(1);
    expect(store.db.$client.prepare("SELECT * FROM pr_parents").all()).toEqual([{ child_id: localPull()?.id, parent_id: parentId }]);
    if (mode === "local") {
      expect(result).toMatchObject({ outcome: "local", output: { prId: savedLocal?.id } });
      expect(localPull()).toEqual(savedLocal);
      expect(store.events.since(0, { types: ["pr.saved_local"] })).toHaveLength(1);
      expect(push).not.toHaveBeenCalled();
      expect(() => remoteSha()).toThrow();
      expect(posts()).toEqual([]);
    } else {
      expect(result).toMatchObject({ outcome: "ok", output: { head: remoteSha() } });
      expect(localPull()).toMatchObject({ state: "open" });
      expect(store.events.since(0, { types: ["pr.saved_local"] })).toEqual([]);
      expect(push).toHaveBeenCalledTimes(1);
      expect(posts()).toHaveLength(1);
    }
  });

  test.each(["local:prepare", "reset", "local"])("un corte después de %s con autosquash no duplica la fila ni rechaza sus propios commits", async (stage) => {
    write("z.txt", "fixup\n");
    const input = publish.args.parse({
      ...args(), messagePattern: "^(feat:|fixup! feat:)",
      plan: plan({ commits: [
        { message: "feat: add feature", hunks: ["h1"], tests: [] },
        { message: "fixup! feat: add feature", hunks: ["h2"], tests: [] },
      ] }),
    });
    const ctx = durableCtx(stage, runId);
    if (stage === "reset") {
      const git = workspaces.git;
      let crash = true;
      let prepared = false;
      const once = ctx.once;
      ctx.once = async (name, fn) => {
        const result = await once(name, fn);
        if (name === "local:prepare") prepared = true;
        return result;
      };
      vi.spyOn(workspaces, "git").mockImplementation(async (ws, ...command) => {
        const result = await git(ws, ...command);
        if (crash && prepared && ws.path === lease.path && command[0] === "reset" && command[2] === "--mixed") {
          crash = false;
          throw new Error("corte después de reset");
        }
        return result;
      });
    }

    await expect(publish.run(input, ctx)).rejects.toThrow(`corte después de ${stage}`);
    expect(localPull() !== undefined).toBe(stage === "local");
    const result = await publish.run(input, ctx);
    const requests = github.requests.length;
    const again = await publish.run(input, ctx);

    expect(result).toMatchObject({ outcome: "local", output: { prId: localPull()?.id, head: repo.git("-C", lease.path, "rev-parse", "HEAD") } });
    expect(again).toEqual(result);
    expect(github.requests).toHaveLength(requests);
    expect(commitsOnBranch()).toEqual(["feat: add feature"]);
    expect(store.events.since(0, { types: ["pr.saved_local"] })).toHaveLength(1);
    expect(store.db.$client.prepare("SELECT * FROM pr_parents").all()).toHaveLength(1);
    expect(() => remoteSha()).toThrow();
    expect(posts()).toEqual([]);
  });

  test.each(["bad message", "fixup! feat: missing"])("conserva el fallo de preparePush para %s", async (message) => {
    const ctx = durableCtx(undefined, runId);
    const once = ctx.once;
    ctx.once = async (stage, fn) => {
      if (stage === "local") {
        write("z.txt", "otro commit\n");
        repo.git("-C", lease.path, "add", ".");
        repo.git("-C", lease.path, "commit", "-m", message);
      }
      return once(stage, fn);
    };

    const result = publish.run(args(), ctx);

    if (message === "bad message") {
      await expect(result).resolves.toMatchObject({ outcome: "replan", output: { failures: expect.stringContaining("el mensaje no cumple") } });
    } else {
      await expect(result).rejects.toThrow(PermanentActionError);
    }
    expect(localPull()).toBeUndefined();
    expect(posts()).toEqual([]);
    expect(() => remoteSha()).toThrow();
  });

  test.each(["reescritura", "cambio sin commit"])("un %s ajeno después de preparar no se acepta ni se pierde", async (change) => {
    const ctx = durableCtx(undefined, runId);
    const once = ctx.once;
    let crash = true;
    ctx.once = async (stage, fn) => {
      const result = await once(stage, fn);
      if (stage === "local:prepare" && crash) {
        crash = false;
        throw new Error("corte después de local:prepare");
      }
      return result;
    };
    await expect(publish.run(args(), ctx)).rejects.toThrow("corte después de local:prepare");
    if (change === "reescritura") repo.git("-C", lease.path, "commit", "--amend", "-m", "feat: rewritten elsewhere");
    else write("feature.txt", "cambio ajeno\n");
    const foreign = repo.git("-C", lease.path, "rev-parse", "HEAD");

    const result = await publish.run(args(), ctx);

    expect(result).toMatchObject({ outcome: "replan", output: { failures: expect.stringContaining("después de preparar") } });
    expect(repo.git("-C", lease.path, "rev-parse", "HEAD")).toBe(foreign);
    if (change === "cambio sin commit") expect(repo.git("-C", lease.path, "diff")).toContain("cambio ajeno");
    expect(localPull()).toBeUndefined();
  });
});

describe("en un flujo", () => {
  let flows: Flows;

  afterEach(async () => {
    await flows.close();
  });

  function flowWith(publishNode: object, base = "main"): Flows {
    const unused = {
      id: "fake" as const,
      capabilities: { costPerTurn: true },
      start: () => Promise.reject(new Error("no se usa")),
      resume: () => Promise.reject(new Error("no se usa")),
    };
    flows = createFlows({
      store,
      defs,
      agents: createAgents({ store, defs, runtimes: createRuntimeRegistry([unused], {}) }),
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
            args: { repo: "repo_00000000000000000000000001", branch: "cla-53-flow", base },
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
      on: { ok: "@done", local: "@done", replan: "@failed" },
    });

    const runId = flows.start("publish-flow", { type: "issue", id: "CLA-53" }, {});
    await finished(runId);

    expect(flows.getRun(runId)).toMatchObject({ status: "done", outcome: "done" });
    const [row] = store.db.$client
      .prepare("SELECT id, repo_id, number, head_ref, base_ref, state, is_draft, issue_id, run_id, owned FROM pull_requests")
      .all() as { id: string; run_id: string }[];
    expect(row).toMatchObject({
      repo_id: "repo_00000000000000000000000001",
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
      on: { ok: "@done", local: "@done", replan: "@blocked" },
    });

    const runId = flows.start("publish-flow", { type: "issue", id: "CLA-53" }, {});
    await finished(runId);

    expect(flows.getRun(runId)).toMatchObject({ status: "failed", outcome: "blocked" });
    expect(flows.getRun(runId).steps.find((s) => s.nodeId === "publish")).toMatchObject({ outcome: "replan" });
    expect(github.pulls()).toEqual([]);
  });

  test("el PR local queda enlazado a su padre y la corrida termina done sin publicar", async () => {
    workspaces.release(lease);
    const project = createProjects({ store, defs }).create(NewProject.parse({ slug: "local", name: "Local", tracker: "local", stackMode: "local" }), "cli");
    repo.git("branch", "cla-52");
    const parentId = seedPr(store, { repoId: "repo_00000000000000000000000001", number: null, state: "local", headRef: "cla-52", title: "Padre" });
    const push = vi.spyOn(workspaces, "push");
    flowWith({
      type: "action", action: "pr.publish", args: { ws: "$ws", plan: plan() },
      on: { local: "@done", ok: "@failed", replan: "@failed" },
    }, "cla-52");

    const runId = flows.start("publish-flow", { type: "issue", id: "CLA-53" }, {}, { projectId: project.id });
    await finished(runId);

    expect(flows.getRun(runId)).toMatchObject({ status: "done", outcome: "done" });
    const child = store.db.$client.prepare("SELECT id, state FROM pull_requests WHERE head_ref = 'cla-53-flow'").get();
    expect(child).toMatchObject({ state: "local" });
    expect(store.db.$client.prepare("SELECT * FROM pr_parents").all()).toEqual([{ child_id: child?.id, parent_id: parentId }]);
    expect(store.db.$client.prepare("SELECT claimed_pr_id FROM runs WHERE id = ?").get(runId)).toEqual({ claimed_pr_id: child?.id });
    expect(push).not.toHaveBeenCalled();
    expect(posts()).toEqual([]);
    expect(() => repo.git("--git-dir", repo.remoteDir!, "rev-parse", "refs/heads/cla-53-flow")).toThrow();
  });
});
