import type { PayloadOf } from "@clanker/api";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDecisions } from "../decisions/decisions";
import { openStore, type Store } from "../store/store";
import { createBreakers, GITHUB_SCOPE, repoScope, runtimeScope, type Breakers } from "./breakers";

const MIN = 60_000;

let store: Store;
let probes: Array<{ scope: string; at: number }>;
let failing: Set<string>;
const open: Breakers[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  store = openStore({ path: ":memory:" });
  probes = [];
  failing = new Set();
});

afterEach(() => {
  for (const breakers of open.splice(0)) breakers.close();
  store.close();
  vi.useRealTimers();
});

function breakers(runtime = "claude-sdk", onProbe?: (scope: string) => void): Breakers {
  const created = createBreakers({
    store,
    runtimes: [runtime],
    probe: (scope) => {
      probes.push({ scope, at: Date.now() });
      onProbe?.(scope);
      return Promise.resolve(failing.has(scope) ? "sigue caído" : undefined);
    },
  });
  created.start();
  open.push(created);
  return created;
}

const events = (type: "breaker.opened" | "breaker.closed") => store.events.since(0, { types: [type] });
const alerts = () => createDecisions(store).list({ kind: ["alert"] });

describe("abrir", () => {
  test("pausa su ámbito, deja la alerta en la bandeja y emite breaker.opened", () => {
    const b = breakers();

    b.trip({ scope: repoScope("repo_a"), cause: "environment", reason: "No responde: Postgres." });

    expect(b.openReason(repoScope("repo_a"))).toBe("No responde: Postgres.");
    expect(b.openReason(repoScope("repo_b"))).toBeUndefined();
    expect(b.openReason(GITHUB_SCOPE)).toBeUndefined();
    expect(events("breaker.opened")[0]?.payload).toMatchObject({ scope: "repo:repo_a", cause: "environment", retryAt: Date.now() + MIN });
    expect(alerts()).toMatchObject([{ status: "pending", title: "Pausado: repo:repo_a", body: expect.stringContaining("No responde: Postgres.") }]);
  });

  test("abrir uno ya abierto no repite la alerta ni reinicia el backoff", async () => {
    failing.add(repoScope("repo_a"));
    const b = breakers();
    b.trip({ scope: repoScope("repo_a"), cause: "environment", reason: "uno" });
    await vi.advanceTimersByTimeAsync(MIN);

    b.trip({ scope: repoScope("repo_a"), cause: "environment", reason: "dos" });

    expect(events("breaker.opened")).toHaveLength(1);
    expect(alerts()).toHaveLength(1);
    expect(b.list()[0]).toMatchObject({ probes: 1, reason: "sigue caído" });
  });
});

describe("backoff y cierre", () => {
  test("prueba al minuto, a los 5, 15 y 30 minutos y después cada 30, y se cierra solo cuando pasa", async () => {
    failing.add(runtimeScope("claude-sdk"));
    const b = breakers();
    const start = Date.now();
    b.trip({ scope: runtimeScope("claude-sdk"), cause: "login_expired", reason: "login vencido" });

    await vi.advanceTimersByTimeAsync(2 * 60 * MIN);

    expect(probes.map((p) => (p.at - start) / MIN)).toEqual([1, 6, 21, 51, 81, 111]);
    expect(b.openReason(runtimeScope("claude-sdk"))).toBeDefined();

    failing.clear();
    await vi.advanceTimersByTimeAsync(30 * MIN);

    expect(b.openReason(runtimeScope("claude-sdk"))).toBeUndefined();
    expect(events("breaker.closed")).toHaveLength(1);
    expect(events("breaker.closed")[0]?.payload).toMatchObject({ scope: "runtime:claude-sdk", cause: "login_expired", probes: 6 });
    expect(alerts()).toMatchObject([{ status: "superseded" }]);
    // Cerrado: no sigue probando.
    const after = probes.length;
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(probes).toHaveLength(after);
  });

  test("backoffMs acorta las pruebas: la última se repite", async () => {
    failing.add(repoScope("repo_a"));
    const created = createBreakers({
      store,
      runtimes: ["fake"],
      backoffMs: [100, 300],
      probe: (scope) => {
        probes.push({ scope, at: Date.now() });
        return Promise.resolve(failing.has(scope) ? "sigue caído" : undefined);
      },
    });
    created.start();
    open.push(created);
    const start = Date.now();
    created.trip({ scope: repoScope("repo_a"), cause: "environment", reason: "No responde: Postgres." });

    await vi.advanceTimersByTimeAsync(1000);

    expect(probes.map((p) => p.at - start)).toEqual([100, 400, 700, 1000]);
  });

  test("con la hora del reset de la cuota, la primera prueba es ahí y no antes", async () => {
    const b = breakers();
    const resetsAt = Date.now() + 90 * MIN;
    b.trip({ scope: runtimeScope("claude-sdk"), cause: "quota_exhausted", reason: "sin cuota", resetsAt });

    await vi.advanceTimersByTimeAsync(89 * MIN);
    expect(probes).toEqual([]);
    expect(b.openReason(runtimeScope("claude-sdk"))).toBeDefined();

    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(probes.map((p) => p.at)).toEqual([resetsAt]);
    expect(b.openReason(runtimeScope("claude-sdk"))).toBeUndefined();
  });

  test("una prueba que lanza cuenta como fallida y sigue el backoff", async () => {
    const created = createBreakers({ store, runtimes: ["fake"], probe: () => Promise.reject(new Error("pg_isready no existe")) });
    created.start();
    open.push(created);
    created.trip({ scope: repoScope("repo_a"), cause: "environment", reason: "caído" });

    await vi.advanceTimersByTimeAsync(MIN);

    expect(created.list()[0]).toMatchObject({ probes: 1, reason: "pg_isready no existe" });
  });
});

