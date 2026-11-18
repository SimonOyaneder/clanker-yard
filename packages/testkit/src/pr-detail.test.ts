import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_PR_PATCH_MAX } from "@clanker/api";
import { createAskpass, createConnections, createFileSecrets, createGitRemote, createPrDetails, createWorkspaces, openStore, type Askpass, type Connections, type Store, type Workspaces } from "@clanker/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { tempGitRepo, type TempGitRepo } from "./git";
import { startGitHubSim, type GitHubSim } from "./github-sim";
import { startGitHttpServer } from "./git-http";

let store: Store;
let repo: TempGitRepo;
let sim: GitHubSim;
let connections: Connections;
let askpass: Askpass;
let workspaces: Workspaces;
let gitServer: Awaited<ReturnType<typeof startGitHttpServer>>;
let other: TempGitRepo | undefined;
const ACCOUNT = "octocat";
const TOKEN = "github_pat_detail_test";
const REPO = "octocat/secret";

beforeEach(async () => {
  store = openStore({ path: ":memory:" });
  repo = tempGitRepo({
    remote: true,
    commits: [{ message: "chore: base", files: { "a.txt": "a1\na2\n" } }],
    branches: { "cla-1": [{ message: "feat: padre", files: { "a.txt": "a1\npadre\n" } }] },
  });
  repo.git("checkout", "--quiet", "-b", "cla-2", "origin/cla-1");
  for (const [message, file, content] of [
    ["feat(b): agregar b\n\nPorque hace falta.", "b.txt", "b1\nb2\n"],
    ["test(b): cubrir b", "b.test.txt", "ok\n"],
  ] as const) {
    writeFileSync(join(repo.dir, file), content);
    repo.git("add", "--all");
    repo.git("commit", "--quiet", "-m", message);
  }
  repo.git("checkout", "--quiet", "main");
  sim = await startGitHubSim({ origin: repo, repo: REPO, account: ACCOUNT, token: TOKEN });
  gitServer = await startGitHttpServer(repo.remoteDir!, { user: ACCOUNT, password: TOKEN });
  connections = createConnections({
    store,
    secrets: createFileSecrets({ dir: join(repo.dir, ".git", "detail-secrets") }),
    github: { baseUrl: sim.baseUrl },
  });
  await connections.connect({ provider: "github", account: ACCOUNT, scopes: [], token: TOKEN }, "core");
  askpass = createAskpass();
  workspaces = createWorkspaces({
    store,
    dataDir: join(repo.dir, ".git", "details"),
    repoConfig: config,
    remote: createGitRemote({ askpass, connections }),
    identityOf: async () => ({ name: "Clanker Test", email: "test@clanker.invalid" }),
  });
});

afterEach(async () => {
  await askpass.close();
  await gitServer.close();
  await sim.close();
  other?.cleanup();
  other = undefined;
  repo.cleanup();
  store.close();
});

const config = () => ({ path: repo.dir, defaultBranch: "main", remote: { url: gitServer.url, repo: REPO, account: ACCOUNT } });
const details = () =>
  createPrDetails({
    store,
    repoConfig: config,
    connections,
    workspaces,
  });

function insert(state: "local" | "open") {
  store.db.$client
    .prepare(
      "INSERT INTO pull_requests (id, repo_id, number, node_id, head_ref, base_ref, head_sha, state, is_draft, owned, title, body) VALUES ('pr_b', 'repo_r1', ?, ?, 'cla-2', 'cla-1', 'x', ?, 1, 1, '[CLA-2] Agregar b', ?)",
    )
    .run(state === "local" ? null : 1, state === "local" ? null : "PR_n", state, "## Qué cambia\n\n- Agrega b");
}

function publish() {
  repo.git("push", "origin", "cla-2");
  const pr = sim.openPr({ head: "cla-2", base: "cla-1", title: "Título de GitHub", body: "Cuerpo de GitHub" });
  insert("open");
  return pr;
}

