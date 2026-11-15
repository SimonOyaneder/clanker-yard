import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectToCore, ensureCore, isPidAlive, readCoreJson } from "@clanker/api/node";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { buildCore } from "../../scripts/build";

// Arranca el core real (`dist/main.js`) como proceso hijo sobre un CLANKER_HOME temporal.
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

describe("core", () => {
  test("recupera un core.lock con el pid de un proceso muerto", async () => {
    const home = tempHome();
    const dead = await deadPid();
    writeFileSync(join(home, "core.lock"), String(dead));

    const core = await ensure(home);

    expect(core.info.pid).not.toBe(dead);
    expect(readFileSync(join(home, "core.lock"), "utf8")).toBe(String(core.info.pid));
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
