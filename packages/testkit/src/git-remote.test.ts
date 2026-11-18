import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createAskpass,
  createConnections,
  createFileSecrets,
  createGitRemote,
  createWorkspaces,
  LEASE_TTL_MS,
  newId,
  openStore,
  TICKET_TTL_MS,
  type Askpass,
  type Connections,
  type Store,
  type WorkspaceLease,
  type Workspaces,
} from "@clanker/core";
import { afterEach, beforeEach, describe, expect, test} from "vitest";
import { tempGitRepo, type TempGitRepo } from "./git";
import { startGitHttpServer } from "./git-http";

// Se prueba aquí y no en el core por la misma razón que workspaces.test.ts: testkit puede importar
// el core y el core no puede importar testkit. Todo corre contra un servidor git HTTP local con
// Basic auth sobre un bare temporal; nunca contra GitHub ni con tokens reales.

const execFileAsync = promisify(execFile);
const TOKEN = "github_pat_UNIQUE-0123456789";
const ACCOUNT = "simon";
const BRANCH = "cla-44";

let clock: number;
let dataDir: string;
let store: Store;
let askpass: Askpass;
let connections: Connections;
let workspaces: Workspaces;
let repo: TempGitRepo;
let server: Awaited<ReturnType<typeof startGitHttpServer>> | undefined;
let leases: WorkspaceLease[];

beforeEach(async () => {
  clock = 1_000_000;
  dataDir = mkdtempSync(join(tmpdir(), "clanker-remote-"));
  store = openStore({ path: ":memory:", now: () => clock });
  askpass = createAskpass({ now: () => clock });
  connections = createConnections({ store, secrets: createFileSecrets({ dir: join(dataDir, "secrets") }) });
  await connections.connect({ provider: "github", account: ACCOUNT, scopes: [], token: TOKEN }, "core");
  leases = [];
});