describe("eventos de conexión y cuota", () => {
  const emit = <T extends "connection.changed" | "sync.rate_limited">(type: T, payload: PayloadOf<T>) =>
    store.tx((tx) => tx.emit<T>({ type, origin: "core", payload }));

  test("sync.rate_limited abre github hasta el reset de GitHub", async () => {
    const b = breakers();
    const resetAt = Date.now() + 20 * MIN;

    emit("sync.rate_limited", { provider: "github", account: "simon", resetAt });
    await vi.advanceTimersByTimeAsync(19 * MIN);

    expect(b.openReason(GITHUB_SCOPE)).toBeDefined();
    expect(probes).toEqual([]);

    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(b.openReason(GITHUB_SCOPE)).toBeUndefined();
    expect(events("breaker.opened")[0]?.payload).toMatchObject({ scope: "github", cause: "rate_limited" });
  });

  test("una conexión revocada abre su ámbito, y reconectarla prueba ya y lo cierra sin esperar al backoff", async () => {
    failing.add(GITHUB_SCOPE);
    const b = breakers();

    emit("connection.changed", { provider: "github", account: "simon", status: "revoked" });
    expect(b.openReason(GITHUB_SCOPE)).toContain("simon");
    expect(events("breaker.opened")[0]?.payload).toMatchObject({ cause: "connection_lost" });

    // Reconectó pero la prueba todavía falla (un token sin permisos): sigue abierto.
    emit("connection.changed", { provider: "github", account: "simon", status: "active" });
    await vi.advanceTimersByTimeAsync(0);
    expect(b.openReason(GITHUB_SCOPE)).toBeDefined();

    failing.clear();
    emit("connection.changed", { provider: "github", account: "simon", status: "active" });
    await vi.advanceTimersByTimeAsync(0);
    expect(b.openReason(GITHUB_SCOPE)).toBeUndefined();
  });

  test("lo que emite la propia prueba (testClaude reescribe la conexión) no la dispara de nuevo", async () => {
    let runs = 0;
    const b = breakers("claude-sdk", () => {
      runs++;
      emit("connection.changed", { provider: "claude", account: "subscription", status: "active" });
    });
    emit("connection.changed", { provider: "claude", account: "subscription", status: "expired" });

    emit("connection.changed", { provider: "claude", account: "subscription", status: "active" });
    await vi.advanceTimersByTimeAsync(0);

    expect(runs).toBe(1);
    expect(b.openReason(runtimeScope("claude-sdk"))).toBeUndefined();
  });

  test("la conexión de Claude solo pausa al runtime claude-sdk, y Linear no abre ninguno", () => {
    const fake = breakers("fake");

    emit("connection.changed", { provider: "claude", account: "subscription", status: "expired" });
    emit("connection.changed", { provider: "linear", account: "acme", status: "revoked" });

    expect(fake.list()).toEqual([]);
  });
});

test("un corte no pierde los breakers: el core que arranca los retoma, sigue su backoff y los cierra", async () => {
  const first = breakers();
  first.trip({ scope: repoScope("repo_a"), cause: "environment", reason: "Postgres caído" });
  first.close();

  const second = breakers();

  expect(second.openReason(repoScope("repo_a"))).toBe("Postgres caído");
  expect(second.list()[0]?.decisionId).toBe(first.list()[0]?.decisionId);
  await vi.advanceTimersByTimeAsync(MIN);
  expect(second.openReason(repoScope("repo_a"))).toBeUndefined();
  expect(alerts()).toMatchObject([{ status: "superseded" }]);
});
