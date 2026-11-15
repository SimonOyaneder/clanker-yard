import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { openCoreLog } from "./logger";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("escribe JSONL y rota por tamaño conservando solo los últimos archivos", () => {
  dir = mkdtempSync(join(tmpdir(), "clanker-log-"));
  const log = openCoreLog(dir, { maxBytes: 200, files: 3 });
  for (let i = 0; i < 20; i++) log.write("info", `línea ${i} ${"x".repeat(40)}`);

  expect(readdirSync(dir).sort()).toEqual(["core.log", "core.log.1", "core.log.2"]);
  const lines = readFileSync(join(dir, "core.log"), "utf8").trimEnd().split("\n");
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({ level: "info", msg: expect.stringContaining("línea 19") });
  for (const name of readdirSync(dir)) {
    expect(readFileSync(join(dir, name)).length).toBeLessThanOrEqual(200);
  }
});

test("al reabrir sigue contando el tamaño del archivo existente", () => {
  dir = mkdtempSync(join(tmpdir(), "clanker-log-"));
  const first = openCoreLog(dir, { maxBytes: 150, files: 3 });
  first.write("info", "a".repeat(60));
  const second = openCoreLog(dir, { maxBytes: 150, files: 3 });
  second.write("info", "b".repeat(60));

  expect(readdirSync(dir).sort()).toEqual(["core.log", "core.log.1"]);
  expect(readFileSync(join(dir, "core.log.1"), "utf8")).toContain("aaa");
  expect(readFileSync(join(dir, "core.log"), "utf8")).toContain("bbb");
});
