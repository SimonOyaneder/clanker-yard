import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type ChatId, type RepoId } from "@clanker/api";
import {
  createAskpass,
  createChatScratch,
  createConnections,
  createErrorReporter,
  createFileSecrets,
  createGitRemote,
  createRepos,
  createWorkspaces,
  newId,
  openStore,
  startCleanup,
  type ChatScratch,
  type GitRemote,
  type Store,
  type WorkspaceLease,
  type Workspaces,
} from "@clanker/core";
import { seedPr } from "@clanker/core/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tempGitRepo, type TempGitRepo } from "./git";
import { startGitHttpServer } from "./git-http";
import { startGitHubSim } from "./github-sim";
import { createFakeRuntime } from "./fake-runtime";
import { startCore } from "./start-core";

const ACCOUNT = "octocat";
const REPO = "octocat/secret-project";
const TOKEN = "github_pat_UNIQUE-chat-scratch";

let dir: string;
let store: Store;
let repo: TempGitRepo;
let repoId: RepoId;
let prId: string;
let head: string;
let lease: WorkspaceLease;
let leaseActive: boolean;
let workspaces: Workspaces;
let scratch: ChatScratch;
let chats: Map<ChatId, { prId: string; active: boolean }>;
let fetchOutcome: "ok" | "unauthorized";
let fetch: ReturnType<typeof vi.fn<GitRemote["fetch"]>>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "clanker-chat-"));
  store = openStore({ path: join(dir, "clanker.db") });
  repo = tempGitRepo({
    remote: true,
    commits: [{
      message: "chore: base",
      files: {
        "a.txt": "a1\na2\na3\n",
        "b.txt": "b\n",
        "old.txt": "old\n",
        "config/one.txt": "one\n",
        "config/two.txt": "two\n",
        ".gitignore": "node_modules\nsetup-ran\n",
        ".clanker/recipe.json": JSON.stringify({ version: 1, setup: { worktree: ["touch setup-ran"] } }),
      },
    }],
    branches: { pr: [{ message: "feat: pr", files: { "pr.txt": "pr\n" } }] },
  });
  head = repo.git("rev-parse", "pr");
  repo.git("branch", "-D", "pr");
  repoId = createRepos({ store }).add({ name: "demo", path: repo.dir, remote: REPO });
  prId = seedPr(store, { repoId, number: 1, headRef: "pr", headSha: head });
  chats = new Map();
  fetchOutcome = "ok";
  fetch = vi.fn(({ cwd }, refspec) => {
    if (fetchOutcome === "ok") {
      if (refspec === undefined) repo.git("-C", cwd, "fetch", "origin");
      else repo.git("-C", cwd, "fetch", "origin", refspec);
    }
    return Promise.resolve(fetchOutcome);
  });
  workspaces = workspaceService();
  scratch = service();
  lease = await workspaces.acquire({ repo: repoId, branch: "pr", base: "main", runId: newId("run") });
  leaseActive = true;
  writeFileSync(join(lease.path, "pr.txt"), "trabajo de otra corrida\n");
  repo.git("-C", lease.path, "add", "pr.txt");
  writeFileSync(join(lease.path, "untracked.txt"), "no tocar\n");
});

