import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Secrets } from "./secrets";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

interface Envelope {
  iv: string;
  tag: string;
  data: string;
}

/**
 * Secretos en `dir/secrets.enc` (AES-256-GCM, todas las refs en un solo bloque) con la llave en
 * `dir/secrets.key` (modo 0600, se crea en el primer `set`). Para tests y Linux, donde no hay
 * Keychain.
 *
 * La llave vive junto al archivo: protege contra un respaldo, un `grep` o un volcado que se lleven
 * solo `secrets.enc`, no contra quien pueda leer el directorio completo.
 */
export function createFileSecrets({ dir }: { dir: string }): Secrets {
  const dataPath = join(dir, "secrets.enc");
  const keyPath = join(dir, "secrets.key");

  async function readKey(create: boolean): Promise<Buffer> {
    try {
      return await readFile(keyPath);
    } catch (error) {
      if (!isNotFound(error) || !create) throw error;
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      const key = randomBytes(KEY_BYTES);
      await writeFile(keyPath, key, { mode: 0o600, flag: "wx" });
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return readFile(keyPath);
      throw error;
    }
  }

  async function load(): Promise<Map<string, string>> {
    let raw: string;
    try {
      raw = await readFile(dataPath, "utf8");
    } catch (error) {
      if (isNotFound(error)) return new Map();
      throw error;
    }
    try {
      const { iv, tag, data } = JSON.parse(raw) as Envelope;
      const decipher = createDecipheriv(ALGORITHM, await readKey(false), Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      const plain = Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]);
      return new Map(Object.entries(JSON.parse(plain.toString("utf8")) as Record<string, string>));
    } catch (cause) {
      throw new Error(
        `No se pudo descifrar ${dataPath}: la llave ${keyPath} no corresponde o el archivo está dañado. ` +
          "Si no hay respaldo, borra ambos archivos y vuelve a conectar las cuentas.",
        { cause },
      );
    }
  }

  async function save(secrets: Map<string, string>): Promise<void> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, await readKey(true), iv);
    const data = Buffer.concat([
      cipher.update(JSON.stringify(Object.fromEntries(secrets)), "utf8"),
      cipher.final(),
    ]);
    const envelope: Envelope = {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
    // Escribir y renombrar: un corte a mitad de escritura no deja `secrets.enc` truncado.
    const tmpPath = `${dataPath}.${process.pid}.tmp`;
    await writeFile(tmpPath, JSON.stringify(envelope), { mode: 0o600 });
    await rename(tmpPath, dataPath);
  }

  // Leer-modificar-escribir sin solaparse: dos `set` concurrentes no pueden pisarse entre sí.
  let queue: Promise<unknown> = Promise.resolve();
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const result = queue.then(fn);
    queue = result.catch(() => undefined);
    return result;
  }

  return {
    get: (ref) => serialized(async () => (await load()).get(ref)),
    set: (ref, value) =>
      serialized(async () => {
        const secrets = await load();
        secrets.set(ref, value);
        await save(secrets);
      }),
    delete: (ref) =>
      serialized(async () => {
        const secrets = await load();
        if (secrets.delete(ref)) await save(secrets);
      }),
  };
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
