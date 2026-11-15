import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { loadUiKey, type KeyVault } from "./ui-key";

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "clanker-ui-key-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Un "SO" que cifra invirtiendo el texto: lo guardado en disco no es la llave. */
const vault = (available = true): KeyVault => ({
  isEncryptionAvailable: () => available,
  encryptString: (text) => Buffer.from([...text].reverse().join("")),
  decryptString: (encrypted) => [...encrypted.toString()].reverse().join(""),
});

test("con llavero la llave sobrevive entre arranques y en disco solo queda cifrada", () => {
  const file = join(dir, "ui-key");
  const first = loadUiKey(file, vault());

  expect(loadUiKey(file, vault())).toBe(first);
  expect(readFileSync(file, "utf8")).not.toContain(first);
  expect(Buffer.from(first, "base64url")).toHaveLength(32);
});

test("un archivo que el SO ya no descifra se reemplaza por una llave nueva", () => {
  const file = join(dir, "ui-key");
  const first = loadUiKey(file, vault());
  const broken: KeyVault = { ...vault(), decryptString: () => { throw new Error("clave del SO distinta"); } };

  const second = loadUiKey(file, broken);

  expect(second).not.toBe(first);
});

test("sin cifrado disponible es una llave nueva por arranque y no escribe nada", () => {
  const file = join(dir, "ui-key");

  expect(loadUiKey(file, vault(false))).not.toBe(loadUiKey(file, vault(false)));
  expect(() => readFileSync(file)).toThrow(/ENOENT/);
});
