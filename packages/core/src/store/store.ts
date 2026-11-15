import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { Event, EventFilter } from "@clanker/api";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { drizzle, type NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { migrateStore } from "./migrate";
import { events } from "./schema";

export type StoreDb = NodeSQLiteDatabase & { $client: DatabaseSync };

/** Un evento por escribir: `seq` y `ts` los pone el store y `payload` vale `{}` si no viene. */
export type NewEvent = Omit<Event, "seq" | "ts" | "payload"> & Partial<Pick<Event, "payload">>;

export interface Tx {
  /** La misma conexión y la misma transacción: se confirma o se deshace junto con los eventos. */
  db: StoreDb;
  /** Escribe el evento en la tx; los suscriptores lo reciben recién después del commit. */
  emit(event: NewEvent): Event;
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
    since(seq: number, filter?: EventFilter): Event[];
    /** Llama a `listener` por cada evento confirmado que cumpla el filtro. Devuelve cómo cancelar. */
    subscribe(listener: (event: Event) => void, filter?: EventFilter): () => void;
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
  const listeners = new Set<{ listener: (event: Event) => void; filter: EventFilter }>();
  let inTx = false;

  function publish(committed: Event[]): void {
    for (const event of committed) {
      for (const { listener, filter } of listeners) {
        if (!matches(filter, event)) continue;
        try {
          listener(event);
        } catch (error) {
          // El commit ya ocurrió: lanzar desde tx() haría creer que falló, y relanzarlo como
          // excepción no capturada tumbaría el core con todas sus corridas por el bug de un suscriptor.
          console.error(`Un suscriptor de eventos falló con el evento ${event.seq} (${event.type}):`, error);
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
      const written: Event[] = [];
      const emit = (event: NewEvent): Event => {
        const stored = toEvent(
          db
            .insert(events)
            .values({ ...event, ts: now(), payload: event.payload ?? {} })
            .returning()
            .get(),
        );
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
        const rows = db
          .select()
          .from(events)
          .where(
            and(
              gt(events.seq, seq),
              filter.projectId === undefined ? undefined : eq(events.projectId, filter.projectId),
              filter.runId === undefined ? undefined : eq(events.runId, filter.runId),
              filter.types === undefined ? undefined : inArray(events.type, filter.types),
            ),
          )
          .orderBy(asc(events.seq))
          .all();
        return rows.map(toEvent);
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

function matches(filter: EventFilter, event: Event): boolean {
  return (
    (filter.projectId === undefined || filter.projectId === event.projectId) &&
    (filter.runId === undefined || filter.runId === event.runId) &&
    (filter.types === undefined || filter.types.includes(event.type))
  );
}

/** Las columnas vacías vuelven como `null`; el `Event` de la API las omite. */
function toEvent({ projectId, runId, stepRunId, subject, ...row }: typeof events.$inferSelect): Event {
  return {
    ...row,
    ...(projectId === null ? {} : { projectId }),
    ...(runId === null ? {} : { runId }),
    ...(stepRunId === null ? {} : { stepRunId }),
    ...(subject === null ? {} : { subject }),
  };
}

function isThenable(value: unknown): boolean {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}
