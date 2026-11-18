import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createArtifacts,
  createAskpass,
  createConnections,
  createDefs,
  createFileSecrets,
  createGitRemote,
  createPacks,
  createPrs,
  createRecipes,
  createSlots,
  createWorkspaces,
  newId,
  openStore,
  PermanentActionError,
  prPublishAction,
  prPushFixupsAction,
  StaleLeaseError,
  type ActionCtx,
  type Askpass,
  type Store,
  type WorkspaceLease,
  type Workspaces,
} from "@clanker/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tempGitRepo, type TempGitRepo } from "./git";
import { startGitHubSim, type GitHubSim } from "./github-sim";

// Como pr-publish.test.ts: repos git reales (tempGitRepo), un remoto bare y el GitHub simulado.

const TOKEN = "github_pat_UNIQUE-0123456789";
const ACCOUNT = "octocat";
const REPO = "octocat/secret-project";
const BRANCH = "cla-56";
const lines = (n: number, tag = "l") => Array.from({ length: n }, (_, i) => `${tag}${i + 1}\n`);
const file = (content: string[]) => content.join("");

let dataDir: string;
let store: Store;
let repo: TempGitRepo;
let askpass: Askpass;
let workspaces: Workspaces;
let github: GitHubSim;
let lease: WorkspaceLease;
let publish: ReturnType<typeof prPublishAction>;
let pushFixups: ReturnType<typeof prPushFixupsAction>;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "clanker-fixups-"));
  store = openStore({ path: ":memory:" });
  repo = tempGitRepo({
    remote: true,
    commits: [{ message: "chore: base", files: { "a.txt": "a\n", "c.txt": file(lines(30)) } }],
  });
  github = await startGitHubSim({ origin: repo, repo: REPO, token: TOKEN });

  askpass = createAskpass();
  const connections = createConnections({ store, secrets: createFileSecrets({ dir: join(dataDir, "secrets") }), github: { baseUrl: github.baseUrl } });
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
  const defs = createDefs({ store });
  const packs = createPacks({ defs });
  const packDir = join(dataDir, "pack");
  mkdirSync(packDir);
  writeFileSync(
    join(packDir, "pack.json"),
    JSON.stringify({ id: "acme", version: 1, activate: { githubOrgs: ["octocat"] }, conventions: { councilPrefix: "[clanker-council] " } }),
  );
  await packs.load(packDir);
  publish = prPublishAction({
    store,
    workspaces,
    recipes: createRecipes({ store, defs, workspaces, artifacts: createArtifacts({ store, dir: join(dataDir, "artifacts") }), slots: createSlots({ store }) }),
    repoConfig: repos,
    connections,
    packs,
  });
  pushFixups = prPushFixupsAction({ store, workspaces, repoConfig: repos, prs: createPrs({ connections, packs }) });

  lease = await workspaces.acquire({ repo: "repo_r1", branch: BRANCH, base: "main", runId: newId("run") });
  // El PR ya publicado: dos commits, uno sobre la línea 2 de c.txt y otro sobre la 28.
  write("c.txt", file(lines(30)).replace("l2\n", "top\n").replace("l28\n", "bottom\n"));
  const { workspaceId, path, branch, baseSha, fencingToken } = lease;
  const published = await publish.run(
    publish.args.parse({
      ws: { workspaceId, path, branch, baseSha, fencingToken },
      plan: {
        commits: [
          { message: "feat: top", hunks: ["h1"], tests: [] },
          { message: "feat: bottom", hunks: ["h2"], tests: [] },
        ],
        pr: { title: "[CLA-56] fixups", body: "" },
      },
    }),
    durableCtx(),
  );
  expect(published.outcome).toBe("ok");
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