afterEach(async () => {
  expect(repo.git("rev-parse", "pr")).toBe(head);
  expect(repo.git("-C", lease.path, "rev-parse", "HEAD")).toBe(head);
  expect(repo.git("-C", lease.path, "status", "--porcelain")).toBe("M  pr.txt\n?? untracked.txt");
  expect(readFileSync(join(lease.path, "pr.txt"), "utf8")).toBe("trabajo de otra corrida\n");
  if (leaseActive) workspaces.release(lease);
  store.close();
  repo.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function workspaceService(): Workspaces {
  return createWorkspaces({
    store,
    dataDir: dir,
    repoConfig: () => ({ path: repo.dir, defaultBranch: "main", remote: { url: "sin-uso", repo: REPO, account: ACCOUNT } }),
    identityOf: async () => ({ name: "Ana Pérez", email: "ana@example.com" }),
    remote: {
      fetch,
      push: () => Promise.reject(new Error("no se usa")),
      lsRemote: () => Promise.reject(new Error("no se usa")),
    },
    worktreeSetup: () => ["touch setup-ran"],
  });
}

function service(fetchingWorkspaces = workspaces): ChatScratch {
  return createChatScratch({
    store,
    dataDir: dir,
    repoConfig: () => ({ path: repo.dir, defaultBranch: "main", remote: { url: "sin-uso", repo: REPO, account: ACCOUNT } }),
    identityOf: async () => ({ name: "Ana Pérez", email: "ana@example.com" }),
    workspaces: fetchingWorkspaces,
    chatOf: (chatId) => chats.get(chatId),
  });
}

function createScratch(chatId: ChatId, headSha: string, associatedPr = prId): Promise<string> {
  chats.set(chatId, { prId: associatedPr, active: true });
  return scratch.create(repoId, chatId, headSha);
}

function reopenStore() {
  if (leaseActive) {
    workspaces.release(lease);
    leaseActive = false;
  }
  store.close();
  store = openStore({ path: join(dir, "clanker.db") });
  workspaces = workspaceService();
  scratch = service();
}

function advanceOrigin(files: Record<string, string | null>): string {
  const other = mkdtempSync(join(dir, "other-"));
  repo.git("clone", "--quiet", "--branch", "pr", repo.remoteDir!, other);
  for (const [file, content] of Object.entries(files)) {
    if (content === null) repo.git("-C", other, "rm", file);
    else {
      writeFileSync(join(other, file), content);
      repo.git("-C", other, "add", file);
    }
  }
  repo.git("-C", other, "commit", "-m", "feat: advance pr");
  repo.git("-C", other, "push", "origin", "pr");
  return repo.git("-C", other, "rev-parse", "HEAD");
}

const read = (path: string, file: string) => readFileSync(join(path, file), "utf8");
const wt = (path: string, ...args: string[]) => repo.git("-C", path, ...args);

describe("borrador aislado", () => {
  test("rechaza ids inválidos antes de registrar el borrador o construir rutas y refs", async () => {
    const invalid: ChatId[] = ["chat_../../outside", "chat_invalid", `${newId("chat")}/p1`];
    for (const chat of invalid) {
      await expect(createScratch(chat, head)).rejects.toThrow(/ULID válido/);
    }

    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "chats"))).toBe(false);
    expect(store.db.$client.prepare("SELECT chat_id FROM chat_scratches").all()).toEqual([]);
    expect(repo.git("for-each-ref", "refs/clanker/chat/")).toBe("");
  });

  test("create y sync traen la ref del PR cuando su punta solo existe en un fork", async () => {
    const fork = mkdtempSync(join(dir, "fork-"));
    repo.git("clone", "--quiet", "--branch", "pr", repo.remoteDir!, fork);
    repo.git("-C", fork, "commit", "--allow-empty", "-m", "feat: fork");
    repo.git("-C", fork, "push", "origin", "HEAD:refs/pull/1/head");
    const forkHead = wt(fork, "rev-parse", "HEAD");
    expect(() => repo.git("cat-file", "-e", `${forkHead}^{commit}`)).toThrow();
    const askpass = createAskpass();
    const connections = createConnections({ store, secrets: createFileSecrets({ dir: join(dir, "secrets") }) });
    await connections.connect({ provider: "github", account: ACCOUNT, scopes: [], token: TOKEN }, "core");
    const server = await startGitHttpServer(repo.remoteDir!, { user: ACCOUNT, password: TOKEN });
    const remoteWorkspaces = createWorkspaces({
      store,
      dataDir: dir,
      repoConfig: () => ({ path: repo.dir, defaultBranch: "main", remote: { url: server.url, repo: REPO, account: ACCOUNT } }),
      identityOf: async () => ({ name: "Ana Pérez", email: "ana@example.com" }),
      remote: createGitRemote({ askpass, connections }),
    });
    scratch = service(remoteWorkspaces);
    try {
      const chat = newId("chat");
      const path = await createScratch(chat, forkHead);
      expect(wt(path, "rev-parse", "HEAD")).toBe(forkHead);
      expect(repo.git("rev-parse", "refs/clanker/pr/1/head")).toBe(forkHead);
      writeFileSync(join(path, "a.txt"), "propuesta\n");
      repo.git("-C", fork, "commit", "--allow-empty", "-m", "feat: fork siguiente");
      repo.git("-C", fork, "push", "origin", "HEAD:refs/pull/1/head");
      const next = wt(fork, "rev-parse", "HEAD");
      expect(() => repo.git("cat-file", "-e", `${next}^{commit}`)).toThrow();

      expect(await scratch.sync(chat, next)).toMatchObject({ outcome: "moved", headSha: next });

      expect(read(path, "a.txt")).toBe("propuesta\n");
      expect(repo.git("rev-parse", "refs/clanker/pr/1/head")).toBe(next);
      expect(Buffer.from(server.authorizations.at(-1)!.replace("Basic ", ""), "base64").toString()).toBe(`${ACCOUNT}:${TOKEN}`);
    } finally {
      await askpass.close();
      await server.close();
    }
  });

  test("crea en la punta remota sin setup y guarda propuestas sin mover HEAD ni el índice", async () => {
    const next = advanceOrigin({ "b.txt": "nuevo head\n" });
    const chat = newId("chat");

    const path = await createScratch(chat, next);

    expect(path).toBe(join(dir, "chats", chat));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(wt(path, "rev-parse", "HEAD")).toBe(next);
    expect(wt(path, "branch", "--show-current")).toBe("");
    expect(read(path, "pr.txt")).toBe("pr\n");
    expect(existsSync(join(path, "setup-ran"))).toBe(false);
    mkdirSync(join(path, ".clanker-run"));
    writeFileSync(join(path, ".clanker-run", "brief.json"), "{}");
    writeFileSync(join(path, "a.txt"), "propuesta\n");
    wt(path, "add", "a.txt");
    writeFileSync(join(path, "new.txt"), "nuevo\n");
    rmSync(join(path, "old.txt"));
    const index = wt(path, "diff", "--cached");
    const status = wt(path, "status", "--porcelain");

    const first = await scratch.snapshot(chat, 1);
    writeFileSync(join(path, "new.txt"), "segunda revisión\n");
    const second = await scratch.snapshot(chat, 2);

    expect(first.ref).toBe(`refs/clanker/chat/${chat}/p1`);
    expect(first.files).toEqual(["a.txt", "new.txt", "old.txt"]);
    expect(first.patch).not.toContain(".clanker-run");
    expect(first.patch).not.toContain("b.txt");
    expect(wt(path, "show", `${first.ref}:new.txt`)).toBe("nuevo");
    expect(wt(path, "show", `${second.ref}:new.txt`)).toBe("segunda revisión");
    expect(wt(path, "rev-parse", `${first.ref}^`)).toBe(next);
    expect(wt(path, "show", "-s", "--format=%an <%ae>", first.sha)).toBe("Ana Pérez <ana@example.com>");
    writeFileSync(join(path, ".clanker-run", "proposal.patch"), second.patch);
    expect(wt(path, "apply", "--check", "--reverse", ".clanker-run/proposal.patch")).toBe("");
    expect(wt(path, "rev-parse", "HEAD")).toBe(next);
    expect(wt(path, "diff", "--cached")).toBe(index);
    expect(wt(path, "status", "--porcelain")).toBe(status);
    expect(await scratch.create(repoId, chat, next)).toBe(path);
    expect(readFileSync(join(repo.dir, ".git/info/exclude"), "utf8").split("\n").filter((line) => line === "/.clanker-run/")).toHaveLength(1);
  });

  test("un PR local de un repo con remoto no hace fetch", async () => {
    const local = seedPr(store, { repoId, number: null, state: "local", headRef: "local", headSha: head, title: "feat: local" });
    const chat = newId("chat");
    const path = await createScratch(chat, head, local);
    const next = repo.git("rev-parse", "main");

    expect(await scratch.sync(chat, next)).toMatchObject({ outcome: "moved", headSha: next });

    expect(fetch).not.toHaveBeenCalled();
    expect(wt(path, "rev-parse", "HEAD")).toBe(next);
  });

  test("un fetch no autorizado no crea el borrador ni modifica el chat", async () => {
    const chat = newId("chat");
    fetchOutcome = "unauthorized";

    await expect(createScratch(chat, head)).rejects.toThrow(/reconéctala/);

    expect(existsSync(join(dir, "chats", chat))).toBe(false);
    expect(store.db.$client.prepare("SELECT chat_id FROM chat_scratches WHERE chat_id = ?").get(chat)).toBeUndefined();
    expect(chats.get(chat)).toEqual({ prId, active: true });
  });

  test("un PR o borrador que no existe es un error de dominio", async () => {
    const chat = newId("chat");

    await expect(scratch.create(repoId, chat, head)).rejects.toThrow(/No existe el chat/);
    await expect(createScratch(chat, head, newId("pr"))).rejects.toThrow(/No existe el PR/);
    await expect(scratch.discard(chat)).rejects.toThrow(/No existe el borrador/);

    expect(existsSync(join(dir, "chats", chat))).toBe(false);
  });

  test.each(["create", "sync"] as const)("%s rechaza una punta reemplazada antes del fetch sin persistirla y permite reintentar", async (operation) => {
    const chat = newId("chat");
    chats.set(chat, { prId, active: true });
    const path = join(dir, "chats", chat);
    if (operation === "sync") {
      await scratch.create(repoId, chat, head);
      writeFileSync(join(path, "a.txt"), "propuesta\n");
    }
    const fork = mkdtempSync(join(dir, "force-push-"));
    repo.git("clone", "--quiet", "--branch", "pr", repo.remoteDir!, fork);
    wt(fork, "commit", "--allow-empty", "-m", "feat: punta leída");
    const requested = wt(fork, "rev-parse", "HEAD");
    wt(fork, "reset", "--hard", head);
    wt(fork, "commit", "--allow-empty", "-m", "feat: punta vigente");
    wt(fork, "push", "--force", "origin", "HEAD:pr", "HEAD:refs/pull/1/head");
    const current = wt(fork, "rev-parse", "HEAD");

    await expect(operation === "create"
      ? scratch.create(repoId, chat, requested)
      : scratch.sync(chat, requested)).rejects.toThrow(/Reintenta con su punta vigente/);

    expect(() => repo.git("cat-file", "-e", `${requested}^{commit}`)).toThrow();
    expect(repo.git("for-each-ref", `refs/clanker/chat/${chat}/`)).toBe("");
    const row = store.db.$client.prepare("SELECT head_sha, sync_target FROM chat_scratches WHERE chat_id = ?").get(chat);
    if (operation === "create") {
      expect(row).toBeUndefined();
      expect(existsSync(path)).toBe(false);
      await scratch.create(repoId, chat, current);
    } else {
      expect(row).toEqual({ head_sha: head, sync_target: null });
      expect(wt(path, "rev-parse", "HEAD")).toBe(head);
      expect(read(path, "a.txt")).toBe("propuesta\n");
      expect(await scratch.sync(chat, current)).toMatchObject({ outcome: "moved", headSha: current });
      expect(read(path, "a.txt")).toBe("propuesta\n");
    }
    await scratch.discard(chat);
    expect(wt(path, "rev-parse", "HEAD")).toBe(current);
    expect(wt(path, "status", "--porcelain")).toBe("");
  });
});

