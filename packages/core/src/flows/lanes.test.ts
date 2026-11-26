import { NewProject, type RunId, type SubjectRef } from "@clanker/api";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createProjects } from "../projects/projects";
import { harness as createHarness } from "../testing/flows-harness";
import type { LaneCapacity } from "./lanes";

/** `vi.waitFor` con holgura: la suite entera corre en paralelo y un tick puede tardar más de 1 s. */
const until = (check: () => unknown) => vi.waitFor(check, { timeout: 10_000 });

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const issue = (n: number): SubjectRef => ({ type: "issue", id: `BA-${n}` });
const pr = (n: number): SubjectRef => ({ type: "pr", id: `pr_${n}` });

/** Una acción que no termina hasta que el test suelta a esa corrida. */
function gates() {
  const open = new Map<string, () => void>();
  return {
    wait: (key: string) => new Promise<void>((resolve) => open.set(key, resolve)),
    release: (key: string) => open.get(key)?.(),
    started: () => [...open.keys()],
  };
}

function setup(initial: LaneCapacity) {
  const capacity = { ...initial };
  const h = createHarness({ laneCapacity: () => capacity });
  cleanups.push(h.cleanup);
  const work = gates();
  cleanups.push(() => work.started().forEach(work.release));
  h.action("work", ["ok"], async (_args, ctx) => {
    await work.wait(ctx.runId);
    return { outcome: "ok" };
  });
  h.action("after", ["ok"]);
  const flow = (id: string, trigger: string, nodes: object, start = "work") =>
    h.save({ schema: 1, id, name: id, trigger: { type: trigger }, start, nodes });
  const workNode = { work: { type: "action", action: "work", args: {}, on: { ok: "@done" } } };
  flow("dev", "manual", workNode);
  flow("rebase", "pr.conflict", workNode);
  // Un gate antes del trabajo: la corrida se estaciona sin cupo y al resolverla vuelve a pedirlo.
  flow(
    "dev-gated",
    "manual",
    {
      ask: { type: "gate", question: "¿Sigo?", options: [{ id: "go", label: "Seguir" }], on: { go: "work" } },
      ...workNode,
    },
    "ask",
  );
  const projects = createProjects({ store: h.store, defs: h.defs });
  const project = projects.create(NewProject.parse({ slug: "demo", name: "Demo", tracker: "local", parallel: 1 }), "cli");
  const startDev = (flowId: string, n: number) => h.flows.start(flowId, issue(n), {}, { profile: "default", projectId: project.id });
  const status = (id: RunId) => h.flows.getRun(id).status;
  const requeued = (id: RunId) => h.store.events.since(0, { runId: id, types: ["run.requeued"] });
  const decisionOf = (id: RunId) => h.decisions.list({ runId: id, status: ["pending"] })[0]!;
  return { ...h, capacity, work, projects, project, startDev, status, requeued, decisionOf };
}

