import { expect, test } from "vitest";
import { coreEntry } from "./core-entry";

test("empaquetada usa el core de los recursos, fuera del asar", () => {
  const app = { isPackaged: true, appPath: "/Applications/Clanker Yard.app/Contents/Resources/app.asar", resourcesPath: "/Applications/Clanker Yard.app/Contents/Resources" };
  expect(coreEntry(app)).toBe("/Applications/Clanker Yard.app/Contents/Resources/core/dist/main.js");
});

test("en desarrollo usa el bundle del checkout", () => {
  expect(coreEntry({ isPackaged: false, appPath: "/repo/apps/desktop", resourcesPath: "/x/electron/Resources" })).toBe("/repo/packages/core/dist/main.js");
});
