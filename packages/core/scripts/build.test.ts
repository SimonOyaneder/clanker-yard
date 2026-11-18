import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

const run = promisify(execFile);
let directory: string;

afterEach(() => rmSync(directory, { recursive: true, force: true }));

test("el script construye el bundle desde una ruta con espacios", async () => {
  directory = mkdtempSync(join(tmpdir(), "clanker build "));
  mkdirSync(join(directory, "scripts"));
  mkdirSync(join(directory, "src"));
  cpSync(fileURLToPath(new URL("./build.ts", import.meta.url)), join(directory, "scripts/build.ts"));
  symlinkSync(fileURLToPath(new URL("../../../node_modules", import.meta.url)), join(directory, "node_modules"));
  writeFileSync(join(directory, "src/main.ts"), 'console.log("core de prueba");\n');
  const outfile = join(directory, "out/main.js");

  await run(process.execPath, [join(directory, "scripts/build.ts"), outfile]);

  const result = await run(process.execPath, [outfile]);
  expect(result.stdout).toBe("core de prueba\n");
}, 30_000);