test("trae la descripción guardada, los commits sobre la base y el diff contra ella", async () => {
  insert("local");

  const detail = await details().get("pr_b");

  expect(detail).toMatchObject({ id: "pr_b", repo: "octocat/secret", branch: "cla-2", base: "cla-1", title: "[CLA-2] Agregar b", body: "## Qué cambia\n\n- Agrega b", truncated: false });
  expect(detail.head).toBe(repo.git("rev-parse", "cla-2"));
  expect(detail.baseSha).toBe(repo.git("rev-parse", "origin/cla-1"));
  expect(detail.commits.map((c) => [c.subject, c.body, c.author])).toEqual([
    ["feat(b): agregar b", "Porque hace falta.", "Clanker Test"],
    ["test(b): cubrir b", "", "Clanker Test"],
  ]);
  expect(detail.files).toEqual([
    { path: "b.test.txt", additions: 1, deletions: 0 },
    { path: "b.txt", additions: 2, deletions: 0 },
  ]);
  expect(detail.patch).toContain("diff --git a/b.txt b/b.txt");
  expect(detail.patch).toContain("+b2");
  // El cambio del padre no es de este PR.
  expect(detail.patch).not.toContain("padre");
});

test("un PR que no existe aquí o en GitHub se rechaza diciendo por qué", async () => {
  await expect(details().get("pr_nada")).rejects.toThrow("No existe el PR pr_nada");
  insert("open");
  await expect(details().get("pr_b")).rejects.toThrow("no existe en GitHub o tu cuenta no tiene acceso");
});

test("lee descripción y puntas de GitHub sin usar la branch local divergida ni la fila obsoleta", async () => {
  const pr = publish();
  const head = pr.headSha();
  repo.git("checkout", "--quiet", "cla-2");
  writeFileSync(join(repo.dir, "local.txt"), "Solo local\n");
  repo.git("add", "--all");
  repo.git("commit", "--quiet", "-m", "feat: solo local");
  const localHead = repo.git("rev-parse", "HEAD");
  const fetch = vi.spyOn(workspaces, "fetch");

  const detail = await details().get("pr_b");

  expect(detail).toMatchObject({ title: "Título de GitHub", body: "Cuerpo de GitHub", head, baseSha: repo.git("rev-parse", "origin/cla-1") });
  expect(detail.commits).toHaveLength(2);
  expect(detail.files.map((file) => file.path)).not.toContain("local.txt");
  expect(fetch).not.toHaveBeenCalled();
  expect(repo.git("rev-parse", "HEAD")).toBe(localHead);
  expect(repo.git("status", "--porcelain")).toBe("");
  expect(sim.requests.some((request) => request.path === "/graphql")).toBe(false);
});

test("usa el merge-base y las refs actuales de GitHub aunque la base y el head de la fila sean viejos", async () => {
  const pr = publish();
  pr.setBase("main");
  store.db.$client.prepare("UPDATE pull_requests SET head_ref = 'vieja', base_ref = 'vieja', head_sha = 'viejo'").run();

  const detail = await details().get("pr_b");

  expect(detail.branch).toBe("cla-2");
  expect(detail.base).toBe("main");
  expect(detail.baseSha).toBe(repo.git("rev-parse", "main"));
  expect(detail.commits).toHaveLength(3);
  expect(detail.patch).toContain("+padre");
});

test("el diff de commit remoto valida pertenencia y rechaza rangos inventados o un detalle desactualizado", async () => {
  publish();
  const detail = await details().get("pr_b");
  const range = { head: detail.head, base: detail.baseSha };
  const sha = detail.commits[1]!.sha;

  expect((await details().commit("pr_b", sha, range)).files).toEqual([{ path: "b.test.txt", additions: 1, deletions: 0 }]);
  await expect(details().commit("pr_b", repo.git("rev-parse", "main"), range)).rejects.toThrow("no es de cla-2");
  await expect(details().commit("pr_b", sha, { head: repo.git("rev-parse", "main"), base: range.base })).rejects.toThrow("actualízalo");
  repo.git("checkout", "--quiet", "cla-2");
  repo.git("commit", "--quiet", "--allow-empty", "-m", "feat: nuevo head");
  repo.git("push", "origin", "cla-2");
  await expect(details().commit("pr_b", sha, range)).rejects.toThrow("actualízalo");
  expect((await details().commit("pr_b", sha)).sha).toBe(sha);
});

