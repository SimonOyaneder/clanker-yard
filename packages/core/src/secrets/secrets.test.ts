import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createFileSecrets } from "./encrypted-file";
import { createKeychainSecrets } from "./keychain";
import type { Secrets } from "./secrets";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "clanker-secrets-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Lo que toda implementación de `Secrets` debe cumplir, sea cual sea su almacén. */
function secretsContract(make: () => Secrets): void {
  test("get de una ref que no existe da undefined", async () => {
    expect(await make().get("no-existe")).toBeUndefined();
  });

  test("set y get devuelven el mismo valor, también con comillas, saltos de línea y unicode", async () => {
    const secrets = make();
    const value = `ghp_"a'b\\c"\nlínea 2 ñ 🔑 ${"x".repeat(2000)}`;
    await secrets.set("github:simon", value);
    expect(await secrets.get("github:simon")).toBe(value);
  });

  test("set sobre una ref existente reemplaza el valor y no toca las demás", async () => {
    const secrets = make();
    await secrets.set("a", "uno");
    await secrets.set("b", "otro");
    await secrets.set("a", "dos");
    expect(await secrets.get("a")).toBe("dos");
    expect(await secrets.get("b")).toBe("otro");
  });

  test("una ref con espacios y comillas funciona", async () => {
    const secrets = make();
    const ref = `connection:linear:a b"c'd@x.cl`;
    await secrets.set(ref, "valor");
    expect(await secrets.get(ref)).toBe("valor");
  });

  test("delete borra solo esa ref y repetirlo no falla", async () => {
    const secrets = make();
    await secrets.set("a", "uno");
    await secrets.set("b", "otro");
    await secrets.delete("a");
    await secrets.delete("a");
    expect(await secrets.get("a")).toBeUndefined();
    expect(await secrets.get("b")).toBe("otro");
  });
}

describe("archivo cifrado", () => {
  let dir: string;
  const make = () => createFileSecrets({ dir });
  beforeEach(() => {
    dir = tempDir();
  });

  secretsContract(make);

  test("los valores sobreviven a una instancia nueva sobre el mismo directorio", async () => {
    await make().set("a", "persistido");
    expect(await make().get("a")).toBe("persistido");
  });

  test("ni el valor ni la ref aparecen en claro en el disco", async () => {
    await make().set("github:simon-ref", "ghp_valor-secreto");
    const onDisk = readFileSync(join(dir, "secrets.enc"), "utf8");
    expect(onDisk).not.toContain("ghp_valor-secreto");
    expect(onDisk).not.toContain("github:simon-ref");
  });

  test("la llave y el archivo quedan con permisos solo para el dueño", async () => {
    await make().set("a", "x");
    expect(statSync(join(dir, "secrets.key")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "secrets.enc")).mode & 0o777).toBe(0o600);
  });

  test("get en un directorio nuevo no crea archivos", async () => {
    expect(await make().get("a")).toBeUndefined();
    expect(() => statSync(join(dir, "secrets.key"))).toThrow();
  });

  test("set concurrentes no se pisan", async () => {
    const secrets = make();
    await Promise.all(Array.from({ length: 20 }, (_, i) => secrets.set(`ref-${i}`, `valor-${i}`)));
    for (let i = 0; i < 20; i++) expect(await secrets.get(`ref-${i}`)).toBe(`valor-${i}`);
  });

  test("con otra llave falla con un mensaje que dice qué hacer, en vez de devolver vacío", async () => {
    await make().set("a", "x");
    writeFileSync(join(dir, "secrets.key"), Buffer.alloc(32, 1));
    await expect(make().get("a")).rejects.toThrow(/No se pudo descifrar .*secrets\.enc.*vuelve a conectar/s);
  });

  test("un archivo alterado falla en vez de devolver datos", async () => {
    await make().set("a", "x");
    const path = join(dir, "secrets.enc");
    const envelope = JSON.parse(readFileSync(path, "utf8")) as { data: string };
    envelope.data = Buffer.from("otra cosa").toString("base64");
    writeFileSync(path, JSON.stringify(envelope));
    await expect(make().get("a")).rejects.toThrow(/No se pudo descifrar/);
  });

  test("crea el directorio si no existe", async () => {
    const nested = join(dir, "a", "b");
    await createFileSecrets({ dir: nested }).set("a", "x");
    expect(await createFileSecrets({ dir: nested }).get("a")).toBe("x");
  });
});

// Un keychain temporal creado aquí: nunca se toca el de login del usuario.
describe.skipIf(process.platform !== "darwin")("Keychain de macOS (keychain temporal)", () => {
  let keychain: string;
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "clanker-keychain-"));
    keychain = join(root, "test.keychain-db");
    execFileSync("/usr/bin/security", ["create-keychain", "-p", "test", keychain]);
    execFileSync("/usr/bin/security", ["unlock-keychain", "-p", "test", keychain]);
  });

  afterAll(() => {
    execFileSync("/usr/bin/security", ["delete-keychain", keychain]);
    rmSync(root, { recursive: true, force: true });
  });

  const make = () => createKeychainSecrets({ service: "clanker-yard-test", keychain });

  secretsContract(make);

  test("el valor no queda en claro en el keychain", async () => {
    await make().set("a", "ghp_valor-secreto");
    const dump = readFileSync(keychain).toString("latin1");
    expect(dump).not.toContain("ghp_valor-secreto");
  });

  test("un keychain que no existe falla en vez de caer en el de login", async () => {
    const missing = createKeychainSecrets({
      service: "clanker-yard-test",
      keychain: join(root, "no-existe.keychain-db"),
    });
    await expect(missing.get("a")).rejects.toThrow(/no-existe/);
    await expect(missing.set("a", "x")).rejects.toThrow(/no-existe/);
    await expect(missing.delete("a")).rejects.toThrow(/no-existe/);
  });
});
