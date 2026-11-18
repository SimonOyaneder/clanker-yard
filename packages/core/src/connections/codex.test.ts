import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { RateLimitSnapshot } from "../agents/codex/api";
import { createFileSecrets } from "../secrets/encrypted-file";
import { openStore, type Store } from "../store/store";
import { createFakeCodex, type FakeCodexOptions } from "../testing/codex/fake-codex";
import { createConnections } from "./connections";
import { UiOnlyError } from "../errors/domain";

vi.setConfig({ testTimeout: 20_000 });

let dir: string;
let store: Store;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "connections-codex-"));
  store = openStore({ path: join(dir, "clanker.db") });
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

async function withCodex(options: FakeCodexOptions = {}) {
  const fake = await createFakeCodex(dir, options);
  const secrets = createFileSecrets({ dir: join(dir, "secrets") });
  return createConnections({
    store, secrets,
    codex: { cwd: dir, executable: fake.executable, args: fake.args, baseEnv: { PATH: process.env.PATH, HOME: dir } },
  });
}

const limits: RateLimitSnapshot = {
  limitId: "codex",
  primary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: 1795542935 },
  secondary: null, credits: null, spendControlReached: null,
};
const usageEvents = () => store.events.since(0, { types: ["connection.usage"] });

test("conecta la suscripción sin secreto, rechaza tokens y desconecta sin cerrar el login del binario", async () => {
  const connections = await withCodex();
  expect(connections.codexStatus()).toBeUndefined();
  const status = await connections.testCodex("ui");
  expect(status.state).toBe("ready");
  expect(connections.list()).toEqual([{
    provider: "codex", account: "subscription", status: "active", scopes: ["plan:self_serve_business_prolite"],
  }]);
  expect(store.db.$client.prepare("SELECT secret_ref FROM connections").get()).toEqual({ secret_ref: "" });
  expect(await readdir(dir)).not.toContain("secrets");
  await expect(connections.token("codex", "subscription")).rejects.toThrow(/no guarda ningún token/);
  await expect(connections.connect({ provider: "codex", account: "subscription", token: "no", scopes: [] }, "ui")).rejects.toThrow(/testCodex/);
  await expect(connections.disconnect("codex", "subscription", "mcp")).rejects.toThrow(UiOnlyError);
  await connections.disconnect("codex", "subscription", "ui");
  expect(connections.list()).toEqual([]);
  expect((await connections.testCodex("ui")).state).toBe("ready");
  expect(usageEvents()).toHaveLength(1);
});

test("login ausente no crea cuenta y el login perdido expira solo la cuenta existente", async () => {
  const missing = await withCodex({ scenario: "login_expired" });
  expect((await missing.testCodex("ui")).state).toBe("login_required");
  missing.markCodexLoginLost("core");
  expect(missing.list()).toEqual([]);
  let connected = await withCodex();
  await connected.testCodex("ui");
  const loggedOut = await withCodex({ scenario: "login_expired" });
  expect((await loggedOut.testCodex("ui")).state).toBe("login_required");
  expect(loggedOut.list()).toMatchObject([{ provider: "codex", status: "expired" }]);
  connected = await withCodex();
  await connected.testCodex("ui");
  connected.updateCodexUsage({ ...limits, rateLimitReachedType: "rate_limit_reached", primary: { ...limits.primary!, usedPercent: 100 } });
  expect(connected.codexStatus()?.state).toBe("quota_exhausted");
  connected.markCodexLoginLost("core");
  expect(connected.list()).toMatchObject([{ provider: "codex", status: "expired" }]);
  expect(connected.codexStatus()).toMatchObject({ state: "login_expired" });
  expect(connected.codexStatus()).not.toHaveProperty("resetsAt");
  const events = store.events.since(0, { types: ["connection.changed"] });
  connected.markCodexLoginLost("core");
  expect(store.events.since(0, { types: ["connection.changed"] })).toEqual(events);
  expect(store.events.since(0, { types: ["connection.changed"] }).at(-1)).toMatchObject({
    origin: "core", payload: { provider: "codex", account: "subscription", status: "expired" },
  });
});

test("quota_exhausted conecta una cuenta activa y una notificación parcial no recupera el permiso ordinario", async () => {
  const connections = await withCodex({ scenario: "quota_exhausted" });
  expect((await connections.testCodex("ui")).state).toBe("quota_exhausted");
  expect(connections.list()).toMatchObject([{ status: "active" }]);
  connections.updateCodexUsage(limits);
  expect(connections.codexStatus()).toMatchObject({ state: "quota_exhausted", usage: { windows: [{ usedPercent: 4 }] } });
  const ready = await withCodex();
  expect((await ready.testCodex("ui")).state).toBe("ready");
});

test("persiste el snapshot, conserva buckets y no repite eventos al recibir los mismos datos tras reiniciar", async () => {
  let connections = await withCodex();
  const first = await connections.testCodex("ui");
  connections.updateCodexUsage(limits);
  expect(usageEvents()).toHaveLength(1);
  expect(usageEvents()[0]).toMatchObject({ origin: "ui", payload: { provider: "codex" } });
  connections.updateCodexUsage({ ...limits, limitId: "otro", primary: { ...limits.primary!, usedPercent: 30 } });
  connections.updateCodexUsage({ ...limits, primary: { ...limits.primary!, usedPercent: 10 } });
  expect(connections.codexStatus()?.usage?.windows.map((w) => [w.id, w.usedPercent])).toEqual([["codex:primary", 10], ["otro:primary", 30]]);
  const saved = connections.codexStatus();
  const count = usageEvents().length;
  store.close();
  store = openStore({ path: join(dir, "clanker.db") });
  connections = await withCodex();
  expect(connections.codexStatus()).toEqual(saved);
  connections.updateCodexUsage({ ...limits, primary: { ...limits.primary!, usedPercent: 10 } });
  expect(usageEvents()).toHaveLength(count);
  expect(saved).toMatchObject({ plan: first.plan, version: first.version });
});

test("actualiza el bucket codex sin limitId y emite uso una sola vez por cambio", async () => {
  const canonical = { ...limits, limitId: null };
  const connections = await withCodex({
    rateLimits: canonical, rateLimitsByLimitId: { codex: canonical },
  });
  await connections.testCodex("ui");
  const count = usageEvents().length;
  const update = { ...canonical, primary: { ...canonical.primary!, usedPercent: 30 } };
  connections.updateCodexUsage(update);
  expect(connections.codexStatus()?.usage?.windows).toMatchObject([{ id: "codex:primary", usedPercent: 30 }]);
  expect(usageEvents()).toHaveLength(count + 1);
  expect(usageEvents().at(-1)).toMatchObject({
    origin: "core", payload: { provider: "codex" },
  });
  connections.updateCodexUsage(update);
  expect(usageEvents()).toHaveLength(count + 1);
});

test("un error de instalación no conecta ni cambia una cuenta ya conectada", async () => {
  const connections = await withCodex();
  await connections.testCodex("ui");
  const broken = createConnections({
    store, secrets: createFileSecrets({ dir: join(dir, "secrets") }), codex: { executable: join(dir, "missing") },
  });
  expect((await broken.testCodex("ui")).state).toBe("not_installed");
  expect(broken.list()).toEqual(connections.list());
  expect(broken.codexStatus()?.state).toBe("not_installed");
});
