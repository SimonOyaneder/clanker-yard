import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { API_MAJOR, type Client } from "@clanker/api";
import { clankerDirs, connectToCore, ensureCore } from "@clanker/api/node";

/**
 * El `core/main.js` empaquetado. Por defecto el del checkout (`npm run build -w @clanker/core`), que
 * queda a la misma distancia de `src/` que de `dist/`; `CLANKER_CORE_ENTRY` lo cambia.
 */
const coreEntry = (env: NodeJS.ProcessEnv) =>
  env.CLANKER_CORE_ENTRY ?? fileURLToPath(new URL("../../../packages/core/dist/main.js", import.meta.url));

/** El cliente de un core sano; si no corre (o es de otro `apiMajor`), `ensureCore` lanza uno con origin `cli`. */
export async function connectCore(env: NodeJS.ProcessEnv = process.env): Promise<Client> {
  const { dataDir, logDir } = clankerDirs({ env });
  const entry = coreEntry(env);
  const running = await connectToCore(dataDir, "cli");
  // Sin core que reutilizar, un entry que falta se explica mejor aquí que con el exit code del hijo.
  if (running?.health.apiMajor !== API_MAJOR && !existsSync(entry)) {
    throw new Error(`No hay un core corriendo y no existe ${entry}. Corre npm run build -w @clanker/core.`);
  }
  return (await ensureCore({ dataDir, logDir, entry, origin: "cli" })).client;
}
