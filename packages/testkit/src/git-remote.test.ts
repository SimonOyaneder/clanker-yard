import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tempGitRepo, type TempGitRepo } from "./git";

// Se prueba aquí y no en el core por la misma razón que workspaces.test.ts: testkit puede importar
// el core y el core no puede importar testkit. Todo corre contra un servidor git HTTP local con
// Basic auth sobre un bare temporal; nunca contra GitHub ni con tokens reales.

// Cada test lanza varios git contra el servidor HTTP: solos tardan 1 a 3 s, y con la suite en paralelo
// pasaban los 5 s del default.
vi.setConfig({ testTimeout: 20_000 });

const execFileAsync = promisify(execFile);
const TOKEN = "github_pat_UNIQUE-0123456789";
const ACCOUNT = "simon";
const BRANCH = "cla-44";

/** `git http-backend` detrás de Basic auth. Anota con qué credenciales llegó cada request. */
async function startGitHttpServer(
  bareDir: string,
  credentials: { user: string; password: string },
): Promise<{ url: string; authorizations: string[]; close(): Promise<void> }> {
  const authorizations: string[] = [];
  const expected = `Basic ${Buffer.from(`${credentials.user}:${credentials.password}`).toString("base64")}`;
  const server: Server = createServer((req, res) => {
    const authorization = req.headers.authorization;
    if (authorization !== undefined) authorizations.push(authorization);
    if (authorization !== expected) {
      req.resume();
      res.writeHead(401, { "www-authenticate": 'Basic realm="fake"' }).end("unauthorized");
      return;
    }
    const url = new URL(req.url ?? "/", "http://fake");
    const cgi = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_PROJECT_ROOT: dirname(bareDir),
        GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: req.method,
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers["content-type"],
        CONTENT_LENGTH: req.headers["content-length"],
        HTTP_CONTENT_ENCODING: req.headers["content-encoding"],
        REMOTE_USER: credentials.user,
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    req.pipe(cgi.stdin);
    const chunks: Buffer[] = [];
    cgi.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    cgi.on("close", () => {
      const out = Buffer.concat(chunks);
      const split = out.indexOf("\r\n\r\n");
      const head = out.subarray(0, split).toString("utf8").split("\r\n");
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of head) {
        const [name, ...value] = line.split(": ");
        if (name!.toLowerCase() === "status") status = Number.parseInt(value.join(": "), 10);
        else headers[name!] = value.join(": ");
      }
      res.writeHead(status, headers).end(out.subarray(split + 4));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/${basename(bareDir)}`,
    authorizations,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

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
  connections = createConnections(store, createFileSecrets({ dir: join(dataDir, "secrets") }));
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
    repos: () => ({
      path: repo.dir,
      defaultBranch: "main",
      remote: { url: server!.url, account: ACCOUNT },
    }),
    identity: { name: "Clanker Yard", email: "yard@clanker.invalid" },
    remote: createGitRemote({ askpass, connections }),
    now: () => clock,
  });
}

async function acquire(branch = BRANCH) {
  const lease = await workspaces.acquire({ repo: "r1", branch, base: "main", runId: newId("run") });
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
    await workspaces.acquire({ repo: "r1", branch: BRANCH, base: "main", runId: newId("run") }).then((l) => leases.push(l));

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
      repos: () => ({ path: repo.dir, defaultBranch: "main" }),
      identity: { name: "Clanker Yard", email: "yard@clanker.invalid" },
    });
    await expect(bare.fetch("r1")).rejects.toThrow(/no tiene remoto configurado/);
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

    expect(await workspaces.fetch("r1")).toBe("ok");

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

    expect(await workspaces.fetch("r1")).toBe("ok");

    expect(repo.git("rev-parse", "refs/remotes/origin/other")).toBe(theirs);
    expect(Buffer.from(server!.authorizations.at(-1)!.replace("Basic ", ""), "base64").toString()).toBe(
      `${ACCOUNT}:${TOKEN}`,
    );
  });

  test("un 401 en el fetch también deja la conexión revocada", async () => {
    await setup("otro-token");

    expect(await workspaces.fetch("r1")).toBe("unauthorized");

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