describe("sync", () => {
  test("serializa sync, snapshot, discard y remove del mismo chat sin detener otros chats", async () => {
    const chat = newId("chat");
    const other = newId("chat");
    const path = await createScratch(chat, head);
    await createScratch(other, head);
    writeFileSync(join(path, "a.txt"), "propuesta\n");
    const first = advanceOrigin({ "b.txt": "b2\n" });
    const second = advanceOrigin({ "b.txt": "b3\n" });
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fetch.mockImplementationOnce(async () => {
      entered();
      await gate;
      repo.git("fetch", "origin");
      return "ok";
    });

    const syncing = scratch.sync(chat, first);
    await ready;
    const next = scratch.sync(chat, second);
    const snapshot = scratch.snapshot(chat, 1);
    const discarding = scratch.discard(chat);
    const discarded = scratch.snapshot(chat, 2);
    const removing = scratch.remove(chat);
    try {
      expect((await scratch.snapshot(other, 1)).files).toEqual([]);
    } finally {
      release();
    }
    const [moved, advanced, proposal, , empty] = await Promise.all([syncing, next, snapshot, discarding, discarded, removing]);

    expect(moved).toMatchObject({ outcome: "moved", headSha: first, from: head });
    expect(advanced).toMatchObject({ outcome: "moved", headSha: second, from: first });
    expect(proposal.files).toEqual(["a.txt"]);
    expect(repo.git("rev-parse", `${proposal.sha}^`)).toBe(second);
    expect(repo.git("show", `${proposal.sha}:a.txt`)).toBe("propuesta");
    expect(empty.files).toEqual([]);
    expect(repo.git("rev-parse", `${empty.sha}^`)).toBe(second);
    expect(existsSync(path)).toBe(false);
    expect(store.db.$client.prepare("SELECT chat_id FROM chat_scratches WHERE chat_id = ?").get(chat)).toBeUndefined();
  });

  test("reaplica juntos los reemplazos entre archivos y directorios aunque falle una ruta independiente", async () => {
    const chat = newId("chat");
    const path = await createScratch(chat, head);
    rmSync(join(path, "config"), { recursive: true });
    writeFileSync(join(path, "config"), "config nueva\n");
    rmSync(join(path, "old.txt"));
    mkdirSync(join(path, "old.txt"));
    writeFileSync(join(path, "old.txt/nested.txt"), "nuevo archivo\n");
    writeFileSync(join(path, "b.txt"), "propuesta\n");
    const next = advanceOrigin({ "b.txt": null, "pr.txt": "punta nueva\n" });

    expect(await scratch.sync(chat, next)).toMatchObject({ outcome: "conflict", headSha: next, conflicts: ["b.txt"] });

    expect(read(path, "config")).toBe("config nueva\n");
    expect(read(path, "old.txt/nested.txt")).toBe("nuevo archivo\n");
    expect(read(path, "b.txt")).toBe("propuesta\n");
    expect(read(path, "pr.txt")).toBe("punta nueva\n");
    expect(wt(path, "diff", "--cached")).toBe("");
    expect((await scratch.snapshot(chat, 1)).files).toEqual(["b.txt", "config", "config/one.txt", "config/two.txt", "old.txt", "old.txt/nested.txt"]);
  });

  test("reaplica un reemplazo de archivo por directorio si la punta nueva ya borró el archivo", async () => {
    const chat = newId("chat");
    const path = await createScratch(chat, head);
    rmSync(join(path, "old.txt"));
    mkdirSync(join(path, "old.txt"));
    writeFileSync(join(path, "old.txt/nested.txt"), "nuevo archivo\n");
    const next = advanceOrigin({ "old.txt": null });

    expect(await scratch.sync(chat, next)).toMatchObject({ outcome: "moved", headSha: next, from: head });

    expect(read(path, "old.txt/nested.txt")).toBe("nuevo archivo\n");
    expect(wt(path, "diff", "--cached")).toBe("");
    expect((await scratch.snapshot(chat, 1)).files).toEqual(["old.txt/nested.txt"]);
    expect(await scratch.sync(chat, next)).toEqual({ outcome: "same", headSha: next });
    const later = advanceOrigin({ "pr.txt": "punta posterior\n" });
    expect(await scratch.sync(chat, later)).toMatchObject({ outcome: "moved", headSha: later, from: next });
    expect(read(path, "old.txt/nested.txt")).toBe("nuevo archivo\n");
  });

  test("same conserva el trabajo y no deja un respaldo", async () => {
    const chat = newId("chat");
    const path = await createScratch(chat, head);
    writeFileSync(join(path, "a.txt"), "mine\n");

    expect(await scratch.sync(chat, head)).toEqual({ outcome: "same", headSha: head });
    expect(read(path, "a.txt")).toBe("mine\n");
    expect(repo.git("for-each-ref", `refs/clanker/chat/${chat}/`)).toBe("");
  });

  test("moved reaplica cambios, altas y bajas, conserva los ignorados y respalda el árbol anterior", async () => {
    const chat = newId("chat");
    const path = await createScratch(chat, head);
    writeFileSync(join(path, "a.txt"), "a1\na2\nmine\n");
    writeFileSync(join(path, "new.txt"), "new\n");
    writeFileSync(join(path, "node_modules"), "dependencias\n");
    rmSync(join(path, "old.txt"));
    const next = advanceOrigin({ "a.txt": "theirs\na2\na3\n", "b.txt": "b2\n" });

    const result = await scratch.sync(chat, next);

    expect(result).toEqual({ outcome: "moved", headSha: next, from: head, backup: `refs/clanker/chat/${chat}/sync` });
    expect(read(path, "a.txt")).toBe("theirs\na2\nmine\n");
    expect(read(path, "b.txt")).toBe("b2\n");
    expect(read(path, "new.txt")).toBe("new\n");
    expect(read(path, "node_modules")).toBe("dependencias\n");
    expect(existsSync(join(path, "old.txt"))).toBe(false);
    expect(wt(path, "diff", "--cached")).toBe("");
    expect(wt(path, "rev-parse", "HEAD")).toBe(next);
    expect(wt(path, "show", `refs/clanker/chat/${chat}/sync:a.txt`)).toBe("a1\na2\nmine");
    const snapshot = await scratch.snapshot(chat, 1);
    expect(snapshot.files).toEqual(["a.txt", "new.txt", "old.txt"]);
    expect(await scratch.sync(chat, next)).toEqual({ outcome: "same", headSha: next });
  });

  test("conflict deja marcas, aplica lo que no choca y guarda la nueva punta", async () => {
    const chat = newId("chat");
    const path = await createScratch(chat, head);
    writeFileSync(join(path, "a.txt"), "a1\nmine\na3\n");
    writeFileSync(join(path, "b.txt"), "mine\n");
    const next = advanceOrigin({ "a.txt": "a1\ntheirs\na3\n" });

    const result = await scratch.sync(chat, next);

    expect(result).toMatchObject({ outcome: "conflict", headSha: next, conflicts: ["a.txt"] });
    expect(read(path, "a.txt")).toContain("<<<<<<< ours\ntheirs\n=======\nmine\n>>>>>>> theirs");
    expect(read(path, "b.txt")).toBe("mine\n");
    expect(wt(path, "diff", "--cached")).toBe("");
    expect(await scratch.sync(chat, next)).toEqual({ outcome: "same", headSha: next });
    await scratch.discard(chat);
    expect(read(path, "a.txt")).toBe("a1\ntheirs\na3\n");
    expect(wt(path, "status", "--porcelain")).toBe("");
  });

  test("un archivo borrado por el PR no impide reaplicar los demás ni pierde cambios en el próximo sync", async () => {
    const chat = newId("chat");
    const path = await createScratch(chat, head);
    writeFileSync(join(path, "a.txt"), "propuesta independiente\n");
    writeFileSync(join(path, "b.txt"), "mine\n");
    const next = advanceOrigin({ "b.txt": null });

    const result = await scratch.sync(chat, next);

    expect(result).toMatchObject({ outcome: "conflict", conflicts: ["b.txt"], failures: expect.stringContaining(`refs/clanker/chat/${chat}/sync`) });
    expect(wt(path, "show", `refs/clanker/chat/${chat}/sync:b.txt`)).toBe("mine");
    expect(read(path, "a.txt")).toBe("propuesta independiente\n");
    expect(read(path, "b.txt")).toBe("mine\n");
    expect(wt(path, "diff", "--cached")).toBe("");
    expect((await scratch.snapshot(chat, 1)).files).toEqual(["a.txt", "b.txt"]);
    const later = advanceOrigin({ "pr.txt": "punta posterior\n" });
    expect(await scratch.sync(chat, later)).toMatchObject({ outcome: "moved", headSha: later });
    expect(read(path, "a.txt")).toBe("propuesta independiente\n");
    expect(read(path, "b.txt")).toBe("mine\n");
  });

  test("una eliminación compartida con la punta nueva ya está aplicada y no bloquea el próximo sync", async () => {
    const chat = newId("chat");
    const path = await createScratch(chat, head);
    rmSync(join(path, "b.txt"));
    writeFileSync(join(path, "a.txt"), "propuesta independiente\n");
    const next = advanceOrigin({ "b.txt": null });

    expect(await scratch.sync(chat, next)).toMatchObject({ outcome: "moved", headSha: next });

    expect(existsSync(join(path, "b.txt"))).toBe(false);
    expect(read(path, "a.txt")).toBe("propuesta independiente\n");
    expect(wt(path, "diff", "--cached")).toBe("");
    expect((await scratch.snapshot(chat, 1)).files).toEqual(["a.txt"]);
    expect(await scratch.sync(chat, next)).toEqual({ outcome: "same", headSha: next });
    const later = advanceOrigin({ "pr.txt": "punta posterior\n" });
    expect(await scratch.sync(chat, later)).toMatchObject({ outcome: "moved", headSha: later, from: next });
    expect(existsSync(join(path, "b.txt"))).toBe(false);
    expect(read(path, "a.txt")).toBe("propuesta independiente\n");
  });

  test("tras reiniciar retoma el sync pendiente desde su respaldo, no desde el árbol a medio aplicar", async () => {
    const chat = newId("chat");
    const path = await createScratch(chat, head);
    writeFileSync(join(path, "a.txt"), "mine\n");
    const next = advanceOrigin({ "b.txt": "b2\n" });
    const done = await scratch.sync(chat, next);
    store.db.$client.prepare("UPDATE chat_scratches SET head_sha = ?, sync_target = ? WHERE chat_id = ?").run(head, next, chat);
    wt(path, "reset", "--hard", next);
    reopenStore();

    expect(await scratch.sync(chat, next)).toEqual(done);

    expect(read(path, "a.txt")).toBe("mine\n");
    writeFileSync(join(path, "a.txt"), "después de terminar\n");
    reopenStore();
    expect(await scratch.sync(chat, next)).toEqual({ outcome: "same", headSha: next });
    expect(read(path, "a.txt")).toBe("después de terminar\n");
  });

  test("antes de adoptar otra punta termina el sync pendiente, sin perder el trabajo", async () => {
    const chat = newId("chat");
    const path = await createScratch(chat, head);
    writeFileSync(join(path, "a.txt"), "mine\n");
    const first = advanceOrigin({ "b.txt": "b2\n" });
    await scratch.sync(chat, first);
    store.db.$client.prepare("UPDATE chat_scratches SET head_sha = ?, sync_target = ? WHERE chat_id = ?").run(head, first, chat);
    wt(path, "reset", "--hard", first);
    const next = advanceOrigin({ "b.txt": "b3\n" });
    reopenStore();

    expect(await scratch.sync(chat, next)).toMatchObject({ outcome: "moved", headSha: next, from: first });

    expect(read(path, "a.txt")).toBe("mine\n");
    expect(read(path, "b.txt")).toBe("b3\n");
  });

  test("un sync pendiente que choca se conserva en esa punta antes de avanzar de nuevo", async () => {
    const chat = newId("chat");
    const path = await createScratch(chat, head);
    writeFileSync(join(path, "a.txt"), "mine\n");
    const first = advanceOrigin({ "a.txt": "theirs\n" });
    await scratch.sync(chat, first);
    store.db.$client.prepare("UPDATE chat_scratches SET head_sha = ?, sync_target = ? WHERE chat_id = ?").run(head, first, chat);
    wt(path, "reset", "--hard", first);
    const next = advanceOrigin({ "b.txt": "b3\n" });
    reopenStore();

    expect(await scratch.sync(chat, next)).toMatchObject({ outcome: "conflict", headSha: first, conflicts: ["a.txt"] });

    expect(read(path, "a.txt")).toContain("<<<<<<<");
    expect(read(path, "b.txt")).toBe("b\n");
  });

  test("si el fetch falla no mueve la punta ni respalda un árbol que no va a tocar", async () => {
    const chat = newId("chat");
    const path = await createScratch(chat, head);
    writeFileSync(join(path, "a.txt"), "mine\n");
    const next = advanceOrigin({ "b.txt": "b2\n" });
    fetchOutcome = "unauthorized";

    await expect(scratch.sync(chat, next)).rejects.toThrow(/reconéctala/);

    expect(wt(path, "rev-parse", "HEAD")).toBe(head);
    expect(read(path, "a.txt")).toBe("mine\n");
    expect(repo.git("for-each-ref", `refs/clanker/chat/${chat}/`)).toBe("");
  });
});