const local = (...args: string[]) => repo.git("-C", lease.path, ...args);
const remote = (...args: string[]) => repo.git("--git-dir", repo.remoteDir!, ...args);
const remoteSha = () => remote("rev-parse", `refs/heads/${BRANCH}`);
const subjects = (ref: string) => local("log", "--reverse", "--format=%s", `${lease.baseSha}..${ref}`).split("\n").filter(Boolean);
const shaOf = (subject: string) => local("log", "--format=%H", "--grep", `^${subject}$`, `${lease.baseSha}..HEAD`);
const inCommit = (sha: string) => local("show", "--format=", sha);

/** Un commit más de la branch, pusheado como lo dejaría una corrida. */
async function commitAndPush(content: string, message: string) {
  write("c.txt", content);
  local("add", "c.txt");
  local("commit", "--quiet", "--message", message);
  await workspaces.push(args().ws);
}

type Route = { commits: { message: string; hunks: string[]; into?: string }[] };

function args(overrides: { items?: { id: string; path?: string; line?: number }[]; route?: Route } = {}) {
  const { workspaceId, path, branch, baseSha, fencingToken } = lease;
  return pushFixups.args.parse({ ws: { workspaceId, path, branch, baseSha, fencingToken }, ...overrides });
}

/** Un `ctx.once` que guarda como el motor y, con `crashAfter`, muere justo después del efecto de esa etapa. */
function durableCtx(crashAfter?: string) {
  const saved = new Map<string, unknown>();
  let crash = crashAfter;
  const ctx: ActionCtx = {
    runId: newId("run"),
    stepId: newId("stp"),
    key: "run:fixups:1",
    signal: new AbortController().signal,
    async once(stage, fn) {
      if (saved.has(stage)) return saved.get(stage) as never;
      if (crash === `before:${stage}`) {
        crash = undefined;
        throw new Error(`corte antes de ${stage}`);
      }
      const result = await fn();
      if (stage === crash) {
        crash = undefined;
        throw new Error(`corte después de ${stage}`);
      }
      saved.set(stage, JSON.parse(JSON.stringify(result)));
      return result;
    },
  };
  return { ...ctx, saved };
}

const fixed = () => file(lines(30)).replace("l2\n", "top fixed\nextra\n").replace("l28\n", "bottom fixed\n");

