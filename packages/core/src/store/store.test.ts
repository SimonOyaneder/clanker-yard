import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { microsToUsd, newId, usdToMicros } from "./conventions";
import { SchemaTooNewError } from "./migrate";
import { events, meta } from "./schema";
import { openStore, type Store } from "./store";

let dir: string;
const open: Store[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clanker-store-"));
});

afterEach(() => {
  for (const store of open.splice(0)) store.close();
  rmSync(dir, { recursive: true, force: true });
});

function memoryStore(): Store {
  const store = openStore({ path: ":memory:" });
  open.push(store);
  return store;
}

const [run1, run2] = [newId("run"), newId("run")];
const [prj1, prj2] = [newId("prj"), newId("prj")];
const runStarted = { type: "run.started", origin: "core", runId: run1 } as const;

describe("tx", () => {
  test("confirma las escrituras y los eventos, y avisa a los suscriptores después del commit", () => {
    // Una segunda conexión solo ve filas confirmadas.
    const path = join(dir, "clanker.db");
    const store = openStore({ path });
    open.push(store);
    const reader = new DatabaseSync(path, { readOnly: true });
    const seenByReader: unknown[] = [];
    const notified: number[] = [];
    store.events.subscribe((event) => {
      notified.push(event.seq);
      seenByReader.push(reader.prepare("SELECT seq FROM events WHERE seq = ?").get(event.seq));
    });

    store.tx((tx) => {
      tx.db.insert(meta).values({ key: "k", value: "v" }).run();
      tx.emit(runStarted);
      expect(notified).toEqual([]);
    });
    reader.close();

    expect(notified).toEqual([1]);
    expect(seenByReader).toEqual([{ seq: 1 }]);
    expect(store.db.select().from(meta).all()).toContainEqual({ key: "k", value: "v" });
  });

  test("un rollback no deja eventos ni escrituras, y nadie es notificado", () => {
    const store = memoryStore();
    const notified: string[] = [];
    store.events.subscribe((event) => notified.push(event.type));

    expect(() =>
      store.tx((tx) => {
        tx.db.insert(meta).values({ key: "k", value: "v" }).run();
        tx.emit({ type: "run.started", origin: "core" });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    store.tx((tx) => tx.emit({ type: "run.finished", origin: "core" }));

    expect(store.db.select().from(events).all().map((e) => e.type)).toEqual(["run.finished"]);
    expect(store.db.select().from(meta).all().map((m) => m.key)).not.toContain("k");
    expect(notified).toEqual(["run.finished"]);
  });

  test("devuelve el resultado de fn", () => {
    expect(memoryStore().tx(() => 42)).toBe(42);
  });

  test("rechaza una fn async y deshace lo escrito", () => {
    const store = memoryStore();
    expect(() =>
      store.tx(async (tx) => {
        tx.emit(runStarted);
      }),
    ).toThrow("síncrona");
    expect(store.events.since(0)).toEqual([]);
  });

  test("rechaza tx anidadas sin romper la tx externa", () => {
    const store = memoryStore();
    store.tx((tx) => {
      expect(() => store.tx(() => 1)).toThrow("anidar");
      tx.emit(runStarted);
    });
    expect(store.events.since(0)).toHaveLength(1);
  });

  test("un listener que lanza no deshace el commit, no corta a los demás y queda en el log", () => {
    const store = memoryStore();
    const received: number[] = [];
    const broken = new Error("listener roto");
    store.events.subscribe(() => {
      throw broken;
    });
    store.events.subscribe((event) => received.push(event.seq));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      store.tx((tx) => tx.emit(runStarted));
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("evento 1 (run.started)"), broken);
    } finally {
      logged.mockRestore();
    }

    expect(received).toEqual([1]);
    expect(store.events.since(0)).toHaveLength(1);
  });
});

describe("events", () => {
  test("since devuelve en orden los eventos posteriores y respeta el filtro", () => {
    const store = memoryStore();
    store.tx((tx) => {
      tx.emit({
        type: "run.started",
        origin: "core",
        projectId: prj1,
        runId: run1,
        subject: { type: "issue", id: "CLA-8" },
        payload: { a: 1 },
      });
      tx.emit({ type: "step.started", origin: "core", projectId: prj1, runId: run1 });
      tx.emit({ type: "run.started", origin: "ui", projectId: prj2, runId: run2 });
    });

    expect(store.events.since(0).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(store.events.since(1).map((e) => e.seq)).toEqual([2, 3]);
    expect(store.events.since(0, { runId: run1 }).map((e) => e.seq)).toEqual([1, 2]);
    expect(store.events.since(0, { projectId: prj2 }).map((e) => e.seq)).toEqual([3]);
    expect(store.events.since(0, { types: ["run.started"] }).map((e) => e.seq)).toEqual([1, 3]);
    expect(store.events.since(0)[0]).toEqual({
      seq: 1,
      ts: expect.any(Number),
      type: "run.started",
      origin: "core",
      projectId: prj1,
      runId: run1,
      subject: { type: "issue", id: "CLA-8" },
      payload: { a: 1 },
    });
  });

  test("subscribe solo recibe lo que cumple el filtro, hasta que se cancela", () => {
    const store = memoryStore();
    const received: string[] = [];
    const cancel = store.events.subscribe((e) => received.push(e.type), { runId: run1 });

    store.tx((tx) => {
      tx.emit({ type: "run.started", origin: "core", runId: run1 });
      tx.emit({ type: "run.started", origin: "core", runId: run2 });
    });
    cancel();
    store.tx((tx) => tx.emit({ type: "run.finished", origin: "core", runId: run1 }));

    expect(received).toEqual(["run.started"]);
  });

  test("ts sale del reloj inyectado", () => {
    const store = openStore({ path: ":memory:", now: () => 1_700_000_000_000 });
    open.push(store);
    expect(store.tx((tx) => tx.emit(runStarted)).ts).toBe(1_700_000_000_000);
  });

  test("rechaza un evento que la API no podría servir y deshace la tx", () => {
    const store = memoryStore();
    expect(() =>
      store.tx((tx) => {
        tx.emit(runStarted);
        tx.emit({ type: "run.started", origin: "core", runId: "run_1" });
      }),
    ).toThrow(/run\.started no cumple el Event de la API[\s\S]*runId/);
    expect(store.events.since(0)).toEqual([]);
  });

  test("es append-only: UPDATE y DELETE fallan", () => {
    const store = memoryStore();
    store.tx((tx) => tx.emit(runStarted));

    // drizzle envuelve el error de SQLite en `cause`.
    const appendOnly = expect.objectContaining({
      cause: expect.objectContaining({ message: expect.stringContaining("append-only") }),
    });
    const failure = (fn: () => unknown) => expect(fn).toThrow(appendOnly);
    failure(() => store.tx((tx) => tx.db.delete(events).run()));
    failure(() => store.tx((tx) => tx.db.update(events).set({ type: "error" }).run()));
    expect(store.events.since(0).map((e) => e.type)).toEqual(["run.started"]);
  });

  test("payload debe ser JSON válido", () => {
    const store = memoryStore();
    expect(() =>
      store.tx((tx) =>
        tx.db.$client
          .prepare("INSERT INTO events (ts, type, origin, payload) VALUES (0, 't', 'core', '{roto')")
          .run(),
      ),
    ).toThrow(/CHECK/);
  });
});

describe("apertura", () => {
  test("aplica los pragmas", () => {
    const store = openStore({ path: join(dir, "clanker.db") });
    open.push(store);
    const pragma = (name: string) => Object.values(store.db.$client.prepare(`PRAGMA ${name}`).get() ?? {})[0];

    expect(pragma("journal_mode")).toBe("wal");
    expect(pragma("synchronous")).toBe(1);
    expect(pragma("foreign_keys")).toBe(1);
    expect(pragma("busy_timeout")).toBe(5000);
  });
});

describe("migraciones", () => {
  // Dos migraciones mínimas con el formato de drizzle-kit: una carpeta por migración.
  function migrationsFolder(sqls: Record<string, string>): string {
    const folder = mkdtempSync(join(dir, "migrations-"));
    for (const [name, sql] of Object.entries(sqls)) {
      mkdirSync(join(folder, name));
      writeFileSync(join(folder, name, "migration.sql"), sql);
    }
    return folder;
  }
  const v1 = { "20260101000000_init": "CREATE TABLE `meta` (`key` text PRIMARY KEY, `value` text NOT NULL);" };
  const v2 = { ...v1, "20260102000000_notes": "CREATE TABLE `notes` (`id` integer PRIMARY KEY);" };

  test("una base vieja se respalda con su versión y se migra, conservando los datos", () => {
    const path = join(dir, "clanker.db");
    const old = openStore({ path, migrationsFolder: migrationsFolder(v1) });
    old.tx((tx) => tx.db.insert(meta).values({ key: "dato", value: "viejo" }).run());
    old.close();

    const store = openStore({ path, migrationsFolder: migrationsFolder(v2) });
    open.push(store);

    expect(readdirSync(join(dir, "backups"))).toEqual(["clanker-1.db"]);
    const backup = new DatabaseSync(join(dir, "backups", "clanker-1.db"), { readOnly: true });
    expect(backup.prepare("SELECT value FROM meta WHERE key = 'dato'").get()).toEqual({ value: "viejo" });
    expect(() => backup.prepare("SELECT * FROM notes").all()).toThrow(/no such table/);
    backup.close();
    expect(store.db.$client.prepare("SELECT * FROM notes").all()).toEqual([]);
    expect(store.db.select().from(meta).all()).toContainEqual({ key: "dato", value: "viejo" });
    expect(store.db.select().from(meta).all()).toContainEqual({ key: "schema_version", value: "2" });
  });

  test("una base nueva no genera respaldo y una al día no se vuelve a migrar", () => {
    const path = join(dir, "clanker.db");
    const folder = migrationsFolder(v2);
    openStore({ path, migrationsFolder: folder }).close();
    openStore({ path, migrationsFolder: folder }).close();

    expect(readdirSync(dir)).not.toContain("backups");
  });

  test("una base con versión mayor que el core lanza un error claro y no se toca", () => {
    const path = join(dir, "clanker.db");
    openStore({ path, migrationsFolder: migrationsFolder(v2) }).close();

    expect(() => openStore({ path, migrationsFolder: migrationsFolder(v1) })).toThrow(SchemaTooNewError);
    expect(() => openStore({ path, migrationsFolder: migrationsFolder(v1) })).toThrow(
      /versión de schema 2.*solo conoce hasta la 1.*Actualiza/,
    );
    expect(readdirSync(dir)).not.toContain("backups");
  });

  test("las migraciones empaquetadas crean el schema actual", () => {
    const store = memoryStore();
    expect(store.db.select().from(meta).all().map((m) => m.key)).toEqual(["schema_version"]);
  });
});

describe("convenciones", () => {
  test("newId lleva el prefijo y se ordena por creación", () => {
    const ids = Array.from({ length: 50 }, () => newId("run"));
    expect(ids.every((id) => /^run_[0-9A-HJKMNP-TV-Z]{26}$/.test(id))).toBe(true);
    expect(ids).toEqual([...ids].sort());
  });

  test("la plata ida y vuelta por micros no pierde centavos", () => {
    expect(usdToMicros(0.1 + 0.2)).toBe(300_000);
    expect(usdToMicros(920)).toBe(920_000_000);
    expect(microsToUsd(1_234_567)).toBe(1.234567);
  });
});
