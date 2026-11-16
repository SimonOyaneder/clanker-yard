import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createClient } from "@clanker/api";
import { connectToCore, ensureCore, isPidAlive, readCoreJson } from "@clanker/api/node";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { buildCore } from "../../scripts/build";

// Arranca el core real (`dist/main.js`) como proceso hijo sobre un CLANKER_HOME temporal. Cada core tarda
// segundos en arrancar o cerrar cuando la suite completa corre en paralelo: el default de 5 s no alcanza.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let entry: string;
let homes: string[] = [];

beforeAll(async () => {
  entry = await buildCore();
}, 60_000);

afterEach(async () => {
  for (const home of homes) {
    const info = readCoreJson(home);
    if (info && isPidAlive(info.pid)) {
      process.kill(info.pid, "SIGTERM");
      await vi.waitFor(() => expect(isPidAlive(info.pid)).toBe(false), { timeout: 10_000 });
    }
    rmSync(home, { recursive: true, force: true });
  }
  homes = [];
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "clanker-core-"));
  homes.push(home);
  return home;
}

function ensure(home: string, extra: { apiMajor?: number } = {}) {
  return ensureCore({
    dataDir: home,
    logDir: join(home, "logs"),
    entry,
    origin: "cli",
    ...extra,
  });
}

/** Pids de procesos `main.js` lanzados sobre este `home`. */
function coresOn(home: string): number[] {
  return execFileSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.includes(entry) && line.includes(home))
    .map((line) => Number.parseInt(line.trim(), 10));
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid!;
}

/**
 * Un repo git con una receta cuyo `requires` deja un `sleep` corriendo: `repos.testRecipe` lo lanza como
 * hijo del core. El hijo escribe su pid en un archivo (`exec` mantiene el pid del `sh`, que lidera el grupo).
 */