describe("cupos por carril", () => {
  test("dev lleno y llega un rebase: corre en mantenimiento sin esperar", async () => {
    const h = setup({ dev: 1, maintenance: 1 });
    const dev = h.startDev("dev", 1);
    const blocked = h.startDev("dev", 2);
    expect([h.status(dev), h.status(blocked)]).toEqual(["running", "queued"]);

    const rebase = h.flows.start("rebase", pr(1));
    expect(h.status(rebase)).toBe("running");
    await until(() => expect(h.work.started()).toContain(rebase));

    h.work.release(rebase);
    await h.finished(rebase);
    expect(h.status(rebase)).toBe("done");
    // El dev que estaba en curso ni se enteró, y el que esperaba sigue esperando su cupo.
    expect([h.status(dev), h.status(blocked)]).toEqual(["running", "queued"]);
  });

  test("mantenimiento tiene su propia capacidad: la segunda espera cupo, no a una corrida de dev", async () => {
    const h = setup({ dev: 1, maintenance: 1 });
    const first = h.flows.start("rebase", pr(1));
    const second = h.flows.start("rebase", pr(2));
    expect([h.status(first), h.status(second)]).toEqual(["running", "queued"]);

    await until(() => expect(h.work.started()).toContain(first));
    h.work.release(first);
    await until(() => expect(h.status(second)).toBe("running"));
    h.work.release(second);
    await h.finished(second);
    expect(h.status(second)).toBe("done");
  });

  test("pausar mantenimiento solo detiene la admisión en ese proyecto; al reanudar sigue su cola aunque dev esté pausado", async () => {
    const h = setup({ dev: 1, maintenance: 2 });
    const projectId = h.project.id;
    const other = h.projects.create(NewProject.parse({ slug: "otro", name: "Otro", tracker: "local" }), "ui");
    const active = h.flows.start("rebase", pr(1), {}, { projectId });
    await until(() => expect(h.work.started()).toContain(active));
    h.projects.update(projectId, { maintenancePaused: true }, "ui");
    const pending = h.flows.start("rebase", pr(2), {}, { projectId });
    const otherRebase = h.flows.start("rebase", pr(3), {}, { projectId: other.id });
    const dev = h.startDev("dev", 1);
    expect([active, pending, otherRebase, dev].map(h.status)).toEqual(["running", "queued", "running", "running"]);
    h.work.release(active);
    await h.finished(active);
    h.flows.wake();
    expect(h.status(pending)).toBe("queued");
    h.projects.pause(projectId, "ui");
    expect(h.projects.get(projectId)?.maintenancePaused).toBe(true);
    h.projects.update(projectId, { maintenancePaused: false }, "ui");
    h.flows.wake();
    await until(() => expect(h.work.started()).toContain(pending));
    expect(h.projects.get(projectId)?.status).toBe("paused");
  });

  test("dev respeta el parallel del proyecto y el tope global de la máquina", async () => {
    const h = setup({ dev: 2, maintenance: 1 });
    const first = h.startDev("dev", 1);
    // parallel 1: la segunda del mismo proyecto espera aunque la máquina tenga cupo.
    expect(h.status(h.startDev("dev", 2))).toBe("queued");
    // Una corrida sin proyecto solo mira el tope de la máquina.
    expect(h.status(h.flows.start("dev", issue(3), {}, { profile: "default" }))).toBe("running");
    // Y con la máquina llena tampoco entra.
    expect(h.status(h.flows.start("dev", issue(4), {}, { profile: "default" }))).toBe("queued");
    expect(h.status(first)).toBe("running");
  });

  test("subir la capacidad admite a las que esperaban", async () => {
    const h = setup({ dev: 1, maintenance: 1 });
    h.flows.start("dev", issue(1));
    const waiting = h.flows.start("dev", issue(2));
    expect(h.status(waiting)).toBe("queued");

    h.capacity.dev = 2;
    h.flows.wake();

    expect(h.status(waiting)).toBe("running");
  });

  test("una corrida estacionada no cuenta en ningún carril", async () => {
    const h = setup({ dev: 1, maintenance: 1 });
    const parked = h.startDev("dev-gated", 1);
    await h.finished(parked);
    expect(h.status(parked)).toBe("parked");

    const next = h.startDev("dev", 2);
    expect(h.status(next)).toBe("running");
  });

  test("una corrida que vuelve de estacionada sin cupo sigue parked, sin run.requeued, hasta que lo haya", async () => {
    const h = setup({ dev: 1, maintenance: 1 });
    const parked = h.startDev("dev-gated", 1);
    await h.finished(parked);
    const running = h.startDev("dev", 2);
    expect(h.status(running)).toBe("running");

    h.flows.resolveGate(h.decisionOf(parked).id, "go", "ui");
    expect(h.status(parked)).toBe("parked");
    expect(h.requeued(parked)).toEqual([]);
    // La decisión quedó resuelta: no hay nada pendiente que mostrarle a nadie.
    expect(h.decisions.list({ runId: parked, status: ["pending"] })).toEqual([]);

    await until(() => expect(h.work.started()).toContain(running));
    h.work.release(running);
    await until(() => expect(h.status(parked)).toBe("running"));
    expect(h.requeued(parked)).toHaveLength(1);
    await until(() => expect(h.work.started()).toContain(parked));
    h.work.release(parked);
    await until(() => expect(h.status(parked)).toBe("done"));
  });

  test("una reencolada parte antes que una nueva", async () => {
    const h = setup({ dev: 1, maintenance: 1 });
    const parked = h.startDev("dev-gated", 1);
    await h.finished(parked);
    const running = h.startDev("dev", 2);
    h.flows.resolveGate(h.decisionOf(parked).id, "go", "ui");
    // Una nueva que llegó después de que la reencolada empezó a esperar.
    const fresh = h.startDev("dev", 3);
    expect([h.status(parked), h.status(fresh)]).toEqual(["parked", "queued"]);

    await until(() => expect(h.work.started()).toContain(running));
    h.work.release(running);

    await until(() => expect(h.status(parked)).toBe("running"));
    expect(h.status(fresh)).toBe("queued");
  });

  test("cuando se libera cupo en los dos carriles, el mantenimiento se admite antes que dev", async () => {
    const h = setup({ dev: 1, maintenance: 1 });
    h.flows.start("dev", issue(1));
    h.flows.start("rebase", pr(1));
    const queuedDev = h.flows.start("dev", issue(2));
    const queuedMaintenance = h.flows.start("rebase", pr(2));
    expect([queuedDev, queuedMaintenance].map(h.status)).toEqual(["queued", "queued"]);

    h.capacity.dev = 2;
    h.capacity.maintenance = 2;
    h.flows.wake();

    expect([queuedDev, queuedMaintenance].map(h.status)).toEqual(["running", "running"]);
    const admittedAt = (id: RunId) => h.store.events.since(0, { runId: id, types: ["run.status"] })[0]!.seq;
    expect(admittedAt(queuedMaintenance)).toBeLessThan(admittedAt(queuedDev));
  });
});
