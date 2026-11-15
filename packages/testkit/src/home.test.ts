import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@clanker/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { loadFixture, seedDb, writeFixture, type TestHome } from "./home";
import { scenarios, type Scenario } from "./scenarios";

let fixturesDir: string;
const homes: TestHome[] = [];

beforeEach(() => {
  fixturesDir = mkdtempSync(join(tmpdir(), "clanker-fixtures-"));
});

afterEach(() => {
  for (const home of homes.splice(0)) home.cleanup();
  rmSync(fixturesDir, { recursive: true, force: true });
});

/** Abre el core sobre el `CLANKER_HOME` como lo haría al arrancar y lista los tipos de evento. */
function eventTypesAt(home: TestHome): string[] {
  const store = openStore({ path: join(home.env.CLANKER_HOME, "clanker.db") });
  try {
    return store.events.since(0).map((e) => e.type);
  } finally {
    store.close();
  }
}

test("seedDb arma un CLANKER_HOME con la base del escenario", () => {
  const home = seedDb("loop-running");
  homes.push(home);

  expect(home.env).toEqual({ CLANKER_HOME: home.path });
  expect(eventTypesAt(home)).toEqual(["run.started", "step.started"]);
});

test("seedDb deja un solo archivo, sin -wal ni -shm", () => {
  const home = seedDb("issue-blocked");
  homes.push(home);

  expect(readdirSync(home.path)).toEqual(["clanker.db"]);
});

test("cada seedDb es independiente", () => {
  const a = seedDb("empty");
  const b = seedDb("empty");
  homes.push(a, b);

  expect(a.path).not.toBe(b.path);
});

test("el core arranca con una fixture cargada vía CLANKER_HOME", () => {
  const fixture = writeFixture("issue-blocked", fixturesDir);
  const home = loadFixture(fixture);
  homes.push(home);

  expect(eventTypesAt(home)).toEqual(["run.started", "run.blocked"]);
});

test("loadFixture trabaja sobre una copia: lo que escribe el core no cambia la fixture", () => {
  const fixture = writeFixture("empty", fixturesDir);
  const home = loadFixture(fixture);
  homes.push(home);
  const store = openStore({ path: home.dbPath });
  store.tx((tx) => tx.emit({ type: "run.started", origin: "core" }));
  store.close();

  const pristine = loadFixture(fixture);
  homes.push(pristine);
  expect(eventTypesAt(pristine)).toEqual([]);
});

test("loadFixture falla con la ruta si la fixture no existe, y no deja carpetas", () => {
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith("clanker-home-"));

  expect(() => loadFixture(join(fixturesDir, "nope.sqlite"))).toThrow(/nope\.sqlite/);

  expect(readdirSync(tmpdir()).filter((n) => n.startsWith("clanker-home-"))).toEqual(before);
});

test("writeFixture genera <escenario>.sqlite y regenerar reemplaza el anterior", () => {
  const first = writeFixture("loop-running", fixturesDir);
  const second = writeFixture("loop-running", fixturesDir);

  expect(second).toBe(join(fixturesDir, "loop-running.sqlite"));
  expect(second).toBe(first);
  expect(existsSync(second)).toBe(true);
  const home = loadFixture(second);
  homes.push(home);
  expect(eventTypesAt(home)).toEqual(["run.started", "step.started"]);
});

test.each(Object.keys(scenarios) as Scenario[])("el escenario %s se puede sembrar", (scenario) => {
  const home = seedDb(scenario);
  homes.push(home);

  expect(existsSync(home.dbPath)).toBe(true);
});