describe("descartar y borrar", () => {
  test("discard vuelve a la punta sincronizada sin borrar los snapshots; remove elimina solo sus refs y worktree", async () => {
    const chat = newId("chat");
    const other = newId("chat");
    const path = await createScratch(chat, head);
    const otherPath = await createScratch(other, head);
    writeFileSync(join(path, "a.txt"), "mine\n");
    writeFileSync(join(path, "new.txt"), "new\n");
    const snapshot = await scratch.snapshot(chat, 1);
    const kept = await scratch.snapshot(other, 1);
    const next = advanceOrigin({ "b.txt": "b2\n" });
    await scratch.sync(chat, next);

    await scratch.discard(chat);

    expect(wt(path, "rev-parse", "HEAD")).toBe(next);
    expect(wt(path, "status", "--porcelain")).toBe("");
    expect(repo.git("rev-parse", snapshot.ref)).toBe(snapshot.sha);
    await scratch.remove(chat);
    expect(existsSync(path)).toBe(false);
    expect(repo.git("worktree", "list", "--porcelain")).not.toContain(path);
    expect(repo.git("for-each-ref", `refs/clanker/chat/${chat}/`)).toBe("");
    expect(store.db.$client.prepare("SELECT chat_id FROM chat_scratches WHERE chat_id = ?").get(chat)).toBeUndefined();
    expect(existsSync(otherPath)).toBe(true);
    expect(repo.git("rev-parse", kept.ref)).toBe(kept.sha);
  });

  test("discard permite abandonar un sync cortado; remove retoma una eliminación que ya quitó el worktree", async () => {
    const chat = newId("chat");
    const path = await createScratch(chat, head);
    writeFileSync(join(path, "a.txt"), "mine\n");
    const next = advanceOrigin({ "b.txt": "b2\n" });
    await scratch.sync(chat, next);
    store.db.$client.prepare("UPDATE chat_scratches SET head_sha = ?, sync_target = ? WHERE chat_id = ?").run(head, next, chat);
    wt(path, "reset", "--hard", head);
    reopenStore();

    await scratch.discard(chat);

    expect(wt(path, "rev-parse", "HEAD")).toBe(next);
    expect(wt(path, "status", "--porcelain")).toBe("");
    expect(await scratch.sync(chat, next)).toEqual({ outcome: "same", headSha: next });
    repo.git("worktree", "remove", "--force", path);
    await scratch.remove(chat);
    expect(repo.git("for-each-ref", `refs/clanker/chat/${chat}/`)).toBe("");
  });

  test("un fallo de limpieza se reporta y el borrador sigue registrado para reintentar", async () => {
    const chat = newId("chat");
    const path = await createScratch(chat, head);
    const snapshot = await scratch.snapshot(chat, 1);
    chats.get(chat)!.active = false;
    const moved = join(dir, "unavailable-repo");
    renameSync(repo.dir, moved);
    try {
      const cleanup = startCleanup({ workspaces, scratch, errors: createErrorReporter({ store }) });
      await cleanup.stop();

      expect(store.events.since(0, { types: ["error"] })).toMatchObject([
        { payload: { scope: "chat.scratch.cleanup", message: expect.stringContaining("No se pudieron borrar") } },
      ]);
      expect(store.db.$client.prepare("SELECT chat_id FROM chat_scratches WHERE chat_id = ?").get(chat)).toBeDefined();
      expect(existsSync(path)).toBe(true);
    } finally {
      renameSync(moved, repo.dir);
    }
    await scratch.cleanup();
    expect(existsSync(path)).toBe(false);
    expect(repo.git("for-each-ref", snapshot.ref)).toBe("");
  });
});