test("un cambio solo en la base invalida el rango visible, también para un PR local", async () => {
  insert("local");
  const detail = await details().get("pr_b");
  repo.git("update-ref", "refs/remotes/origin/cla-1", repo.git("rev-parse", "main"));

  await expect(details().commit("pr_b", detail.commits[0]!.sha, { head: detail.head, base: detail.baseSha })).rejects.toThrow("actualízalo");
});

test.each(["branch", "fork"])("un head ausente se recupera desde %s sin mover branches ni el checkout", async (source) => {
  other = tempGitRepo();
  other.git("fetch", repo.remoteDir!, "refs/heads/cla-1");
  other.git("checkout", "--quiet", "-B", "fork-head", "FETCH_HEAD");
  writeFileSync(join(other.dir, "fork.txt"), "Desde el fork\n");
  other.git("add", "--all");
  other.git("commit", "--quiet", "-m", "feat: desde fork");
  const head = other.git("rev-parse", "HEAD");
  other.git("push", repo.remoteDir!, "HEAD:refs/heads/cla-2");
  const pr = sim.openPr({ head: "cla-2", base: "cla-1", title: "Fork" });
  if (source === "fork") {
    repo.git("--git-dir", repo.remoteDir!, "update-ref", "refs/pull/1/head", head);
    repo.git("--git-dir", repo.remoteDir!, "config", "uploadpack.hideRefs", "refs/heads/cla-2");
  }
  insert("open");
  const before = repo.git("show-ref", "--heads");
  const fetch = vi.spyOn(workspaces, "fetch");
  const fetchPr = vi.spyOn(workspaces, "fetchPr");
  expect(() => repo.git("cat-file", "-e", head)).toThrow();
  expect(pr.number).toBe(1);

  const detail = await details().get("pr_b");

  expect(detail.head).toBe(head);
  expect(detail.commits.map((commit) => commit.subject)).toEqual(["feat: desde fork"]);
  expect(detail.files).toEqual([{ path: "fork.txt", additions: 1, deletions: 0 }]);
  expect(fetch).toHaveBeenCalledOnce();
  if (source === "fork") expect(fetchPr).toHaveBeenCalledWith("repo_r1", 1);
  else expect(fetchPr).not.toHaveBeenCalled();
  expect(repo.git("show-ref", "--heads")).toBe(before);
  expect(repo.git("symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(repo.git("status", "--porcelain")).toBe("");
  expect(gitServer.authorizations).not.toHaveLength(0);
});

test("un 401 de GitHub revoca la cuenta y pide reconectar", async () => {
  publish();
  sim.revokeToken();

  await expect(details().get("pr_b")).rejects.toThrow("Reconecta GitHub");
  expect(connections.list()).toMatchObject([{ status: "revoked" }]);
});

test("un PR sin conexión o con branch/base local ausente explica cómo recuperar el detalle", async () => {
  insert("open");
  await expect(createPrDetails({ store, repoConfig: () => ({ path: repo.dir, defaultBranch: "main" }), connections, workspaces }).get("pr_b")).rejects.toThrow("Reconecta GitHub");
  store.db.$client.prepare("UPDATE pull_requests SET state = 'local', number = NULL, node_id = NULL").run();
  repo.git("branch", "-D", "cla-2");
  await expect(details().get("pr_b")).rejects.toThrow("restáurala");
  repo.git("branch", "cla-2", "main");
  repo.git("update-ref", "-d", "refs/remotes/origin/cla-1");
  repo.git("branch", "-D", "cla-1");
  await expect(details().get("pr_b")).rejects.toThrow("La base cla-1");
});

test("mantiene límites del patch y archivos binarios en el detalle y el diff de commit", async () => {
  insert("local");
  repo.git("checkout", "--quiet", "cla-2");
  writeFileSync(join(repo.dir, "large.txt"), "x\n".repeat(LOCAL_PR_PATCH_MAX));
  writeFileSync(join(repo.dir, "binary.dat"), Buffer.from([0, 1, 2, 3]));
  repo.git("add", "--all");
  repo.git("commit", "--quiet", "-m", "feat: archivos grandes");

  const detail = await details().get("pr_b");
  const diff = await details().commit("pr_b", detail.head, { head: detail.head, base: detail.baseSha });

  for (const result of [detail, diff]) {
    expect(result.truncated).toBe(true);
    expect(result.patch).toHaveLength(LOCAL_PR_PATCH_MAX);
    expect(result.files).toContainEqual({ path: "binary.dat", additions: null, deletions: null });
  }
});

test.each(["closed", "merged"] as const)("también muestra un PR %s", async (state) => {
  const pr = publish();
  if (state === "merged") pr.merge();
  else pr.close();
  store.db.$client.prepare("UPDATE pull_requests SET state = ?").run(state);

  expect((await details().get("pr_b")).commits).toHaveLength(2);
});

test("trae una base ausente y compara desde el merge-base, sin incluir los cambios nuevos de la base", async () => {
  publish();
  other = tempGitRepo();
  other.git("fetch", repo.remoteDir!, "refs/heads/cla-1");
  other.git("checkout", "--quiet", "-B", "cla-1", "FETCH_HEAD");
  writeFileSync(join(other.dir, "base-only.txt"), "Solo base\n");
  other.git("add", "--all");
  other.git("commit", "--quiet", "-m", "feat: avanzar base");
  const baseSha = other.git("rev-parse", "HEAD");
  other.git("push", repo.remoteDir!, "HEAD:refs/heads/cla-1");
  expect(() => repo.git("cat-file", "-e", baseSha)).toThrow();
  const before = repo.git("show-ref", "--heads");
  const fetch = vi.spyOn(workspaces, "fetch");
  const fetchPr = vi.spyOn(workspaces, "fetchPr");

  const detail = await details().get("pr_b");

  expect(detail.baseSha).toBe(baseSha);
  expect(detail.commits).toHaveLength(2);
  expect(detail.patch).not.toContain("base-only.txt");
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetchPr).not.toHaveBeenCalled();
  expect(repo.git("show-ref", "--heads")).toBe(before);
});

test("si traer los commits falla, el error permite reintentar en vez de escapar como un 500", async () => {
  publish();
  const client = connections.githubClient(ACCOUNT);
  client.hook.after("request", (response) => {
    const data = response.data as { head: { sha: string } };
    data.head.sha = "f".repeat(40);
  });
  vi.spyOn(workspaces, "fetch").mockRejectedValue(new Error("fallo de red"));

  await expect(details().get("pr_b")).rejects.toThrow("vuelve a intentarlo o ábrelo en GitHub");
});

test("si la punta sigue ausente después de ambos fetch, no sustituye el head por una branch local", async () => {
  publish();
  const client = connections.githubClient(ACCOUNT);
  client.hook.after("request", (response) => {
    const data = response.data as { head: { sha: string } };
    data.head.sha = "f".repeat(40);
  });
  vi.spyOn(workspaces, "fetchPr").mockResolvedValue("ok");

  await expect(details().get("pr_b")).rejects.toThrow("No se encontraron los commits del PR");
});

test("un 401 al traer los commits pide reconectar", async () => {
  publish();
  const client = connections.githubClient(ACCOUNT);
  client.hook.after("request", (response) => {
    const data = response.data as { head: { sha: string } };
    data.head.sha = "f".repeat(40);
  });
  vi.spyOn(workspaces, "fetch").mockResolvedValue("unauthorized");

  await expect(details().get("pr_b")).rejects.toThrow("Reconecta GitHub");
});

test("el diff de un commit trae solo lo que cambió ese commit, y uno que no es del PR se rechaza", async () => {
  insert("local");
  const [first, second] = (await details().get("pr_b")).commits;

  const diff = await details().commit("pr_b", second!.sha.slice(0, 9));

  expect(diff.sha).toBe(second!.sha);
  expect(diff.files).toEqual([{ path: "b.test.txt", additions: 1, deletions: 0 }]);
  expect(diff.patch).not.toContain("b.txt b/b.txt");
  expect((await details().commit("pr_b", first!.sha)).files.map((f) => f.path)).toEqual(["b.txt"]);
  await expect(details().commit("pr_b", repo.git("rev-parse", "main"))).rejects.toThrow("no es de cla-2");
});
