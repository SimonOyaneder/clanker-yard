import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { API_MAJOR } from "@clanker/api";
import { removeCoreJson, writeCoreJson } from "@clanker/api/node";
import { eq, sql } from "drizzle-orm";
import pkg from "../../package.json" with { type: "json" };
import { startCore } from "../core";
import { createClaudeRuntime } from "../agents/claude/claude-runtime";
import { createConnections } from "../connections/connections";
import { createFileSecrets } from "../secrets/encrypted-file";
import { createKeychainSecrets } from "../secrets/keychain";
import type { Secrets } from "../secrets/secrets";
import { createProcs } from "../procs/procs";
import { newId } from "../store/conventions";
import { meta } from "../store/schema";
import { openStore } from "../store/store";
import { acquireCoreLock } from "./lock";
import { readCoreConfig } from "./config";
import { openCoreLog, routeConsoleTo } from "./logger";

const UI_KEY_HASH = "ui_key_hash";

export interface RunCoreOptions {
  dataDir: string;
  logDir: string;
  /** Carpeta de drizzle-kit con las migraciones empaquetadas junto al core. */
  migrationsFolder: string;
  /** Con `CLANKER_HOME` el core no toca el Keychain: los secretos van a un archivo en `dataDir`. */
  isolated: boolean;
  /**
   * SHA-256 de la llave de la app, que la app entrega por stdin al lanzar el core (`ensureCore`). Se guarda
   * en `meta` para que un core que lance la CLI después siga reconociendo a la app; sin ella ni nada guardado,
   * nadie puede declararse `ui`.
   */
  uiKeyHash?: string;
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
    // `core.json` y el lock se borran al final: mientras el core drena sigue siendo el dueño de este directorio.
    const shutdown = (reason: string, { drain }: { drain: boolean }) => {
      stopping ??= (async () => {
        log.write("info", `apagando (${reason}, drain ${drain})`);
        try {
          await core.close({ drain });
          store.db.$client.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          store.close();
          removeCoreJson(opts.dataDir);
          lock.release();
          process.exit(0);
        } catch (error) {
          crash("shutdown", error);
        }
      })();
    };

    const uiKeyHash = opts.uiKeyHash ?? store.db.select().from(meta).where(eq(meta.key, UI_KEY_HASH)).get()?.value;
    if (opts.uiKeyHash) {
      store.db
        .insert(meta)
        .values({ key: UI_KEY_HASH, value: opts.uiKeyHash })
        .onConflictDoUpdate({ target: meta.key, set: { value: sql`excluded.value` } })
        .run();
    }

    const connections = createConnections(store, secretsFor(opts), readCoreConfig(opts.dataDir));
    // Los procesos de los agentes se registran en `procs` desde el runtime, que se arma antes que el core.
    const procs = createProcs({ store, bootId: newId("boot") });
    const core = await startCore({
      store,
      dataDir: opts.dataDir,
      connections,
      procs,
      runtimes: [
        createClaudeRuntime({
          credentials: connections.claudeCredentials,
          home: opts.dataDir,
          procs,
          // Con `CLANKER_RECORD=<carpeta>` cada run deja su guion del runtime fake ahí.
          record: process.env.CLANKER_RECORD ? resolve(process.env.CLANKER_RECORD) : undefined,
        }),
      ],
      coreVersion: pkg.version,
      uiKeyHash,
      onShutdown: ({ drain }) => setImmediate(() => shutdown("system.shutdown", { drain })),
      watch: true,
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
    process.once("SIGTERM", () => shutdown("SIGTERM", { drain: false }));
    process.once("SIGINT", () => shutdown("SIGINT", { drain: false }));

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