describe("pr.pushFixups", () => {
  test("items y route en null (el motor deja null el ref de un nodo que todavía no corrió) son ninguno", () => {
    const ws = { workspaceId: "wsp_1", path: "/w", branch: "b", baseSha: "0".repeat(40), fencingToken: 1 };

    for (const given of [{ items: null, route: null }, {}]) {
      const args = pushFixups.args.parse({ ws, ...given });
      expect(args.items).toEqual([]);
      expect(args.route).toBeUndefined();
    }
  });

  test("un hunk sobre líneas de un commit va a su fixup y, tras el autosquash, queda dentro de ese commit", async () => {
    const [top, bottom] = [shaOf("feat: top"), shaOf("feat: bottom")];
    write("c.txt", fixed());

    const result = await pushFixups.run(
      args({ items: [{ id: "b1", path: "c.txt", line: 2 }, { id: "b2", path: "c.txt", line: 28 }, { id: "ci" }] }),
      durableCtx(),
    );

    // Un commit por destino, sin fixup! en la branch ni en el remoto, y lo pusheado es lo local.
    expect(subjects("HEAD")).toEqual(["feat: top", "feat: bottom"]);
    expect(remoteSha()).toBe(local("rev-parse", "HEAD"));
    expect(subjects(remoteSha())).toEqual(["feat: top", "feat: bottom"]);
    // Cada arreglo quedó en su commit, que ahora tiene otro sha.
    const [newTop, newBottom] = [shaOf("feat: top"), shaOf("feat: bottom")];
    expect(newTop).not.toBe(top);
    expect(newBottom).not.toBe(bottom);
    expect(inCommit(newTop)).toContain("+top fixed");
    expect(inCommit(newTop)).not.toContain("bottom fixed");
    expect(inCommit(newBottom)).toContain("+bottom fixed");
    expect(result).toEqual({
      outcome: "ok",
      output: { byItem: { b1: newTop, b2: newBottom, ci: remoteSha() }, head: remoteSha(), from: bottom, to: remoteSha() },
    });
    expect(local("status", "--porcelain")).toBe("");
  });

  test("un hunk nuevo sin dueño da route sin tocar la branch ni el remoto", async () => {
    const head = local("rev-parse", "HEAD");
    write("c.txt", fixed());
    write("nuevo.txt", "algo nuevo\n");

    const result = await pushFixups.run(args(), durableCtx());

    // h1 y h2 son los de c.txt (van a sus fixups); h3 es el archivo nuevo. Los commits del PR son sus destinos posibles.
    expect(result).toEqual({
      outcome: "route",
      output: {
        unrouted: ["h3"],
        commits: [
          { sha: shaOf("feat: top"), subject: "feat: top" },
          { sha: shaOf("feat: bottom"), subject: "feat: bottom" },
        ],
      },
    });
    expect(local("rev-parse", "HEAD")).toBe(head);
    expect(remoteSha()).toBe(head);
  });

  test("con el reporte del committer, los hunks sin dueño salen como commits nuevos y se pushea todo", async () => {
    write("c.txt", fixed());
    write("nuevo.txt", "algo nuevo\n");
    const route = { commits: [{ message: "feat: add nuevo", hunks: ["h3"] }] };

    const result = await pushFixups.run(args({ route, items: [{ id: "nuevo", path: "nuevo.txt" }] }), durableCtx());

    expect(subjects("HEAD")).toEqual(["feat: top", "feat: bottom", "feat: add nuevo"]);
    expect(inCommit(shaOf("feat: add nuevo"))).toContain("+algo nuevo");
    expect(remoteSha()).toBe(local("rev-parse", "HEAD"));
    expect(result).toMatchObject({ outcome: "ok", output: { byItem: { nuevo: shaOf("feat: add nuevo") } } });
  });

  test("con into, un hunk sin dueño se suma al commit del PR que nombra y queda dentro de él tras el autosquash", async () => {
    write("nuevo.txt", "algo nuevo\n");
    const route = { commits: [{ message: "", hunks: ["h1"], into: shaOf("feat: top").slice(0, 9) }] };

    const result = await pushFixups.run(args({ route, items: [{ id: "nuevo", path: "nuevo.txt" }] }), durableCtx());

    expect(subjects("HEAD")).toEqual(["feat: top", "feat: bottom"]);
    expect(inCommit(shaOf("feat: top"))).toContain("+algo nuevo");
    expect(remoteSha()).toBe(local("rev-parse", "HEAD"));
    expect(result).toMatchObject({ outcome: "ok", output: { byItem: { nuevo: shaOf("feat: top") } } });
  });

  test("un commit nuevo que repite el título de uno del PR, o un into que no nombra uno, vuelve a route con el motivo", async () => {
    write("nuevo.txt", "algo nuevo\n");
    write("otro.txt", "otro\n");
    const head = local("rev-parse", "HEAD");
    const route = {
      commits: [
        { message: "feat: top", hunks: ["h1"] },
        { message: "", hunks: ["h2"], into: "0000000" },
      ],
    };

    const result = await pushFixups.run(args({ route }), durableCtx());

    expect(result).toMatchObject({
      outcome: "route",
      output: {
        unrouted: ["h1", "h2"],
        failures: expect.stringMatching(/repite el título de un commit del PR[\s\S]*0000000 no es el sha de un único commit del PR/),
      },
    });
    expect(local("rev-parse", "HEAD")).toBe(head);
  });

  test("un reporte que no cubre los hunks sin destino vuelve a route con el motivo", async () => {
    write("nuevo.txt", "algo nuevo\n");
    const head = local("rev-parse", "HEAD");

    const result = await pushFixups.run(args({ route: { commits: [{ message: "arreglo", hunks: ["h9"] }] } }), durableCtx());

    expect(result).toMatchObject({
      outcome: "route",
      output: { unrouted: ["h1"], failures: expect.stringContaining("h9") },
    });
    expect(local("rev-parse", "HEAD")).toBe(head);
  });

  test("un hunk que cambia líneas de la base y no de la branch también va al committer", async () => {
    write("c.txt", file(lines(30)).replace("l2\n", "top\n").replace("l28\n", "bottom\n").replace("l15\n", "mid\n"));

    const result = await pushFixups.run(args(), durableCtx());

    expect(result).toMatchObject({ outcome: "route", output: { unrouted: ["h1"] } });
  });

  test("con council los fixup! quedan en el remoto, sin autosquash y sin force push", async () => {
    github.pr(1).councilThread("el nombre no calza");
    const before = remoteSha();
    write("c.txt", fixed());

    const result = await pushFixups.run(args({ items: [{ id: "b1", path: "c.txt", line: 2 }] }), durableCtx());

    const fixup = shaOf("fixup! feat: top");
    expect(subjects(remoteSha())).toEqual(["feat: top", "feat: bottom", "fixup! feat: top", "fixup! feat: bottom"]);
    // El push avanza la punta anterior: nada se reescribió.
    expect(remote("merge-base", "--is-ancestor", before, remoteSha())).toBe("");
    expect(remoteSha()).toBe(local("rev-parse", "HEAD"));
    expect(inCommit(fixup)).toContain("+top fixed");
    expect(result).toEqual({ outcome: "ok", output: { byItem: { b1: fixup }, head: remoteSha(), from: before, to: remoteSha() } });
  });

  test("un fixup! de un PR con council se vuelve a atar al commit original, no al fixup", async () => {
    github.pr(1).councilThread("el nombre no calza");
    write("c.txt", fixed());
    await pushFixups.run(args(), durableCtx());

    // Otra ronda sobre las líneas que cambió el fixup.
    write("c.txt", fixed().replace("top fixed\n", "top fixed again\n"));
    await pushFixups.run(args(), durableCtx());

    expect(subjects(remoteSha()).slice(2)).toEqual([
      "fixup! feat: top",
      "fixup! feat: bottom",
      "fixup! feat: top",
    ]);
  });

  test("dos commits con el mismo subject se distinguen por sha", async () => {
    // Un tercer commit con el subject del primero, hecho a mano y pusheado como lo dejó la corrida.
    write("c.txt", file(lines(30)).replace("l2\n", "top\n").replace("l28\n", "bottom\n").replace("l10\n", "ten\n"));
    local("add", "c.txt");
    local("commit", "--quiet", "--message", "feat: top");
    await workspaces.push(args().ws);
    expect(shaOf("feat: top").split("\n")).toHaveLength(2);
    write("c.txt", file(lines(30)).replace("l2\n", "top\n").replace("l28\n", "bottom\n").replace("l10\n", "ten fixed\n"));

    await pushFixups.run(args(), durableCtx());

    // El arreglo es del commit más nuevo (el de la línea 10): quedó ahí y no en el primer "feat: top".
    const [older, newer] = shaOf("feat: top").split("\n").reverse();
    expect(inCommit(newer!)).toContain("+ten fixed");
    expect(inCommit(older!)).not.toContain("ten fixed");
  });

  test("un hunk que cambia líneas de dos commits va al más nuevo, donde el autosquash lo puede poner", async () => {
    // `feat: pair` es dueño de dos de las tres líneas que cambian; `feat: twelve`, más nuevo, de la otra.
    const pair = file(lines(30)).replace("l2\n", "top\n").replace("l28\n", "bottom\n").replace("l10\nl11\n", "ten\neleven\n");
    await commitAndPush(pair, "feat: pair");
    const twelve = pair.replace("l12\n", "twelve\n");
    await commitAndPush(twelve, "feat: twelve");
    write("c.txt", twelve.replace("ten\neleven\ntwelve\n", "ten fixed\neleven fixed\ntwelve fixed\n"));

    const result = await pushFixups.run(args(), durableCtx());

    expect(result.outcome).toBe("ok");
    expect(subjects(remoteSha())).toEqual(["feat: top", "feat: bottom", "feat: pair", "feat: twelve"]);
    expect(inCommit(shaOf("feat: twelve"))).toContain("+ten fixed");
  });

  test("un hunk pegado a una línea de un commit más nuevo que su destino va al committer", async () => {
    // Arreglar la línea 2 (de `feat: top`) choca en el autosquash con la 3, que cambió `feat: three`.
    const three = file(lines(30)).replace("l2\n", "top\n").replace("l28\n", "bottom\n").replace("l3\n", "three\n");
    await commitAndPush(three, "feat: three");
    const head = local("rev-parse", "HEAD");
    write("c.txt", three.replace("top\n", "top fixed\n"));

    const result = await pushFixups.run(args(), durableCtx());

    expect(result).toMatchObject({ outcome: "route", output: { unrouted: ["h1"] } });
    expect(local("rev-parse", "HEAD")).toBe(head);
  });

  test("sin cambios no hay nada que commitear y el push es noop", async () => {
    const head = local("rev-parse", "HEAD");

    const result = await pushFixups.run(args({ items: [{ id: "x", path: "c.txt", line: 2 }] }), durableCtx());

    expect(result).toEqual({ outcome: "ok", output: { byItem: { x: head }, head, from: head, to: head } });
    expect(remoteSha()).toBe(head);
  });

  test("lo que el agente commiteó por su cuenta sin cuadrar con el worktree se rutea como cualquier cambio", async () => {
    write("c.txt", fixed());
    local("add", "c.txt");
    local("commit", "--quiet", "--message", "wip");
    write("c.txt", fixed().replace("bottom fixed\n", "bottom fixed too\n"));

    const result = await pushFixups.run(args(), durableCtx());

    expect(result.outcome).toBe("ok");
    expect(subjects("HEAD")).toEqual(["feat: top", "feat: bottom"]);
    expect(inCommit(shaOf("feat: bottom"))).toContain("+bottom fixed too");
  });

  test("si alguien más pusheó la branch, no se reintenta y los fixups quedan locales", async () => {
    write("c.txt", fixed());
    remote("update-ref", `refs/heads/${BRANCH}`, lease.baseSha);

    await expect(pushFixups.run(args(), durableCtx())).rejects.toThrow(PermanentActionError);

    expect(remoteSha()).toBe(lease.baseSha);
  });

  test.each(["commit", "before:push", "push"])("un corte en %s: el reintento deja el remoto con el arreglo una sola vez", async (stage) => {
    const from = local("rev-parse", "HEAD");
    write("c.txt", fixed());
    const input = args({ items: [{ id: "b1", path: "c.txt", line: 2 }] });
    const ctx = durableCtx(stage);
    await expect(pushFixups.run(input, ctx)).rejects.toThrow(stage === "before:push" ? "corte antes de push" : `corte después de ${stage}`);
    if (stage === "before:push") {
      expect(ctx.saved.get("commit")).toEqual({
        made: [
          { sha: shaOf("fixup! feat: top"), lands: shaOf("feat: top"), spans: expect.any(Array) },
          { sha: shaOf("fixup! feat: bottom"), lands: shaOf("feat: bottom"), spans: expect.any(Array) },
        ],
      });
    }

    const result = await pushFixups.run(input, ctx);

    expect(result).toMatchObject({ outcome: "ok", output: { byItem: { b1: shaOf("feat: top") }, from, to: remoteSha(), head: remoteSha() } });
    expect(await pushFixups.run(input, ctx)).toEqual(result);
    expect(subjects(remoteSha())).toEqual(["feat: top", "feat: bottom"]);
    expect(remote("show", "--format=", `refs/heads/${BRANCH}:c.txt`)).toBe(fixed().trimEnd());
  });

  test("a un PR que el sistema no abrió (lo descubrió Watch) no se le pushea", async () => {
    store.db.$client.prepare("UPDATE pull_requests SET owned = 0").run();
    const before = remoteSha();
    write("c.txt", fixed());

    await expect(pushFixups.run(args({ items: [{ id: "b1", path: "c.txt", line: 2 }] }), durableCtx())).rejects.toThrow(/no lo abrió Clanker Yard/);
    expect(remoteSha()).toBe(before);
  });

  test("sin un PR abierto de la branch falla sin reintentos", async () => {
    store.db.$client.prepare("UPDATE pull_requests SET state = 'closed'").run();

    await expect(pushFixups.run(args(), durableCtx())).rejects.toThrow(PermanentActionError);
  });
});

