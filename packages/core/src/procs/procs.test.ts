import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import { procs as procsTable } from "../store/schema";
import { openStore, type Store } from "../store/store";
import { createProcs } from "./procs";

// Procesos de verdad: lo que se prueba es que el SO los vea vivos o muertos.

const children: ChildProcess[] = [];
let store: Store | undefined;

afterEach(() => {
  for (const child of children.splice(0)) if (child.pid) tryKill(child.pid);
  store?.close();
  store = undefined;
});

function tryKill(pgid: number) {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // Ya terminó.
  }
}

function sleeper(): ChildProcess {
  const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  children.push(child);
  return child;
}

const exited = (child: ChildProcess) =>
  new Promise<NodeJS.Signals | null>((resolve) => child.once("exit", (_code, signal) => resolve(signal)));

const rows = () => store!.db.select().from(procsTable).all();

describe("procs", () => {
  test("un core nuevo mata el grupo de procesos que dejó el anterior y borra su fila", async () => {
    store = openStore({ path: ":memory:" });
    const child = sleeper();
    const dead = exited(child);
    createProcs({ store, bootId: "boot_old" }).track(child, { kind: "recipe", stepRunId: "stp_1" });
    expect(rows()).toMatchObject([{ pid: child.pid, pgid: child.pid, bootId: "boot_old", kind: "recipe", stepRunId: "stp_1" }]);

    const killed = createProcs({ store, bootId: "boot_new" }).killOrphans();

    expect(killed).toBe(1);
    expect(await dead).toBe("SIGKILL");
    expect(rows()).toEqual([]);
  });

  test("un pid reusado por otro programa (otra hora de inicio) no se mata", () => {
    store = openStore({ path: ":memory:" });
    const stranger = sleeper();
    store.tx((tx) =>
      tx.db
        .insert(procsTable)
        .values({ pid: stranger.pid!, pgid: stranger.pid!, bootId: "boot_old", kind: "agent", startedAt: 1_000 })
        .run(),
    );

    const killed = createProcs({ store, bootId: "boot_new" }).killOrphans();

    expect(killed).toBe(0);
    expect(() => process.kill(stranger.pid!, 0)).not.toThrow();
    expect(rows()).toEqual([]);
  });

  test("un proceso de un grupo que ya terminó no es un error", () => {
    store = openStore({ path: ":memory:" });
    store.tx((tx) =>
      tx.db.insert(procsTable).values({ pid: 2 ** 22 - 1, pgid: 2 ** 22 - 1, bootId: "boot_old", kind: "git", startedAt: 1_000 }).run(),
    );

    expect(createProcs({ store, bootId: "boot_new" }).killOrphans()).toBe(0);
    expect(rows()).toEqual([]);
  });

  test("los procesos del propio boot se registran mientras viven y no se tocan", async () => {
    store = openStore({ path: ":memory:" });
    const procs = createProcs({ store, bootId: "boot_now" });
    const child = sleeper();
    procs.track(child, { kind: "agent" });

    expect(procs.killOrphans()).toBe(0);
    expect(rows()).toHaveLength(1);

    const closed = new Promise((resolve) => child.once("close", resolve));
    process.kill(-child.pid!, "SIGTERM");
    await closed;
    expect(rows()).toEqual([]);
  });
});
