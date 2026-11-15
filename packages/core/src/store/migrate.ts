import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import type { StoreDb } from "./store";

const SCHEMA_VERSION_KEY = "schema_version";

/** La base fue escrita por un core más nuevo que este: abrirla podría corromperla. */
export class SchemaTooNewError extends Error {}

/**
 * La versión del schema es la cantidad de migraciones aplicadas. Si hay pendientes y la base
 * ya tenía datos, antes de migrar la copia a `backups/clanker-<versión>.db`, con la versión
 * que tenía la base (la copia es el estado previo a migrar).
 */
export function migrateStore(
  sqlite: DatabaseSync,
  db: StoreDb,
  opts: { path: string; migrationsFolder: string },
): void {
  const target = readMigrationFiles({ migrationsFolder: opts.migrationsFolder }).length;
  const current = readSchemaVersion(sqlite);

  if (current > target) {
    throw new SchemaTooNewError(
      `La base ${opts.path} está en la versión de schema ${current} y este core solo conoce hasta la ${target}. ` +
        "Actualiza Clanker Yard para abrirla; no se modificó nada.",
    );
  }
  if (current === target) return;

  if (current > 0 && opts.path !== ":memory:") backup(sqlite, opts.path, current);
  migrate(db, { migrationsFolder: opts.migrationsFolder });
  sqlite
    .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
    .run(SCHEMA_VERSION_KEY, String(target));
}

function readSchemaVersion(sqlite: DatabaseSync): number {
  const hasMeta = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get();
  if (!hasMeta) return 0;
  const row = sqlite.prepare("SELECT value FROM meta WHERE key = ?").get(SCHEMA_VERSION_KEY);
  return row ? Number(row.value) : 0;
}

function backup(sqlite: DatabaseSync, path: string, version: number): void {
  const dir = join(dirname(path), "backups");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `clanker-${version}.db`);
  // Un boot anterior que falló al migrar dejó la misma copia; VACUUM INTO no sobrescribe.
  rmSync(file, { force: true });
  sqlite.prepare("VACUUM INTO ?").run(file);
}
