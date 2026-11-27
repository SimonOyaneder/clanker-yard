import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";
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

/** Un pid sigue vivo (`kill -0`). */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("procs", () => {
  test("al terminar un proceso, lo que dejó vivo en su grupo cae con él", async () => {
    store = openStore({ path: ":memory:" });
    // Como un agente que deja un daemon en segundo plano (`spring server --background`) y termina.
    const child = spawn("sh", ["-c", "sleep 60 > /dev/null & echo $!"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    children.push(child);
    let out = "";
    child.stdout!.on("data", (chunk: Buffer) => (out += chunk.toString()));
    createProcs({ store, bootId: "boot_1", killAfterMs: 100 }).track(child, { kind: "agent" });
    await new Promise((resolve) => child.once("close", resolve));
    const daemon = Number(out.trim());

    await vi.waitFor(() => expect(alive(daemon)).toBe(false), { timeout: 5_000 });
    expect(rows()).toEqual([]);
  });

  test("al terminar un proceso, un daemon que ignora SIGTERM cae con SIGKILL", async () => {
    store = openStore({ path: ":memory:" });
    const child = spawn("sh", ["-c", "sh -c 'trap \"\" TERM; sleep 60' > /dev/null & echo $!"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    children.push(child);
    let out = "";
    child.stdout!.on("data", (chunk: Buffer) => (out += chunk.toString()));
    createProcs({ store, bootId: "boot_1", killAfterMs: 100 }).track(child, { kind: "agent" });
    await new Promise((resolve) => child.once("close", resolve));
    const daemon = Number(out.trim());

    await vi.waitFor(() => expect(alive(daemon)).toBe(false), { timeout: 5_000 });
  });


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

  test("stop manda SIGTERM al grupo de lo que este core lanzó y deja procs vacío", async () => {
    store = openStore({ path: ":memory:" });
    const procs = createProcs({ store, bootId: "boot_now" });
    const child = sleeper();
    const dead = exited(child);
    procs.track(child, { kind: "agent", stepRunId: "stp_1" });

    await procs.stop(5_000);

    expect(await dead).toBe("SIGTERM");
    expect(rows()).toEqual([]);
  });

  test("stop mata con SIGKILL al que ignora SIGTERM pasado el plazo", async () => {
    store = openStore({ path: ":memory:" });
    const procs = createProcs({ store, bootId: "boot_now" });
    const stubborn = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('listo')"], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    children.push(stubborn);
    await new Promise((resolve) => stubborn.stdout!.once("data", resolve));
    const dead = exited(stubborn);
    procs.track(stubborn, { kind: "git" });

    await procs.stop(300);

    expect(await dead).toBe("SIGKILL");
    expect(rows()).toEqual([]);
  });

  test("stop no toca a un proceso que este core no lanzó", async () => {
    store = openStore({ path: ":memory:" });
    const stranger = sleeper();
    const mine = sleeper();
    const procs = createProcs({ store, bootId: "boot_now" });
    procs.track(mine, { kind: "recipe" });

    await procs.stop(5_000);

    expect(() => process.kill(stranger.pid!, 0)).not.toThrow();
  });
});
