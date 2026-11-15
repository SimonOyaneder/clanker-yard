import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Lo que usamos de `safeStorage` de Electron: cifra con una clave que el SO guarda para esta app. */
export interface KeyVault {
  isEncryptionAvailable(): boolean;
  encryptString(text: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/**
 * La llave de la app: 32 bytes aleatorios que solo conoce este proceso. El core solo acepta el origin `ui`
 * con ella (ver "Origin `ui`" en AGENTS.md), así que un agente que lee `core.json` no puede aprobar un
 * merge haciéndose pasar por la app.
 *
 * Queda en `file` cifrada con una clave del SO (en macOS, el llavero con acceso solo de la app: `security`
 * pide confirmación) para sobrevivir entre arranques, porque el core sigue vivo al cerrar la app y
 * reconoce la llave del arranque anterior. Sin cifrado disponible es una llave nueva por arranque: el
 * core se relanza al abrir la app.
 */
export function loadUiKey(file: string, vault: KeyVault): string {
  if (!vault.isEncryptionAvailable()) return newKey();
  try {
    return vault.decryptString(readFileSync(file));
  } catch {
    // Primer arranque, o el archivo o la clave del SO ya no sirven: una llave nueva (el core se relanza para reconocerla).
    const key = newKey();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, vault.encryptString(key), { mode: 0o600 });
    return key;
  }
}

const newKey = () => randomBytes(32).toString("base64url");
