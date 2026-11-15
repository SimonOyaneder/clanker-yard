import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { clankerDirs, readCoreJson, writeCoreJson } from "./node";

describe("clankerDirs", () => {
  test("macOS: Application Support y Logs en el home", () => {
    expect(clankerDirs({ platform: "darwin", env: {}, home: "/Users/ana" })).toEqual({
      dataDir: "/Users/ana/Library/Application Support/Clanker Yard",
      logDir: "/Users/ana/Library/Logs/Clanker Yard",
    });
  });

  test("Linux: respeta XDG y cae en ~/.local", () => {
    expect(
      clankerDirs({
        platform: "linux",
        env: { XDG_DATA_HOME: "/xdg/data", XDG_STATE_HOME: "/xdg/state" },
        home: "/home/ana",
      }),
    ).toEqual({ dataDir: "/xdg/data/clanker-yard", logDir: "/xdg/state/clanker-yard" });
    expect(clankerDirs({ platform: "linux", env: {}, home: "/home/ana" })).toEqual({
      dataDir: "/home/ana/.local/share/clanker-yard",
      logDir: "/home/ana/.local/state/clanker-yard",
    });
  });

  test("Windows: APPDATA para datos y LOCALAPPDATA para logs", () => {
    expect(
      clankerDirs({
        platform: "win32",
        env: { APPDATA: "C:\\Users\\ana\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\ana\\AppData\\Local" },
        home: "C:\\Users\\ana",
      }),
    ).toEqual({
      dataDir: "C:\\Users\\ana\\AppData\\Roaming\\Clanker Yard",
      logDir: "C:\\Users\\ana\\AppData\\Local\\Clanker Yard",
    });
  });

  test("CLANKER_HOME pisa todo, en cualquier SO", () => {
    const env = { XDG_DATA_HOME: "/xdg" };
    for (const platform of ["darwin", "linux"] as const) {
      expect(clankerDirs({ platform, env: { ...env, CLANKER_HOME: "/tmp/home" }, home: "/Users/ana" })).toEqual({
        dataDir: "/tmp/home",
        logDir: "/tmp/home/logs",
      });
    }
    expect(clankerDirs({ platform: "win32", env: { CLANKER_HOME: "C:\\tmp\\home" }, home: "C:\\Users\\ana" })).toEqual({
      dataDir: "C:\\tmp\\home",
      logDir: "C:\\tmp\\home\\logs",
    });
  });
});

describe("core.json", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const info = { pid: 123, port: 4567, token: "t", version: "1.0.0", apiMajor: 1, bootId: "boot_x" };

  test("se escribe con modo 0600 y se lee igual", () => {
    dir = mkdtempSync(join(tmpdir(), "clanker-corejson-"));
    writeCoreJson(dir, info);
    if (process.platform !== "win32") {
      expect(statSync(join(dir, "core.json")).mode & 0o777).toBe(0o600);
    }
    expect(readCoreJson(dir)).toEqual(info);
  });

  test("sin archivo devuelve undefined", () => {
    dir = mkdtempSync(join(tmpdir(), "clanker-corejson-"));
    expect(readCoreJson(dir)).toBeUndefined();
  });
});