function holdingRepo(home: string, shellPrefix = ""): { home: string; path: string; pidFile: string } {
  const path = join(home, "repo");
  const pidFile = join(home, "child.pid");
  mkdirSync(join(path, ".clanker"), { recursive: true });
  const check = `${shellPrefix}echo $$ > '${pidFile}'; exec sleep 300`;
  writeFileSync(join(path, ".clanker", "recipe.json"), JSON.stringify({ version: 1, requires: [{ name: "hold", check }] }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: path, env, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", "--all");
  git("-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "-m", "chore: initial commit");
  return { home, path, pidFile };
}

/** Pide la prueba de la receta de `repo` al core y espera a que su hijo `sleep` esté corriendo; devuelve su pid. */
async function startHeldChild(core: Awaited<ReturnType<typeof ensure>>, repo: ReturnType<typeof holdingRepo>): Promise<number> {
  const client = createClient({ url: `http://127.0.0.1:${core.info.port}/rpc`, token: core.info.token, origin: "cli" });
  const { id } = await client.repos.add({ path: repo.path });
  // La llamada queda abierta mientras el hijo vive; muere con el core.
  void client.repos.testRecipe({ repoId: id }).catch(() => {});
  await vi.waitFor(() => expect(readFileSync(repo.pidFile, "utf8").trim()).toMatch(/^\d+$/), { timeout: 10_000 });
  const pid = Number.parseInt(readFileSync(repo.pidFile, "utf8"), 10);
  expect(isPidAlive(pid)).toBe(true);
  // El hijo puede escribir su pid antes de que el core lo registre en `procs`: sin la fila, ni el
  // apagado ni el próximo core saben de él.
  await vi.waitFor(() => expect(isTracked(repo.home, pid)).toBe(true), { timeout: 10_000 });
  return pid;
}

function isTracked(home: string, pid: number): boolean {
  const db = new DatabaseSync(join(home, "clanker.db"), { readOnly: true });
  try {
    return db.prepare("SELECT 1 FROM procs WHERE pid = ?").get(pid) !== undefined;
  } finally {
    db.close();
  }
}

const killGroup = (pid: number) => {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Ya terminó.
  }
};

describe("ensureCore", () => {
  test("dos llamadas concurrentes dejan un solo core vivo", async () => {
    const home = tempHome();
    const [a, b] = await Promise.all([ensure(home), ensure(home)]);

    expect(a.info.bootId).toBe(b.info.bootId);
    expect(a.info.pid).toBe(b.info.pid);
    // El core que perdió la carrera sale solo.
    await vi.waitFor(() => expect(coresOn(home)).toEqual([a.info.pid]), { timeout: 10_000 });
    expect(await a.client.system.health()).toMatchObject({ bootId: a.info.bootId });
  });

  test("con un core sano se conecta sin lanzar otro", async () => {
    const home = tempHome();
    const first = await ensure(home);
    const second = await ensure(home);

    expect(second.info).toEqual(first.info);
    expect(coresOn(home)).toEqual([first.info.pid]);
  });

  test("si el apiMajor del core difiere, lo apaga con drain y lanza uno nuevo", async () => {
    const home = tempHome();
    const old = await ensure(home);
    const next = await ensure(home, { apiMajor: old.health.apiMajor + 1 });

    expect(next.info.bootId).not.toBe(old.info.bootId);
    expect(next.info.pid).not.toBe(old.info.pid);
    expect(isPidAlive(old.info.pid)).toBe(false);
  });
});

describe("ensureCore con un core de otra versión", () => {
  test("si el core que contesta lo lanzó otro y tiene otro apiMajor, lo reemplaza; si vuelve a pasar, falla con un error accionable", async () => {
    const home = tempHome();
    // Un lanzador que sale con 0 después de dejar un core corriendo: como otra app que ganó la carrera.
    const other = join(home, "other-launcher.mjs");
    writeFileSync(
      other,
      `import { spawn } from "node:child_process";
spawn(process.execPath, [${JSON.stringify(entry)}, "--data-dir", ${JSON.stringify(home)}], { detached: true, stdio: "ignore" }).unref();
`,
    );
    const old = await ensure(home);

    await expect(
      ensureCore({ dataDir: home, logDir: join(home, "logs"), entry: other, origin: "cli", apiMajor: old.health.apiMajor + 1 }),
    ).rejects.toThrow(/apiMajor \d+ y este cliente espera \d+/);
    // Se lo apagó y se lo volvió a encontrar una vez: nunca se aceptó en silencio.
    expect(isPidAlive(old.info.pid)).toBe(false);
  }, 60_000);
});

describe("procesos hijos", () => {
  test("si el core muere con SIGKILL, su hijo sigue vivo hasta que el próximo core lo mata", async () => {
    const home = tempHome();
    const repo = holdingRepo(home);
    const first = await ensure(home);
    const child = await startHeldChild(first, repo);

    process.kill(first.info.pid, "SIGKILL");
    await vi.waitFor(() => expect(isPidAlive(first.info.pid)).toBe(false), { timeout: 10_000 });
    try {
      expect(isPidAlive(child)).toBe(true);

      const second = await ensure(home);

      expect(second.info.bootId).not.toBe(first.info.bootId);
      await vi.waitFor(() => expect(isPidAlive(child)).toBe(false), { timeout: 10_000 });
    } finally {
      killGroup(child);
    }
  }, 40_000);

  test("SIGTERM manda SIGTERM al grupo del hijo, borra core.json y core.lock y sale", async () => {
    const home = tempHome();
    const repo = holdingRepo(home);
    const core = await ensure(home);
    const child = await startHeldChild(core, repo);

    process.kill(core.info.pid, "SIGTERM");

    try {
      await vi.waitFor(() => expect(isPidAlive(core.info.pid)).toBe(false), { timeout: 15_000 });
      expect(isPidAlive(child)).toBe(false);
      expect(readCoreJson(home)).toBeUndefined();
      expect(() => statSync(join(home, "core.lock"))).toThrow(/ENOENT/);
    } finally {
      killGroup(child);
    }
  }, 40_000);

  test("un hijo que ignora SIGTERM muere con SIGKILL a los 10 s y core.json sigue ahí mientras tanto", async () => {
    const home = tempHome();
    const repo = holdingRepo(home, "trap '' TERM; ");
    const core = await ensure(home);
    const child = await startHeldChild(core, repo);

    process.kill(core.info.pid, "SIGTERM");

    try {
      // El core todavía está apagándose: sigue siendo el dueño del directorio y contesta health.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(isPidAlive(core.info.pid)).toBe(true);
      expect(isPidAlive(child)).toBe(true);
      expect(readCoreJson(home)?.bootId).toBe(core.info.bootId);
      expect((await connectToCore(home, "cli"))?.info.bootId).toBe(core.info.bootId);

      await vi.waitFor(() => expect(isPidAlive(core.info.pid)).toBe(false), { timeout: 20_000 });
      expect(isPidAlive(child)).toBe(false);
      expect(readCoreJson(home)).toBeUndefined();
    } finally {
      killGroup(child);
    }
  }, 40_000);
});

describe("core", () => {
  test("recupera un core.lock con el pid de un proceso muerto", async () => {
    const home = tempHome();
    const dead = await deadPid();
    writeFileSync(join(home, "core.lock"), String(dead));

    const core = await ensure(home);

    expect(core.info.pid).not.toBe(dead);
    expect(readFileSync(join(home, "core.lock"), "utf8")).toBe(String(core.info.pid));
  });

  test("un core.lock.break que dejó un proceso muerto a mitad no deja el arranque colgado", async () => {
    const home = tempHome();
    writeFileSync(join(home, "core.lock"), String(await deadPid()));
    const guard = join(home, "core.lock.break");
    writeFileSync(guard, "");
    const minuteAgo = new Date(Date.now() - 60_000);
    utimesSync(guard, minuteAgo, minuteAgo);

    const core = await ensure(home);

    expect(readFileSync(join(home, "core.lock"), "utf8")).toBe(String(core.info.pid));
    expect(() => statSync(guard)).toThrow(/ENOENT/);
  });

  test("con un lock viejo y dos arranques a la vez, queda un solo core", async () => {
    const home = tempHome();
    writeFileSync(join(home, "core.lock"), String(await deadPid()));

    const [a, b] = await Promise.all([ensure(home), ensure(home)]);

    expect(a.info.pid).toBe(b.info.pid);
    await vi.waitFor(() => expect(coresOn(home)).toEqual([a.info.pid]), { timeout: 10_000 });
  });

  test.skipIf(process.platform === "win32")("core.json queda con modo 0600 y con lo que lo describe", async () => {
    const home = tempHome();
    const core = await ensure(home);

    expect(statSync(join(home, "core.json")).mode & 0o777).toBe(0o600);
    expect(readCoreJson(home)).toEqual({
      pid: core.info.pid,
      port: expect.any(Number),
      token: expect.any(String),
      version: expect.any(String),
      apiMajor: core.health.apiMajor,
      bootId: core.health.bootId,
    });
  });

  test("un segundo core sobre el mismo directorio sale con código 0 y deja vivo al primero", async () => {
    const home = tempHome();
    const first = await ensure(home);

    const second = spawn(process.execPath, [entry, "--data-dir", home, "--log-dir", join(home, "logs")]);
    const code = await new Promise((resolve) => second.once("exit", resolve));

    expect(code).toBe(0);
    expect((await connectToCore(home, "cli"))?.info.bootId).toBe(first.info.bootId);
  });

  test("system.shutdown responde y borra core.json y core.lock", async () => {
    const home = tempHome();
    const core = await ensure(home);

    await core.client.system.shutdown({ drain: true });

    await vi.waitFor(() => expect(isPidAlive(core.info.pid)).toBe(false), { timeout: 10_000 });
    expect(readCoreJson(home)).toBeUndefined();
    expect(() => statSync(join(home, "core.lock"))).toThrow(/ENOENT/);
  });

  test("SIGTERM hace el mismo cierre normal", async () => {
    const home = tempHome();
    const core = await ensure(home);

    process.kill(core.info.pid, "SIGTERM");

    await vi.waitFor(() => expect(isPidAlive(core.info.pid)).toBe(false), { timeout: 10_000 });
    expect(readCoreJson(home)).toBeUndefined();
    expect(() => statSync(join(home, "core.lock"))).toThrow(/ENOENT/);
  });

  test("migra la base, guarda el boot_id en meta y escribe core.log", async () => {
    const home = tempHome();
    const core = await ensure(home);

    expect((await core.client.system.health()).schemaVersion).toBeGreaterThan(0);
    const log = readFileSync(join(home, "logs", "core.log"), "utf8");
    expect(log).toContain(core.info.bootId);
    expect(JSON.parse(log.split("\n")[0]!)).toMatchObject({ level: "info" });
  });

  test.each([
    ["config.json", (home: string) => writeFileSync(join(home, "config.json"), JSON.stringify({ linear: { clientId: "lin-from-file" } })), {}],
    ["la variable de entorno", () => {}, { CLANKER_LINEAR_CLIENT_ID: "lin-from-file" }],
  ])("el client_id de Linear de %s llega a linearAuth", async (_name, setup, env) => {
    const home = tempHome();
    mkdirSync(home, { recursive: true });
    setup(home);
    const child = spawn(process.execPath, [entry, "--data-dir", home, "--log-dir", join(home, "logs")], {
      env: { ...process.env, ...env },
    });
    await vi.waitFor(() => expect(readCoreJson(home)?.pid).toBe(child.pid), { timeout: 10_000 });
    const core = await connectToCore(home, "cli");

    // El redirect de Linear usa un puerto fijo (48721): si otro proceso lo tiene, falla por el puerto, no por el client_id.
    const login = await core!.client.connections.linearAuth().catch((error: Error) => error);
    if (login instanceof Error) expect(login.message).not.toContain("client_id");
    else expect(new URL(login.url).searchParams.get("client_id")).toBe("lin-from-file");
  });

  test("sin --data-dir ni CLANKER_HOME sale con error accionable", async () => {
    const env = { ...process.env };
    delete env.CLANKER_HOME;
    const child = spawn(process.execPath, [entry], { env });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const code = await new Promise((resolve) => child.once("exit", resolve));

    expect(code).toBe(2);
    expect(stderr).toContain("--data-dir");
  });
});

test("CLANKER_HOME alcanza para arrancarlo a mano", async () => {
  const home = tempHome();
  mkdirSync(home, { recursive: true });
  const child = spawn(process.execPath, [entry], { env: { ...process.env, CLANKER_HOME: home } });

  await vi.waitFor(() => expect(readCoreJson(home)?.pid).toBe(child.pid), { timeout: 10_000 });
  expect(await connectToCore(home, "cli")).toBeDefined();
});
