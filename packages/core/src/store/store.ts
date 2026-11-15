import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { and, asc, eq, gt } from "drizzle-orm";
import { drizzle, type NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { migrateStore } from "./migrate";
import { events } from "./schema";

export type StoreDb = NodeSQLiteDatabase & { $client: DatabaseSync };
export type StoredEvent = typeof events.$inferSelect;

export interface NewEvent {
  /** `entidad.verbo`, por ejemplo `run.started`. */
  type: string;
  origin: StoredEvent["origin"];
  projectId?: string;
  runId?: string;
  stepRunId?: string;
  subject?: string;
  /** Mínimo: ids y lo que cambió. El detalle se lee de las tablas. */
  payload?: unknown;
}

export interface EventFilter {
  projectId?: string;
  runId?: string;
  type?: string;
}

export interface Tx {
  /** La misma conexión y la misma transacción: se confirma o se deshace junto con los eventos. */
  db: StoreDb;
  /** Escribe el evento en la tx; los suscriptores lo reciben recién después del commit. */
  emit(event: NewEvent): StoredEvent;
}

export interface Store {
  /** Solo lecturas. Toda mutación pasa por `tx`, para que quede con sus eventos. */
  db: StoreDb;
  /**
   * Corre `fn` en una transacción `BEGIN IMMEDIATE`: commit si retorna, rollback si lanza.
   * Es síncrona a propósito (nada de awaits con la base bloqueada) y no se anida.
   */
  tx<T>(fn: (tx: Tx) => T): T;
  events: {
    /** Eventos con `seq` mayor que `seq`, en orden. */
    since(seq: number, filter?: EventFilter): StoredEvent[];
    /** Llama a `listener` por cada evento confirmado que cumpla el filtro. Devuelve cómo cancelar. */
    subscribe(listener: (event: StoredEvent) => void, filter?: EventFilter): () => void;
  };
  close(): void;
}

export interface OpenStoreOptions {
  /** Ruta de `clanker.db`, o `:memory:` en tests. */
  path: string;
  /** Carpeta de drizzle-kit con una carpeta por migración. Por defecto, la que empaqueta el core. */
  migrationsFolder?: string;
  now?: () => number;
}

const bundledMigrations = fileURLToPath(new URL("../../migrations", import.meta.url));

export function openStore(opts: OpenStoreOptions): Store {
  const now = opts.now ?? Date.now;
  const sqlite = new DatabaseSync(opts.path);
  try {
    sqlite.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    const db = drizzle({ client: sqlite });
    migrateStore(sqlite, db, {
      path: opts.path,
      migrationsFolder: opts.migrationsFolder ?? bundledMigrations,
    });
    return createStore(sqlite, db, now);
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

function createStore(sqlite: DatabaseSync, db: StoreDb, now: () => number): Store {
  const listeners = new Set<{ listener: (event: StoredEvent) => void; filter: EventFilter }>();
  let inTx = false;

  function publish(committed: StoredEvent[]): void {
    for (const event of committed) {
      for (const { listener, filter } of listeners) {
        if (!matches(filter, event)) continue;
        try {
          listener(event);
        } catch (error) {
          // El commit ya ocurrió: lanzar desde tx() haría creer que falló. Un listener que
          // lanza es un bug suyo; se reporta como excepción no capturada sin cortar a los demás.
          queueMicrotask(() => {
            throw error;
          });
        }
      }
    }
  }

  return {
    db,
    tx(fn) {
      if (inTx) {
        throw new Error(
          "store.tx no se puede anidar: pasa el `tx` recibido a las funciones que escriben.",
        );
      }
      const written: StoredEvent[] = [];
      const emit = (event: NewEvent): StoredEvent => {
        const stored = db
          .insert(events)
          .values({
            ts: now(),
            type: event.type,
            origin: event.origin,
            projectId: event.projectId,
            runId: event.runId,
            stepRunId: event.stepRunId,
            subject: event.subject,
            payload: event.payload ?? {},
          })
          .returning()
          .get();
        written.push(stored);
        return stored;
      };

      sqlite.exec("BEGIN IMMEDIATE");
      inTx = true;
      let result: ReturnType<typeof fn>;
      try {
        result = fn({ db, emit });
        if (isThenable(result)) {
          throw new Error(
            "store.tx(fn) debe ser síncrona: haz el trabajo async antes y deja dentro solo las escrituras.",
          );
        }
        sqlite.exec("COMMIT");
      } catch (error) {
        // Si SQLite ya cerró la tx por su cuenta (disco lleno, por ejemplo) no hay nada que deshacer.
        if (sqlite.isTransaction) sqlite.exec("ROLLBACK");
        throw error;
      } finally {
        inTx = false;
      }
      publish(written);
      return result;
    },
    events: {
      since(seq, filter = {}) {
        return db
          .select()
          .from(events)
          .where(
            and(
              gt(events.seq, seq),
              filter.projectId === undefined ? undefined : eq(events.projectId, filter.projectId),
              filter.runId === undefined ? undefined : eq(events.runId, filter.runId),
              filter.type === undefined ? undefined : eq(events.type, filter.type),
            ),
          )
          .orderBy(asc(events.seq))
          .all();
      },
      subscribe(listener, filter = {}) {
        const entry = { listener, filter };
        listeners.add(entry);
        return () => listeners.delete(entry);
      },
    },
    close() {
      sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      sqlite.close();
    },
  };
}

function matches(filter: EventFilter, event: StoredEvent): boolean {
  return (
    (filter.projectId === undefined || filter.projectId === event.projectId) &&
    (filter.runId === undefined || filter.runId === event.runId) &&
    (filter.type === undefined || filter.type === event.type)
  );
}

function isThenable(value: unknown): boolean {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}