afterEach(async () => {
  for (const lease of leases) workspaces.release(lease);
  await askpass.close();
  await server?.close();
  server = undefined;
  repo.cleanup();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** Un repo con remoto bare servido por HTTP; `password` es lo que el servidor acepta. */
async function setup(password = TOKEN, branches: Parameters<typeof tempGitRepo>[0] = {}) {
  repo = tempGitRepo({ remote: true, ...branches });
  repo.git("--git-dir", repo.remoteDir!, "config", "http.receivepack", "true");
  server = await startGitHttpServer(repo.remoteDir!, { user: ACCOUNT, password });
  workspaces = createWorkspaces({
    store,
    dataDir,
    repoConfig: () => ({
      path: repo.dir,
      defaultBranch: "main",
      remote: { url: server!.url, repo: "octocat/secret-project", account: ACCOUNT },
    }),
    identityOf: async () => ({ name: "Ana Pérez", email: "ana@example.com" }),
    remote: createGitRemote({ askpass, connections }),
    now: () => clock,
  });
}

async function acquire(branch = BRANCH) {
  const lease = await workspaces.acquire({ repo: "repo_r1", branch, base: "main", runId: newId("run") });
  leases.push(lease);
  return lease;
}

async function commit(lease: WorkspaceLease, message: string): Promise<string> {
  await workspaces.git(lease, "commit", "--allow-empty", "--message", message);
  return workspaces.git(lease, "rev-parse", "HEAD");
}

const remoteSha = (branch = BRANCH) => repo.git("--git-dir", repo.remoteDir!, "rev-parse", `refs/heads/${branch}`);

function savedRemoteSha(): string | null {
  const row = store.db.$client.prepare("SELECT remote_sha AS sha FROM workspaces").get() as { sha: string | null };
  return row.sha;
}

/** Un hook del repo, como lo dejaría un agente; `core.hooksPath` local para que no lo tape uno global. */
function writeHook(name: string, script: string): void {
  const hooks = join(repo.dir, ".git", "hooks");
  repo.git("config", "core.hooksPath", hooks);
  writeFileSync(join(hooks, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
}

/** Otro proceso pusheó a la branch directo al bare, sin pasar por el core. */
function otherProcessPushes(message: string, branch = BRANCH): string {
  repo.git("commit", "--allow-empty", "--message", message);
  const sha = repo.git("rev-parse", "HEAD");
  repo.git("push", "--force", "origin", `${sha}:refs/heads/${branch}`);
  return sha;
}

describe("push", () => {
  test("pushea con el token de la conexión por askpass y guarda el remote_sha", async () => {
    await setup();
    const lease = await acquire();
    const sha = await commit(lease, "feat: one");

    expect(await workspaces.push(lease)).toBe("ok");

    expect(remoteSha()).toBe(sha);
    expect(savedRemoteSha()).toBe(sha);
    const credentials = Buffer.from(server!.authorizations.at(-1)!.replace("Basic ", ""), "base64").toString();
    expect(credentials).toBe(`${ACCOUNT}:${TOKEN}`);

    // Un segundo push sin cambios y uno con otro commit siguen el lease.
    expect(await workspaces.push(lease)).toBe("ok");
    const next = await commit(lease, "feat: two");
    expect(await workspaces.push(lease)).toBe("ok");
    expect(remoteSha()).toBe(next);
    expect(savedRemoteSha()).toBe(next);
  });

  test("con council pushea los fixup! encima de lo que hay, pero un historial reescrito no se fuerza", async () => {
    await setup();
    const lease = await acquire();
    const first = await commit(lease, "feat: one");
    expect(await workspaces.push(lease)).toBe("ok");

    const fixup = await commit(lease, "fixup! feat: one");
    expect(await workspaces.push(lease, { council: true })).toBe("ok");
    expect(remoteSha()).toBe(fixup);

    // Un squash local reescribe lo ya pusheado: sin council sería un force push con lease, con council no sale.
    await workspaces.git(lease, "reset", "--hard", first);
    await workspaces.git(lease, "commit", "--amend", "--allow-empty", "--message", "feat: one, amended");
    const amended = await workspaces.git(lease, "rev-parse", "HEAD");
    await expect(workspaces.push(lease, { council: true })).rejects.toThrow(/council.*force push/);
    expect(remoteSha()).toBe(fixup);
    expect(savedRemoteSha()).toBe(fixup);

    expect(await workspaces.push(lease)).toBe("ok");
    expect(remoteSha()).toBe(amended);
  });

  test("una branch que ya existe en el remoto parte con su punta como remote_sha", async () => {
    await setup(TOKEN, { branches: { [BRANCH]: [{ message: "work" }] } });
    // Solo queda la branch remota: el caso de retomar un PR que no tiene worktree local.
    repo.git("branch", "--delete", "--force", BRANCH);
    const lease = await acquire();
    expect(savedRemoteSha()).toBe(remoteSha());

    const sha = await commit(lease, "feat: more");

    expect(await workspaces.push(lease)).toBe("ok");
    expect(remoteSha()).toBe(sha);
  });

  test("lease rechazado cuando otro proceso pusheó: no pisa el remoto ni cambia el remote_sha", async () => {
    await setup();
    const lease = await acquire();
    await commit(lease, "feat: one");
    expect(await workspaces.push(lease)).toBe("ok");
    const mine = savedRemoteSha();
    const theirs = otherProcessPushes("chore: someone else");
    await commit(lease, "feat: two");

    expect(await workspaces.push(lease)).toBe("lease-rejected");

    expect(remoteSha()).toBe(theirs);
    expect(savedRemoteSha()).toBe(mine);
  });

  test("si el remoto ya tiene el commit final aunque el remote_sha esté atrás, es ok", async () => {
    await setup();
    const lease = await acquire();
    await commit(lease, "feat: one");
    expect(await workspaces.push(lease)).toBe("ok");
    const sha = await commit(lease, "feat: two");
    // El push llegó al remoto pero el core no alcanzó a registrarlo.
    await workspaces.git(lease, "push", repo.remoteDir!, `${sha}:refs/heads/${BRANCH}`);

    expect(await workspaces.push(lease)).toBe("ok");

    expect(savedRemoteSha()).toBe(sha);
  });

  test("un lease perdido no pushea", async () => {
    await setup();
    const lease = await acquire();
    await commit(lease, "feat: one");
    clock += 2 * LEASE_TTL_MS;
    await workspaces.acquire({ repo: "repo_r1", branch: BRANCH, base: "main", runId: newId("run") }).then((l) => leases.push(l));

    await expect(workspaces.push(lease)).rejects.toThrow(/ya no es el vigente/);
    expect(existsSync(join(repo.remoteDir!, "refs", "heads", BRANCH))).toBe(false);
  });

  test("un 401 deja la conexión revocada, emite connection.changed y no reintenta", async () => {
    await setup("otro-token");
    const lease = await acquire();
    await commit(lease, "feat: one");

    expect(await workspaces.push(lease)).toBe("unauthorized");

    expect(connections.list()).toMatchObject([{ account: ACCOUNT, status: "revoked" }]);
    const changes = store.events.since(0).filter((e) => e.type === "connection.changed");
    expect(changes.at(-1)?.payload).toEqual({ provider: "github", account: ACCOUNT, status: "revoked" });
    // Git manda las credenciales una sola vez; no se intenta con otras ni se repite.
    expect(server!.authorizations).toHaveLength(1);
    expect(savedRemoteSha()).toBeNull();
  });

  test("un repo sin remoto configurado lo dice", async () => {
    await setup();
    const bare = createWorkspaces({
      store,
      dataDir,
      repoConfig: () => ({ path: repo.dir, defaultBranch: "main" }),
      identityOf: async () => ({ name: "Ana Pérez", email: "ana@example.com" }),
    });
    await expect(bare.fetch("repo_r1")).rejects.toThrow(/no tiene remoto configurado/);
  });
});

describe("el token no sale del core", () => {
  test("ni los hooks del repo ni .git/config lo ven, pero GitHub sí lo recibe", async () => {
    await setup();
    const seen = join(dataDir, "hook-env.txt");
    writeFileSync(join(repo.dir, ".git", "hooks", "pre-push"), `#!/bin/sh\nenv > "${seen}"\n`, { mode: 0o755 });
    const lease = await acquire();
    await commit(lease, "feat: one");

    expect(await workspaces.push(lease)).toBe("ok");

    expect(server!.authorizations.at(-1)).toContain(Buffer.from(`${ACCOUNT}:${TOKEN}`).toString("base64"));
    const hookEnv = readFileSync(seen, "utf8");
    expect(hookEnv).toContain("GIT_ASKPASS=");
    expect(hookEnv).not.toContain(TOKEN);
    expect(readFileSync(join(repo.dir, ".git", "config"), "utf8")).not.toContain(TOKEN);
    expect(readFileSync(join(repo.dir, ".git", "config"), "utf8")).not.toContain("askpass");
    expect(await workspaces.git(lease, "config", "--list", "--show-origin")).not.toContain(TOKEN);
  });
});

describe("el token solo va al remoto del ticket", () => {
  test("un url.insteadOf en el config del repo no lleva el token a otro host", async () => {
    await setup();
    const other = await startGitHttpServer(repo.remoteDir!, { user: ACCOUNT, password: TOKEN });
    try {
      repo.git("config", `url.${other.url}.insteadOf`, server!.url);
      const lease = await acquire();
      await commit(lease, "feat: one");

      await expect(workspaces.push(lease)).rejects.toThrow(/el ticket es para/);

      expect(other.authorizations.join("\n")).not.toContain(Buffer.from(`${ACCOUNT}:${TOKEN}`).toString("base64"));
    } finally {
      await other.close();
    }
  });

  test("un pre-push no obtiene la contraseña aunque git solo haya pedido esa", async () => {
    await setup();
    // Con `credential.username` git no pide el usuario: queda una lectura del ticket sin usar.
    repo.git("config", "credential.username", ACCOUNT);
    const seen = join(dataDir, "hook-askpass.txt");
    writeHook("pre-push", `"$GIT_ASKPASS" "Password for '${server!.url}': " > "${seen}" 2>&1\nexit 0`);
    const lease = await acquire();
    await commit(lease, "feat: one");

    expect(await workspaces.push(lease)).toBe("ok");

    expect(readFileSync(seen, "utf8")).toMatch(/ya se usó/);
  });

  test("el fetch no corre hooks del repo", async () => {
    await setup();
    await acquire();
    otherProcessPushes("chore: someone else", "other");
    // El push de arriba ya movió la referencia local: sin esto el fetch no actualiza nada.
    repo.git("update-ref", "-d", "refs/remotes/origin/other");
    const seen = join(dataDir, "hook-ran.txt");
    writeHook("reference-transaction", `touch "${seen}"`);

    expect(await workspaces.fetch("repo_r1")).toBe("ok");

    expect(repo.git("rev-parse", "refs/remotes/origin/other")).toBeTruthy();
    expect(existsSync(seen)).toBe(false);
  });

  test("los hooks no heredan el entorno del core", async () => {
    await setup();
    const seen = join(dataDir, "hook-env.txt");
    writeHook("pre-push", `env > "${seen}"`);
    const lease = await acquire();
    await commit(lease, "feat: one");
    process.env.GH_TOKEN = "ghp_from_the_shell";
    try {
      expect(await workspaces.push(lease)).toBe("ok");
    } finally {
      delete process.env.GH_TOKEN;
    }

    expect(readFileSync(seen, "utf8")).not.toContain("ghp_from_the_shell");
  });
});

describe("fetch", () => {
  test("trae las branches del remoto a refs/remotes/origin con el mismo mecanismo", async () => {
    await setup();
    await acquire();
    const theirs = otherProcessPushes("chore: someone else", "other");

    expect(await workspaces.fetch("repo_r1")).toBe("ok");

    expect(repo.git("rev-parse", "refs/remotes/origin/other")).toBe(theirs);
    expect(Buffer.from(server!.authorizations.at(-1)!.replace("Basic ", ""), "base64").toString()).toBe(
      `${ACCOUNT}:${TOKEN}`,
    );
  });

  test("un 401 en el fetch también deja la conexión revocada", async () => {
    await setup("otro-token");

    expect(await workspaces.fetch("repo_r1")).toBe("unauthorized");

    expect(connections.list()).toMatchObject([{ status: "revoked" }]);
  });

  test("trae refs/pull con autenticación sin correr hooks ni mover las branches locales", async () => {
    await setup();
    const head = repo.git("rev-parse", "HEAD");
    repo.git("--git-dir", repo.remoteDir!, "update-ref", "refs/pull/7/head", head);
    const before = repo.git("show-ref", "--heads");
    const seen = join(dataDir, "fetch-pr-hook");
    writeHook("reference-transaction", `touch "${seen}"`);
    writeHook("pre-auto-gc", `touch "${seen}"`);

    expect(await workspaces.fetchPr("repo_r1", 7)).toBe("ok");

    expect(repo.git("rev-parse", "refs/clanker/pr/7/head")).toBe(head);
    expect(repo.git("show-ref", "--heads")).toBe(before);
    expect(repo.git("symbolic-ref", "HEAD")).toBe("refs/heads/main");
    expect(existsSync(seen)).toBe(false);
    expect(Buffer.from(server!.authorizations.at(-1)!.replace("Basic ", ""), "base64").toString()).toBe(`${ACCOUNT}:${TOKEN}`);
  });

  test("un 401 al traer refs/pull revoca la conexión", async () => {
    await setup("otro-token");

    expect(await workspaces.fetchPr("repo_r1", 7)).toBe("unauthorized");

    expect(connections.list()).toMatchObject([{ status: "revoked" }]);
  });

  test("un refs/pull ausente falla sin crear una referencia ni cambiar branches", async () => {
    await setup();
    const before = repo.git("show-ref");

    await expect(workspaces.fetchPr("repo_r1", 7)).rejects.toThrow("couldn't find remote ref");

    expect(repo.git("show-ref")).toBe(before);
  });
});

describe("ls-remote", () => {
  const remote = () => createGitRemote({ askpass, connections });

  test("da la punta de cada branch con el token de la conexión", async () => {
    await setup(TOKEN, { branches: { feat: [{ message: "feat: algo" }] } });

    const heads = await remote().lsRemote({ cwd: repo.dir, url: server!.url, account: ACCOUNT });

    expect(heads).toEqual({ main: remoteSha("main"), feat: remoteSha("feat") });
    expect(Buffer.from(server!.authorizations.at(-1)!.replace("Basic ", ""), "base64").toString()).toBe(`${ACCOUNT}:${TOKEN}`);
  });

  test("un 401 deja la conexión revocada", async () => {
    await setup("otro-token");

    expect(await remote().lsRemote({ cwd: repo.dir, url: server!.url, account: ACCOUNT })).toBe("unauthorized");

    expect(connections.list()).toMatchObject([{ status: "revoked" }]);
  });
});

describe("askpass", () => {
  /** Lo que git hace con `GIT_ASKPASS`: corre el script con el prompt como argumento. */
  async function ask(env: Record<string, string>, prompt: string) {
    try {
      const { stdout } = await execFileAsync(env.GIT_ASKPASS!, [prompt], { env: { PATH: process.env.PATH, ...env } });
      return { ok: true, stdout: stdout.trimEnd() };
    } catch (error) {
      return { ok: false, stderr: (error as { stderr: string }).stderr };
    }
  }

  const credentials = { username: ACCOUNT, password: TOKEN };

  const GITHUB = "https://github.com/simon/repo.git";

  test("entrega el usuario y la contraseña una vez cada uno, y el token no va en el entorno", async () => {
    const { env } = await askpass.issue(credentials, GITHUB);

    expect(Object.values(env).join("\n")).not.toContain(TOKEN);
    expect(await ask(env, "Username for 'https://github.com': ")).toEqual({ ok: true, stdout: ACCOUNT });
    expect(await ask(env, "Password for 'https://simon@github.com': ")).toEqual({ ok: true, stdout: TOKEN });
    const again = await ask(env, "Password for 'https://simon@github.com': ");
    expect(again).toMatchObject({ ok: false });
    expect(again.stderr).toMatch(/ticket venció, ya se usó o no existe/);
    expect(again.stderr).not.toContain(TOKEN);
  });

  test("no contesta a un prompt de otro origen", async () => {
    const { env } = await askpass.issue(credentials, GITHUB);

    const other = await ask(env, "Password for 'https://simon@evil.example': ");
    expect(other).toMatchObject({ ok: false });
    expect(other.stderr).toMatch(/para https:\/\/evil.example y el ticket es para https:\/\/github.com/);
    expect(await ask(env, "Password for 'http://github.com': ")).toMatchObject({ ok: false });
    // El rechazo no gasta la lectura.
    expect(await ask(env, "Password for 'https://simon@github.com': ")).toEqual({ ok: true, stdout: TOKEN });
  });

  test("un ticket vence a los 60 s", async () => {
    const { env } = await askpass.issue(credentials, GITHUB);
    clock += TICKET_TTL_MS;

    expect(await ask(env, "Username for 'https://github.com': ")).toMatchObject({ ok: false });
  });

  test("un ticket revocado no entrega nada", async () => {
    const { env, revoke } = await askpass.issue(credentials, GITHUB);
    revoke();

    expect(await ask(env, "Username for 'https://github.com': ")).toMatchObject({ ok: false });
  });

  test("un ticket inventado no entrega nada", async () => {
    const { env } = await askpass.issue(credentials, GITHUB);

    expect(await ask({ ...env, CLANKER_ASKPASS_TICKET: "inventado" }, "Username for 'https://github.com': ")).toMatchObject({ ok: false });
  });
});
