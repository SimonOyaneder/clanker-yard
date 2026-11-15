import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { API_MAJOR } from "@clanker/api";
import { removeCoreJson, writeCoreJson } from "@clanker/api/node";
import { sql } from "drizzle-orm";
import pkg from "../../package.json" with { type: "json" };
import { createConnections } from "../connections/connections";
import { createFileSecrets } from "../secrets/encrypted-file";
import { createKeychainSecrets } from "../secrets/keychain";
import type { Secrets } from "../secrets/secrets";
import { startServer } from "../server/server";
import { createIssues } from "../tracker/issues";
import { meta } from "../store/schema";
import { openStore } from "../store/store";
import { acquireCoreLock } from "./lock";
import { openCoreLog, routeConsoleTo } from "./logger";

export interface RunCoreOptions {
  dataDir: string;
  logDir: string;
  /** Carpeta de drizzle-kit con las migraciones empaquetadas junto al core. */
  migrationsFolder: string;
  /** Con `CLANKER_HOME` el core no toca el Keychain: los secretos van a un archivo en `dataDir`. */
  isolated: boolean;
}

/**
 * Arranca el core en este proceso: lock, base (migra), servidor y `core.json`, en ese orden: quien lee
 * `core.json` ya puede hablar con la API. Devuelve `"running"` si ya había otro core vivo (el proceso
 * debe salir con código 0); si no, queda corriendo hasta SIGTERM, SIGINT o `system.shutdown`, y
 * entonces borra `core.json` y `core.lock` y termina el proceso.
 */
export async function runCore(opts: RunCoreOptions): Promise<"running" | "started"> {
  const log = openCoreLog(opts.logDir);
  routeConsoleTo(log);
  process.on("uncaughtException", (error) => crash("uncaughtException", error));
  process.on("unhandledRejection", (reason) => crash("unhandledRejection", reason));
  function crash(kind: string, error: unknown): never {
    // Sin limpiar: core.json y core.lock quedan de un pid muerto, que el próximo arranque recupera.
    log.write("error", `${kind}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exit(1);
  }

  try {
    mkdirSync(opts.dataDir, { recursive: true });
    const lock = await acquireCoreLock(opts.dataDir);
    if (lock === "running") {
      log.write("info", "ya hay un core corriendo en este dataDir; salgo");
      return "running";
    }

    const store = openStore({
      path: join(opts.dataDir, "clanker.db"),
      migrationsFolder: opts.migrationsFolder,
    });
    const connections = createConnections(store, secretsFor(opts));

    let stopping: Promise<void> | undefined;
    const shutdown = (reason: string) => {
      stopping ??= (async () => {
        log.write("info", `apagando (${reason})`);
        try {
          removeCoreJson(opts.dataDir);
          await server.close();
          store.db.$client.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          store.close();
          lock.release();
          process.exit(0);
        } catch (error) {
          crash("shutdown", error);
        }
      })();
    };

    // Todavía no hay agentes ni pasos que drenar: `drain` no cambia nada hasta que existan.
    const server = await startServer({
      store,
      connections,
      issues: createIssues(store),
      coreVersion: pkg.version,
      dataDir: opts.dataDir,
      onShutdown: () => setImmediate(() => shutdown("system.shutdown")),
    });
    store.tx((tx) => {
      tx.db
        .insert(meta)
        .values({ key: "boot_id", value: server.bootId })
        .onConflictDoUpdate({ target: meta.key, set: { value: sql`excluded.value` } })
        .run();
      tx.emit({ type: "core.started", origin: "core", payload: { bootId: server.bootId } });
    });
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));

    writeCoreJson(opts.dataDir, {
      pid: process.pid,
      port: server.port,
      token: server.token,
      version: pkg.version,
      apiMajor: API_MAJOR,
      bootId: server.bootId,
    });
    log.write("info", `core ${pkg.version} escuchando en 127.0.0.1:${server.port} (boot ${server.bootId})`);
    return "started";
  } catch (error) {
    crash("boot", error);
  }
}

function secretsFor({ dataDir, isolated }: RunCoreOptions): Secrets {
  if (process.platform === "darwin" && !isolated) {
    return createKeychainSecrets({ service: "Clanker Yard" });
  }
  // Linux y Windows: archivo cifrado (el cifrado con DPAPI / libsecret es seguimiento).
  return createFileSecrets({ dir: join(dataDir, "secrets") });
}