describe("limpieza con lector de chats", () => {
  test.each(["merged", "closed"] as const)("el core limpia al arrancar y cuando prs.refresh observa el PR %s", async (state) => {
    store.db.$client.prepare("UPDATE pull_requests SET owned = 0 WHERE id = ?").run(prId);
    const active = newId("chat");
    const orphan = newId("chat");
    const archived = newId("chat");
    const activePath = await createScratch(active, head);
    const orphanPath = await createScratch(orphan, head);
    const archivedPath = await createScratch(archived, head);
    writeFileSync(join(activePath, "a.txt"), "conservar hasta cerrar el PR\n");
    const snapshot = await scratch.snapshot(active, 1);
    for (const [chatId, status] of [[active, "active"], [archived, "archived"]] as const) {
      store.db.$client.prepare("INSERT INTO pr_chats (id, pr_id, status) VALUES (?, ?, ?)").run(chatId, prId, status);
    }
    workspaces.release(lease);
    leaseActive = false;
    const sim = await startGitHubSim({ origin: repo, token: TOKEN });
    const connections = createConnections({
      store,
      secrets: createFileSecrets({ dir: join(dir, "secrets") }),
      github: { baseUrl: sim.baseUrl },
    });
    let core: Awaited<ReturnType<typeof startCore>> | undefined;
    try {
      const pr = sim.openPr({ head: "pr" });
      await connections.connect({ provider: "github", account: ACCOUNT, scopes: [], token: TOKEN }, "core");
      core = await startCore({
        store,
        dataDir: dir,
        connections,
        runtimes: [createFakeRuntime({ fixtures: dir, speed: Infinity })],
        scheduler: false,
        gitUrl: () => repo.remoteDir!,
        coreVersion: "0.0.0",
        onShutdown: () => {},
      });
      await vi.waitFor(() => {
        expect(existsSync(orphanPath)).toBe(false);
        expect(existsSync(archivedPath)).toBe(false);
      }, { timeout: 10_000 });
      expect(existsSync(activePath)).toBe(true);
      expect(read(activePath, "a.txt")).toBe("conservar hasta cerrar el PR\n");
      expect(repo.git("rev-parse", snapshot.ref)).toBe(snapshot.sha);
      const client = createClient({ url: core.server.url, token: core.server.token, origin: "cli" });
      const ref = { account: ACCOUNT, repo: REPO, number: pr.number };
      await client.prs.refresh(ref);
      if (state === "merged") pr.merge();
      else pr.close();

      await client.prs.refresh(ref);

      await vi.waitFor(() => {
        expect(existsSync(activePath)).toBe(false);
        expect(repo.git("for-each-ref", snapshot.ref)).toBe("");
        expect(store.db.$client.prepare("SELECT chat_id FROM chat_scratches").all()).toEqual([]);
      }, { timeout: 10_000 });
      expect(store.events.since(0, { types: ["error"] })).toEqual([]);
    } finally {
      await core?.close();
      await sim.close();
    }
  });

  test.each(["pr", "chat"] as const)("relee el %s dentro del lock y conserva el borrador si se reabre", async (reopened) => {
    const chat = newId("chat");
    const path = await createScratch(chat, head);
    writeFileSync(join(path, "a.txt"), "conservar\n");
    const snapshot = await scratch.snapshot(chat, 1);
    if (reopened === "pr") store.db.$client.prepare("UPDATE pull_requests SET state = 'closed' WHERE id = ?").run(prId);
    else chats.get(chat)!.active = false;
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const holding = workspaces.withRepoLock(repoId, () => new Promise<void>((resolve) => {
      release = resolve;
      entered();
    }));
    await ready;
    const cleaning = scratch.cleanup();
    if (reopened === "pr") store.db.$client.prepare("UPDATE pull_requests SET state = 'open' WHERE id = ?").run(prId);
    else chats.get(chat)!.active = true;
    release();
    await holding;
    await cleaning;

    expect(existsSync(path)).toBe(true);
    expect(read(path, "a.txt")).toBe("conservar\n");
    expect(repo.git("rev-parse", snapshot.ref)).toBe(snapshot.sha);
  });

  test("al reiniciar conserva chats activos y borra huérfanos, chats cerrados y PRs terminados", async () => {
    const closedPr = seedPr(store, { repoId, number: 2, headRef: "pr", headSha: head });
    const active = newId("chat");
    const orphan = newId("chat");
    const closed = newId("chat");
    const ended = newId("chat");
    const activePath = await createScratch(active, head);
    const orphanPath = await createScratch(orphan, head);
    const closedPath = await createScratch(closed, head);
    const endedPath = await createScratch(ended, head, closedPr);
    writeFileSync(join(activePath, "a.txt"), "conservar\n");
    const snapshot = await scratch.snapshot(active, 1);
    chats.delete(orphan);
    chats.get(closed)!.active = false;
    store.db.$client.prepare("UPDATE pull_requests SET state = 'closed' WHERE id = ?").run(closedPr);
    reopenStore();

    const cleanup = startCleanup({ workspaces, scratch, errors: createErrorReporter({ store }) });
    await cleanup.stop();

    expect(existsSync(orphanPath)).toBe(false);
    expect(existsSync(closedPath)).toBe(false);
    expect(existsSync(endedPath)).toBe(false);
    expect(existsSync(activePath)).toBe(true);
    expect(read(activePath, "a.txt")).toBe("conservar\n");
    expect(repo.git("rev-parse", snapshot.ref)).toBe(snapshot.sha);
    expect(store.events.since(0, { types: ["error"] })).toEqual([]);
  });
});
