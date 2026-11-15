import { newId, createSlots, openStore, StaleLeaseError, LEASE_TTL_MS, type SlotLease, type SlotPools, type Slots, type Store } from "@clanker/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

// Los pools de slots por carril (`docs/design.html#d-ops`, "Slots globales, por carril").

const pools: SlotPools = { dev: 2, maintenance: 1 };
const repoId = "r1";

let clock: number;
let store: Store;
let slots: Slots;
let held: SlotLease[];

beforeEach(() => {
  clock = 1_000_000;
  store = openStore({ path: ":memory:", now: () => clock });
  slots = createSlots({ store, now: () => clock, retryMs: 5 });
  held = [];
});

afterEach(() => {
  for (const lease of held) slots.release(lease);
  store.close();
});

function take(lane: "dev" | "maintenance", extra: { repoId?: string; pools?: SlotPools; workspaceId?: string } = {}) {
  const lease = slots.tryAcquire({ repoId, lane, runId: newId("run"), pools, ...extra });
  if (lease) held.push(lease);
  return lease;
}

const rows = () =>
  store.db.$client
    .prepare("SELECT repo_id AS repoId, idx, reserved_for AS pool, holder_run_id AS holder, fencing_token AS token FROM slots ORDER BY repo_id, idx")
    .all() as { repoId: string; idx: number; pool: string; holder: string | null; token: number }[];

describe("pools por carril", () => {
  test("dev usa 1..N y maintenance N+1..N+M", () => {
    expect([take("dev")!.idx, take("dev")!.idx, take("maintenance")!.idx]).toEqual([1, 2, 3]);
    expect(rows().map((r) => [r.idx, r.pool])).toEqual([[1, "dev"], [2, "dev"], [3, "maintenance"]]);
  });

  test("el pool dev lleno no impide tomar uno de maintenance, y al revés", () => {
    take("dev");
    take("dev");
    expect(take("dev")).toBeUndefined();

    expect(take("maintenance")).toMatchObject({ idx: 3, lane: "maintenance" });
    expect(take("maintenance")).toBeUndefined();
  });

  test("un slot soltado vuelve a su pool con un token nuevo", () => {
    const first = take("maintenance")!;
    expect(take("maintenance")).toBeUndefined();

    slots.release(first);
    const second = take("maintenance")!;

    expect([second.idx, second.fencingToken]).toEqual([first.idx, first.fencingToken + 1]);
  });

  test("soltar con un token viejo no toca al dueño vigente", () => {
    const first = take("maintenance")!;
    clock += LEASE_TTL_MS + 1;
    const second = take("maintenance")!;

    slots.release(first);

    expect(rows().find((r) => r.idx === 3)).toMatchObject({ holder: second.runId, token: second.fencingToken });
    expect(() => slots.startSetup(first)).toThrow(StaleLeaseError);
  });

  test("un lease vencido se toma y avisa el vencimiento al dueño anterior", () => {
    const old = take("maintenance")!;
    clock += LEASE_TTL_MS + 1;

    const next = take("maintenance")!;

    expect(next.idx).toBe(old.idx);
    expect(store.events.since(0).map((e) => [e.type, e.runId])).toEqual([
      ["lease.acquired", old.runId],
      ["lease.expired", old.runId],
      ["lease.acquired", next.runId],
    ]);
  });

  test("cada repo tiene sus propios pools; dos corridas del mismo repo los comparten", () => {
    take("dev");
    take("dev");
    expect(take("dev", { repoId: "r2" })).toMatchObject({ idx: 1 });
    expect(take("dev")).toBeUndefined();
  });

  test("cambiar los tamaños de la receta reparte de nuevo los slots libres y borra los que sobran", () => {
    take("maintenance");
    slots.release(held.pop()!);

    const grown = take("maintenance", { pools: { dev: 1, maintenance: 2 } });
    expect(grown).toMatchObject({ idx: 2 });
    expect(rows().map((r) => [r.idx, r.pool])).toEqual([[1, "dev"], [2, "maintenance"], [3, "maintenance"]]);

    slots.release(held.pop()!);
    take("dev", { pools: { dev: 1, maintenance: 1 } });
    expect(rows().map((r) => r.idx)).toEqual([1, 2]);
  });
});

describe("preparación del slot", () => {
  test("se prefiere el slot que ya preparó el worktree, aunque haya otro con índice menor", () => {
    const a = take("dev")!;
    const b = take("dev")!;
    slots.finishSetup(b, { workspaceId: "ws_b", setupHash: "h", env: {} });
    slots.release(a);
    slots.release(b);

    const again = take("dev", { workspaceId: "ws_b" })!;

    expect(again).toMatchObject({ idx: b.idx, workspaceId: "ws_b", setupHash: "h", dirty: false });
  });

  test("startSetup deja el slot sucio hasta finishSetup", () => {
    const lease = take("maintenance")!;

    slots.startSetup(lease);
    slots.release(lease);
    const cut = take("maintenance")!;
    expect(cut.dirty).toBe(true);

    slots.finishSetup(cut, { workspaceId: "ws_x", setupHash: "h1", env: { DB: "db_3" } });
    slots.release(cut);
    expect(take("maintenance")).toMatchObject({ dirty: false, workspaceId: "ws_x", setupHash: "h1" });
    expect(store.db.$client.prepare("SELECT env FROM slots WHERE idx = 3").get()).toEqual({ env: '{"DB":"db_3"}' });
  });
});

describe("acquire espera", () => {
  test("acquire espera a que se libere un slot de su pool", async () => {
    const first = take("maintenance")!;
    const waiting = slots.acquire({ repoId, lane: "maintenance", runId: newId("run"), pools });
    await new Promise((resolve) => setTimeout(resolve, 20));

    slots.release(first);
    const lease = await waiting;
    held.push(lease);

    expect(lease.idx).toBe(first.idx);
  });

  test("abortar la señal lanza su razón", async () => {
    take("maintenance");
    const controller = new AbortController();
    const waiting = slots.acquire({ repoId, lane: "maintenance", runId: newId("run"), pools }, controller.signal);

    controller.abort(new Error("timeout del paso"));

    await expect(waiting).rejects.toThrow("timeout del paso");
  });
});

describe("recover", () => {
  test("al bootear se sueltan todos los slots con dueño y se avisa de cada uno", () => {
    const a = take("dev")!;
    const b = take("maintenance")!;

    const rebooted = createSlots({ store, now: () => clock });
    expect(rebooted.recover()).toBe(2);

    expect(rows().map((r) => r.holder)).toEqual([null, null, null]);
    expect(store.events.since(0).filter((e) => e.type === "lease.expired").map((e) => e.runId).sort()).toEqual([a.runId, b.runId].sort());
    expect(rebooted.recover()).toBe(0);
    expect(rebooted.tryAcquire({ repoId, lane: "maintenance", runId: newId("run"), pools })).toMatchObject({ idx: 3, fencingToken: b.fencingToken + 1 });
  });

  test("extendLeases renueva los slots que este core tiene", () => {
    const lease = take("maintenance")!;
    clock += LEASE_TTL_MS - 1;

    slots.extendLeases();
    clock += 10;

    expect(take("maintenance")).toBeUndefined();
    expect(lease.lost.aborted).toBe(false);
  });
});