describe("pr.pushFixups con un PR local", () => {
  let requests: number;

  beforeEach(() => {
    github.pr(1).close();
    remote("update-ref", "-d", `refs/heads/${BRANCH}`);
    local("update-ref", "-d", `refs/remotes/origin/${BRANCH}`);
    store.db.$client.prepare("UPDATE pull_requests SET state = 'local', number = NULL, node_id = NULL, title = 'Fixups locales', head_changed_at = 0").run();
    store.db.$client.prepare("UPDATE workspaces SET remote_sha = NULL").run();
    requests = github.requests.length;
    vi.spyOn(workspaces, "push");
  });

  afterEach(() => {
    expect(github.requests.slice(requests)).toEqual([]);
    expect(workspaces.push).not.toHaveBeenCalled();
    expect(() => remoteSha()).toThrow();
    expect(store.db.$client.prepare("SELECT remote_sha FROM workspaces").get()).toEqual({ remote_sha: null });
  });

  test("squashea el arreglo en el primero de dos commits y guarda la punta sin publicar", async () => {
    const from = local("rev-parse", "HEAD");
    const top = shaOf("feat: top");
    write("c.txt", file(lines(30)).replace("l2\n", "top fixed\n").replace("l28\n", "bottom\n"));

    const result = await pushFixups.run(args({ items: [{ id: "b1", path: "c.txt", line: 2 }, { id: "ci" }] }), durableCtx());

    const head = local("rev-parse", "HEAD");
    const newTop = shaOf("feat: top");
    expect(subjects("HEAD")).toEqual(["feat: top", "feat: bottom"]);
    expect(newTop).not.toBe(top);
    expect(head).not.toBe(from);
    expect(inCommit(newTop)).toContain("+top fixed");
    expect(inCommit(shaOf("feat: bottom"))).not.toContain("top fixed");
    expect(result).toEqual({
      outcome: "ok",
      output: { byItem: { b1: newTop, ci: head }, head, from, to: head },
    });
    expect(store.db.$client.prepare("SELECT state, head_sha, head_changed_at FROM pull_requests").get()).toEqual({
      state: "local", head_sha: head, head_changed_at: expect.any(Number),
    });
    expect(store.db.$client.prepare("SELECT head_changed_at FROM pull_requests").get()?.head_changed_at).toBeGreaterThan(0);
    expect(local("status", "--porcelain")).toBe("");
  });

  test.each(["nuevo", "into"])("un hunk sin dueño vuelve al committer y su ruta %s se guarda sin publicar", async (destination) => {
    const from = local("rev-parse", "HEAD");
    const top = shaOf("feat: top");
    write("nuevo.txt", "algo nuevo\n");

    const routed = await pushFixups.run(args(), durableCtx());

    expect(routed).toEqual({
      outcome: "route",
      output: { unrouted: ["h1"], commits: [{ sha: top, subject: "feat: top" }, { sha: from, subject: "feat: bottom" }] },
    });
    expect(local("rev-parse", "HEAD")).toBe(from);
    expect(store.db.$client.prepare("SELECT head_sha FROM pull_requests").get()).toEqual({ head_sha: from });

    const route = { commits: [{ message: "feat: add nuevo", hunks: ["h1"], ...(destination === "into" && { into: top }) }] };
    const result = await pushFixups.run(args({ route, items: [{ id: "nuevo", path: "nuevo.txt" }] }), durableCtx());

    const head = local("rev-parse", "HEAD");
    const target = shaOf(destination === "into" ? "feat: top" : "feat: add nuevo");
    expect(subjects("HEAD")).toEqual(["feat: top", "feat: bottom", ...(destination === "into" ? [] : ["feat: add nuevo"])]);
    expect(inCommit(target)).toContain("+algo nuevo");
    expect(result).toEqual({ outcome: "ok", output: { byItem: { nuevo: target }, head, from, to: head } });
    expect(store.db.$client.prepare("SELECT head_sha FROM pull_requests").get()).toEqual({ head_sha: head });
  });

  test("sin cambios conserva la punta", async () => {
    const head = local("rev-parse", "HEAD");

    const result = await pushFixups.run(args({ items: [{ id: "ci" }] }), durableCtx());

    expect(result).toEqual({ outcome: "ok", output: { byItem: { ci: head }, head, from: head, to: head } });
    expect(subjects("HEAD")).toEqual(["feat: top", "feat: bottom"]);
    expect(store.db.$client.prepare("SELECT head_sha FROM pull_requests").get()).toEqual({ head_sha: head });
  });

  test.each(["commit", "before:push", "push"])("un corte en %s no duplica commits y conserva la punta inicial", async (stage) => {
    const from = local("rev-parse", "HEAD");
    write("c.txt", fixed());
    const input = args({ items: [{ id: "b1", path: "c.txt", line: 2 }] });
    const ctx = durableCtx(stage);
    await expect(pushFixups.run(input, ctx)).rejects.toThrow(stage === "before:push" ? "corte antes de push" : `corte después de ${stage}`);

    const result = await pushFixups.run(input, ctx);

    const head = local("rev-parse", "HEAD");
    expect(result).toEqual({ outcome: "ok", output: { byItem: { b1: shaOf("feat: top") }, head, from, to: head } });
    expect(await pushFixups.run(input, ctx)).toEqual(result);
    expect(subjects("HEAD")).toEqual(["feat: top", "feat: bottom"]);
    expect(local("show", "HEAD:c.txt")).toBe(fixed().trimEnd());
    expect(store.db.$client.prepare("SELECT head_sha FROM pull_requests").get()).toEqual({ head_sha: head });
  });

  test("si el lease cambia al terminar el squash no guarda la punta del PR local", async () => {
    const head = local("rev-parse", "HEAD");
    write("c.txt", fixed());
    const git = workspaces.git;
    let squashed = false;
    vi.spyOn(workspaces, "git").mockImplementation(async (ws, ...command) => {
      const result = await git(ws, ...command);
      if (command.includes("--autosquash")) squashed = true;
      if (squashed && command[0] === "log" && command[1] === "--format=%s") {
        store.db.$client.prepare("UPDATE workspaces SET fencing_token = fencing_token + 1").run();
      }
      return result;
    });

    await expect(pushFixups.run(args(), durableCtx())).rejects.toThrow(StaleLeaseError);

    expect(local("rev-parse", "HEAD")).not.toBe(head);
    expect(store.db.$client.prepare("SELECT head_sha, head_changed_at FROM pull_requests").get()).toEqual({ head_sha: head, head_changed_at: 0 });
  });

  test("rechaza un PR local ajeno sin cambiar su punta", async () => {
    const head = local("rev-parse", "HEAD");
    store.db.$client.prepare("UPDATE pull_requests SET owned = 0").run();
    write("c.txt", fixed());

    await expect(pushFixups.run(args(), durableCtx())).rejects.toThrow(PermanentActionError);

    expect(local("rev-parse", "HEAD")).toBe(head);
    expect(store.db.$client.prepare("SELECT head_sha, head_changed_at FROM pull_requests").get()).toEqual({ head_sha: head, head_changed_at: 0 });
  });
});
