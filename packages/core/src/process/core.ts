import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { API_MAJOR } from "@clanker/api";
import { removeCoreJson, writeCoreJson } from "@clanker/api/node";
import { sql } from "drizzle-orm";
import pkg from "../../package.json" with { type: "json" };
import { startCore } from "../core";
import { createClaudeRuntime } from "../agents/claude/claude-runtime";
import { createConnections } from "../connections/connections";
import { createFileSecrets } from "../secrets/encrypted-file";
import { createKeychainSecrets } from "../secrets/keychain";
import type { Secrets } from "../secrets/secrets";
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

    let stopping: Promise<void> | undefined;
    const shutdown = (reason: string) => {
      stopping ??= (async () => {
        log.write("info", `apagando (${reason})`);
        try {
          removeCoreJson(opts.dataDir);
          await core.close();
          store.db.$client.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          store.close();
          lock.release();
          process.exit(0);
        } catch (error) {
          crash("shutdown", error);
        }
      })();
    };

    // `system.shutdown({ drain })` todavía no interrumpe a los agentes: el cierre espera un momento a los pasos en curso.
    const connections = createConnections(store, secretsFor(opts));
    const core = await startCore({
      store,
      dataDir: opts.dataDir,
      connections,
      runtimes: [createClaudeRuntime({ credentials: connections.claudeCredentials, home: opts.dataDir })],
      coreVersion: pkg.version,
      onShutdown: () => setImmediate(() => shutdown("system.shutdown")),
    });
    const { server } = core;
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
