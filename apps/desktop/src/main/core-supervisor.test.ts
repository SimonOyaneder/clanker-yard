import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@clanker/api";
import { connectToCore, ensureCore, isPidAlive, readCoreJson } from "@clanker/api/node";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createCoreSupervisor, type CoreState, type CoreSupervisor } from "./core-supervisor";

// Lanza el core real sobre un CLANKER_HOME temporal, con un bundle propio para no pisar `dist/`.
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
let buildDir: string;
let entry: string;
let homes: string[] = [];
let supervisors: CoreSupervisor[] = [];
const UI_KEY = "llave-de-la-app";

beforeAll(() => {
  buildDir = mkdtempSync(join(tmpdir(), "clanker-desktop-build-"));
  entry = join(buildDir, "dist", "main.js");
  cpSync(join(repo, "packages/core/migrations"), join(buildDir, "migrations"), { recursive: true });
  execFileSync(process.execPath, ["scripts/build.ts", entry], { cwd: join(repo, "packages/core") });
}, 60_000);

afterAll(() => rmSync(buildDir, { recursive: true, force: true }));

afterEach(async () => {
  for (const s of supervisors) s.close();
  supervisors = [];
  for (const home of homes) {
    const info = readCoreJson(home);
    if (info && isPidAlive(info.pid)) {
      process.kill(info.pid, "SIGTERM");
      await vi.waitFor(() => expect(isPidAlive(info.pid)).toBe(false), { timeout: 10_000 });
    }
    rmSync(home, { recursive: true, force: true });
  }
  homes = [];
  vi.unstubAllEnvs();
});

function supervise(overrides: { entry?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), "clanker-desktop-"));
  homes.push(home);
  vi.stubEnv("CLANKER_HOME", home);
  const supervisor = createCoreSupervisor({ dataDir: home, logDir: join(home, "logs"), entry, uiKey: UI_KEY, pollMs: 50, ...overrides });
  supervisors.push(supervisor);
  const states: CoreState["status"][] = [];
  supervisor.onChange((s) => states.push(s.status));
  return { home, supervisor, states };
}

function liveInfo(supervisor: CoreSupervisor) {
  const state = supervisor.state();
  if (state.status !== "live") throw new Error(`se esperaba live y está ${state.status}`);
  return state;
}

describe("createCoreSupervisor", () => {
  test("lanza el core y entrega port y token", async () => {
    const { home, supervisor, states } = supervise();
    expect(supervisor.state().status).toBe("starting");

    await supervisor.start();

    const live = liveInfo(supervisor);
    expect(live).toMatchObject({ port: readCoreJson(home)?.port, token: readCoreJson(home)?.token });
    expect(states).toEqual(["live"]);
  }, 30_000);

  test("matar el core lo deja down y start() lo levanta con otro bootId", async () => {
    const { home, supervisor, states } = supervise();
    await supervisor.start();
    const first = liveInfo(supervisor);

    process.kill(readCoreJson(home)!.pid, "SIGKILL");
    await vi.waitFor(() => expect(supervisor.state().status).toBe("down"), { timeout: 5_000 });
    expect(supervisor.state()).toMatchObject({ reason: expect.stringContaining("core.log") });

    await supervisor.start();
    expect(liveInfo(supervisor).bootId).not.toBe(first.bootId);
    expect(states).toEqual(["live", "down", "starting", "live"]);
  }, 30_000);

  test("si el core vuelve por su cuenta pasa a live sin reintentar", async () => {
    const { home, supervisor } = supervise();
    await supervisor.start();
    process.kill(readCoreJson(home)!.pid, "SIGKILL");
    await vi.waitFor(() => expect(supervisor.state().status).toBe("down"), { timeout: 5_000 });

    // Lo levanta otro (por ejemplo la CLI) sobre el mismo directorio de datos.
    await ensureCore({ dataDir: home, logDir: join(home, "logs"), entry, origin: "cli" });

    await vi.waitFor(() => expect(supervisor.state().status).toBe("live"), { timeout: 5_000 });
  }, 30_000);

  test("el core solo acepta ui con la llave de la app, no con el token de core.json", async () => {
    const { home, supervisor } = supervise();
    await supervisor.start();
    const { port, token } = readCoreJson(home)!;
    const url = `http://127.0.0.1:${port}/rpc`;

    await expect(createClient({ url, token, origin: "ui" }).system.health()).rejects.toThrow();
    await expect(createClient({ url, token, origin: "ui", uiKey: "otra" }).system.health()).rejects.toThrow();
    expect(await createClient({ url, token, origin: "ui", uiKey: UI_KEY }).system.health()).toMatchObject({ uiKey: true });
  }, 30_000);

  test("un core que lanzó la CLI antes que la app se reemplaza para que reconozca la llave", async () => {
    const { home, supervisor } = supervise();
    const bare = await ensureCore({ dataDir: home, logDir: join(home, "logs"), entry, origin: "cli" });
    expect(bare.health.uiKey).toBe(false);

    await supervisor.start();

    const live = liveInfo(supervisor);
    expect(live.bootId).not.toBe(bare.info.bootId);
    expect((await connectToCore(home, "ui", UI_KEY))?.health.uiKey).toBe(true);
  }, 120_000);

  test("el core que la CLI relanza después sigue reconociendo la llave, sin reemplazarlo", async () => {
    const { home, supervisor } = supervise();
    await supervisor.start();
    process.kill(readCoreJson(home)!.pid, "SIGKILL");
    await vi.waitFor(() => expect(supervisor.state().status).toBe("down"), { timeout: 5_000 });

    const relaunched = await ensureCore({ dataDir: home, logDir: join(home, "logs"), entry, origin: "cli" });

    expect(relaunched.health.uiKey).toBe(false);
    expect((await connectToCore(home, "ui", UI_KEY))?.health.uiKey).toBe(true);
    await vi.waitFor(() => expect(supervisor.state().status).toBe("live"), { timeout: 5_000 });
  }, 30_000);

  test("un entry que no existe deja down con el comando para construirlo", async () => {
    const { supervisor } = supervise({ entry: join(buildDir, "no-existe.js") });

    await supervisor.start();

    expect(supervisor.state()).toEqual({
      status: "down",
      reason: expect.stringContaining("npm run build -w @clanker/core"),
    });
  });

  test("cerrar el supervisor no detiene el core", async () => {
    const { home, supervisor } = supervise();
    await supervisor.start();
    const { pid } = readCoreJson(home)!;

    supervisor.close();

    expect(isPidAlive(pid)).toBe(true);
    expect(await connectToCore(home, "ui")).toBeDefined();
  }, 30_000);

  test("shutdownCore apaga el core y lo deja down", async () => {
    const { home, supervisor } = supervise();
    await supervisor.start();
    const { pid } = readCoreJson(home)!;

    await supervisor.shutdownCore();

    await vi.waitFor(() => expect(isPidAlive(pid)).toBe(false), { timeout: 10_000 });
    await vi.waitFor(() => expect(supervisor.state().status).toBe("down"), { timeout: 5_000 });
  }, 30_000);
});
