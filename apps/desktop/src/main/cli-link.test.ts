import { mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { linkCli } from "./cli-link";

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "clanker-cli-link-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("crea la carpeta y el symlink al lanzador, e informa si la carpeta está en el PATH", () => {
  const binDir = join(dir, "nueva", "bin");
  const result = linkCli({ launcher: "/App/Resources/bin/clanker", binDir, pathEnv: `/usr/bin:${binDir}` });
  expect(result).toEqual({ link: join(binDir, "clanker"), onPath: true });
  expect(readlinkSync(result.link)).toBe("/App/Resources/bin/clanker");
  expect(linkCli({ launcher: "/App/Resources/bin/clanker", binDir, pathEnv: "/usr/bin" }).onPath).toBe(false);
});

test("reemplaza un symlink de una instalación anterior", () => {
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  symlinkSync("/vieja/Resources/bin/clanker", join(binDir, "clanker"));
  linkCli({ launcher: "/nueva/Resources/bin/clanker", binDir });
  expect(readlinkSync(join(binDir, "clanker"))).toBe("/nueva/Resources/bin/clanker");
});

test("no pisa un archivo que no es symlink", () => {
  writeFileSync(join(dir, "clanker"), "#!/bin/sh\n");
  expect(() => linkCli({ launcher: "/x", binDir: dir })).toThrow(/no es un symlink/);
});
