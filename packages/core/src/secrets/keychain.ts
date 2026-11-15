import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import type { Secrets } from "./secrets";

/** Código de salida de `security` cuando el item no existe (errSecItemNotFound). */
const ITEM_NOT_FOUND = 44;

export interface KeychainSecretsOptions {
  /** Atributo `service` de los items: los separa de los de otras apps. */
  service: string;
  /**
   * Ruta de un archivo `.keychain-db` ya creado. Sin esto se usa el keychain por defecto (login).
   * Existe para probar contra un keychain temporal sin tocar el del usuario.
   */
  keychain?: string;
}

/**
 * Secretos en el Keychain de macOS a través del comando `security`: funciona en el core lanzado con
 * `ELECTRON_RUN_AS_NODE`, donde `safeStorage` no existe. Cada ref es un item de contraseña genérica
 * (`service`, `account` = ref).
 *
 * El valor se guarda en base64: así viaja sin comillas ni saltos de línea.
 */
export function createKeychainSecrets({ service, keychain }: KeychainSecretsOptions): Secrets {
  const keychainArgs = keychain === undefined ? [] : [keychain];

  // `security` con una ruta de keychain que no existe no falla: cae en el de login. Se comprueba
  // antes para no leer, guardar ni borrar secretos en otro lado.
  async function requireKeychain(): Promise<void> {
    if (keychain !== undefined) await access(keychain);
  }

  return {
    async get(ref) {
      await requireKeychain();
      const result = await security(
        ["find-generic-password", "-s", service, "-a", ref, "-w", ...keychainArgs],
        `leer "${ref}"`,
        { allowedExitCodes: [ITEM_NOT_FOUND] },
      );
      return result === undefined ? undefined : Buffer.from(result.trim(), "base64").toString("utf8");
    },

    async set(ref, value) {
      await requireKeychain();
      // Por stdin (`security -i`) y no como argumento: un argumento lo ve cualquier usuario con `ps`.
      const command = [
        "add-generic-password",
        "-U",
        "-s",
        service,
        "-a",
        ref,
        "-w",
        Buffer.from(value, "utf8").toString("base64"),
        ...keychainArgs,
      ]
        .map(quote)
        .join(" ");
      await security(["-i"], `guardar "${ref}"`, { stdin: `${command}\n` });
    },

    async delete(ref) {
      await requireKeychain();
      await security(
        ["delete-generic-password", "-s", service, "-a", ref, ...keychainArgs],
        `borrar "${ref}"`,
        { allowedExitCodes: [ITEM_NOT_FOUND] },
      );
    },
  };
}

/** Comillas dobles con `\` y `"` escapados, como las lee `security -i`. */
function quote(arg: string): string {
  if (/[\r\n\0]/.test(arg)) {
    throw new Error("Los datos de un secreto en el Keychain no pueden llevar saltos de línea.");
  }
  return `"${arg.replace(/[\\"]/g, "\\$&")}"`;
}

/** Corre `security`. Devuelve su stdout, o `undefined` si salió con uno de `allowedExitCodes`. */
function security(
  args: string[],
  action: string,
  opts: { stdin?: string; allowedExitCodes?: number[] } = {},
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const child = execFile("/usr/bin/security", args, (error, stdout, stderr) => {
      if (error === null) {
        // En modo interactivo `security` no siempre sale con código distinto de cero al fallar.
        if (opts.stdin !== undefined && stderr.trim() !== "") {
          reject(new Error(`No se pudo ${action} en el Keychain: ${stderr.trim()}`));
        } else {
          resolve(stdout);
        }
        return;
      }
      const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
      if (typeof code === "number" && opts.allowedExitCodes?.includes(code)) {
        resolve(undefined);
        return;
      }
      reject(new Error(`No se pudo ${action} en el Keychain: ${stderr.trim() || error.message}`));
    });
    child.stdin?.end(opts.stdin);
  });
}
