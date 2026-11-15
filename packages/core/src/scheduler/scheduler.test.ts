import { NewProject, type CachedIssue, type ProjectId, type RunId } from "@clanker/api";
import { afterEach, describe, expect, test, vi } from "vitest";
import { harness as createHarness, type HarnessHome } from "../flows/harness";
import { createProjects } from "../projects/projects";
import { createRunStarter } from "../projects/start-run";
import { createIssues } from "../tracker/issues";
import { createLocalTracker } from "../tracker/local";
import type { Tracker } from "../tracker/tracker";
import { createRepos } from "../workspaces/repos";
import { createLaneSettings } from "./lanes";
import { createProjectQueue } from "./project-queue";
import { createScheduler, SCHEDULER_TICK_MS, type Breakers } from "./scheduler";

/** `vi.waitFor` con holgura: la suite entera corre en paralelo y un tick puede tardar más de 1 s. */
const until = (check: () => unknown) => vi.waitFor(check, { timeout: 10_000 });

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Options {
  parallel?: number;
  lanes?: Partial<{ dev: number; maintenance: number }>;
  breakers?: Breakers;
  claim?: Tracker["claim"];
  reopen?: HarnessHome;
}

/**
 * El Scheduler sobre el motor de flujos real, un tracker local y acciones que esperan a que el test las suelte.
 * Cada issue corre `dev`: `check` estaciona (gate) las issues de `parkFirst` y `work` espera a `release`.
 */
function setup({ parallel = 1, lanes: initial, breakers, claim, reopen }: Options = {}) {
  const h = createHarness({ persist: true, reopen, laneCapacity: () => lanes.capacity() });
  cleanups.push(h.cleanup);
  const lanes = createLaneSettings(h.store);
  if (initial) lanes.set(initial);

  const parkFirst = new Set<string>();
  const open = new Map<string, () => void>();
  cleanups.push(() => [...open.values()].forEach((release) => release()));
  h.action("check", ["ok", "gate"], (_args, ctx) => ({ outcome: parkFirst.has(h.flows.getRun(ctx.runId).subject.id) ? "gate" : "ok" }));
  h.action("work", ["ok"], async (_args, ctx) => {
    await new Promise<void>((resolve) => open.set(ctx.runId, resolve));
    return { outcome: "ok" };
  });
  h.save({
    schema: 1,
    id: "dev",
    name: "Dev",
    trigger: { type: "issue.queued" },
    start: "check",
    nodes: {
      check: { type: "action", action: "check", args: {}, on: { ok: "work", gate: "ask" } },
      ask: { type: "gate", question: "¿Sigo?", options: [{ id: "go", label: "Seguir" }], on: { go: "work" } },
      work: { type: "action", action: "work", args: {}, on: { ok: "@done" } },
    },
  });
  h.save({
    schema: 1,
    id: "rebase",
    name: "Rebase",
    trigger: { type: "pr.conflict" },
    start: "work",
    nodes: { work: { type: "action", action: "work", args: {}, on: { ok: "@done" } } },
  });

  const local = createLocalTracker(h.store);
  const tracker: Tracker = claim ? { ...local, claim } : local;
  const trackers = { local: tracker };
  const issues = createIssues(h.store, local);
  const projects = createProjects(h.store, h.defs);
  const repos = createRepos(h.store);
  const queue = createProjectQueue({ store: h.store, projects, issues, repos, trackers, prs: { get: () => Promise.reject(new Error("no se esperaba leer un PR")) } });
  const scheduler = createScheduler({
    store: h.store,
    projects,
    issues,
    trackers,
    flows: h.flows,
    runs: createRunStarter({ store: h.store, defs: h.defs, projects, repos, issues, flows: h.flows, trackers }),
    queue,
    lanes,
    runtime: "fake",
    breakers,
  });
  cleanups.push(() => scheduler.close());

  const project =
    projects.list()[0] ?? projects.create(NewProject.parse({ slug: "demo", name: "Demo", tracker: "local", parallel, defaultFlowId: "dev" }), "cli");
  const projectId: ProjectId = project.id;
  const create = (title: string, priority: 1 | 2 | 3 | 4 = 3): Promise<CachedIssue> => issues.createLocal({ projectId, title, priority }, "cli");
  const runOf = (issue: CachedIssue) => h.flows.listRuns({ projectId }).find((run) => run.subject.id === issue.id);
  const status = (issue: CachedIssue) => runOf(issue)?.status;
  const finish = (issue: CachedIssue) => open.get(runOf(issue)!.id)?.();
  const abandon = () => open.clear();
  const events = (type: "issue.claimed" | "issue.skipped") => h.store.events.since(0, { types: [type] });
  const resolveGate = (issue: CachedIssue) => h.flows.resolveGate(h.decisions.list({ runId: runOf(issue)!.id, status: ["pending"] })[0]!.id, "go", "ui");
  /** Espera a que la corrida de la issue esté en `work`, esperando que el test la suelte. */
  const working = (issue: CachedIssue) => until(() => expect(open.has(runOf(issue)?.id as RunId)).toBe(true));
  return { ...h, lanes, parkFirst, issues, projects, projectId, scheduler, create, runOf, status, finish, abandon, events, resolveGate, working, local };
}

describe("lanzar issues por carril", () => {
  test("lanza las issues ready en el orden de la cola hasta llenar el parallel del proyecto", async () => {
    const h = setup({ parallel: 2 });
    const low = await h.create("baja", 4);
    const urgent = await h.create("urgente", 1);
    const normal = await h.create("normal", 3);

    await h.scheduler.tick();

    expect([urgent, normal, low].map(h.status)).toEqual(["running", "running", undefined]);
    expect(h.events("issue.claimed").map((e) => e.payload.issueId)).toEqual([urgent.id, normal.id]);
    // La que no cupo sigue ready en la cola y se lanza cuando se libera un cupo, sin que nadie apriete nada.
    expect((await h.scheduler.queue.of(h.projectId)).map((e) => [e.issue.title, e.state])).toEqual([["baja", "ready"]]);
    h.scheduler.start();
    await h.working(urgent);
    h.finish(urgent);
    await until(() => expect(h.status(low)).toBe("running"));
  });

  test("trae del tracker lo que cambió antes de leer la cola", async () => {
    const h = setup({ parallel: 1 });
    // La issue entra al tracker sin pasar por el caché: nadie sincronizó.
    await h.local.createIssue(h.projectId, { title: "nueva en el tracker" });
    expect(await h.scheduler.queue.of(h.projectId)).toEqual([]);

    await h.scheduler.tick();

    expect(h.flows.listRuns({ projectId: h.projectId })).toHaveLength(1);
  });

  test("dev lleno y llega un rebase: corre en mantenimiento sin esperar al dev", async () => {
    const h = setup({ parallel: 1 });
    const dev = await h.create("dev");
    await h.scheduler.tick();
    expect(h.status(dev)).toBe("running");

    const rebase = h.flows.start("rebase", { type: "pr", id: "pr_1" });
    await h.scheduler.tick();

    expect(h.flows.getRun(rebase).status).toBe("running");
    expect(h.status(dev)).toBe("running");
  });

  test("un claim fallido no lanza la corrida, deja el motivo y sigue con la siguiente", async () => {
    const taken: { id?: string } = {};
    const h = setup({
      parallel: 1,
      claim: (ref) => (ref.id === taken.id ? Promise.reject(new Error(`La issue ${ref.key} ya está asignada a otra persona`)) : Promise.resolve()),
    });
    const first = await h.create("primera", 1);
    const second = await h.create("segunda", 2);
    taken.id = first.ref.id;

    await h.scheduler.tick();

    expect(h.status(first)).toBeUndefined();
    expect(h.status(second)).toBe("running");
    expect(h.events("issue.skipped")).toMatchObject([{ projectId: h.projectId, subject: { type: "issue", id: first.id }, payload: { issueId: first.id, reason: expect.stringContaining("ya está asignada a otra persona") } }]);
    expect(await h.scheduler.queue.of(h.projectId)).toMatchObject([{ issue: { id: first.id }, state: "waiting", reason: expect.stringContaining("ya está asignada") }]);

    // El mismo motivo no se vuelve a avisar en cada tick.
    await h.scheduler.tick();
    expect(h.events("issue.skipped")).toHaveLength(1);
  });

  test("una corrida estacionada no cuenta en el carril: las demás issues siguen", async () => {
    const h = setup({ parallel: 1 });
    const parked = await h.create("estacionada", 1);
    const next = await h.create("siguiente", 2);
    h.parkFirst.add(parked.id);
    h.scheduler.start();

    await until(() => expect(h.status(parked)).toBe("parked"));
    await until(() => expect(h.status(next)).toBe("running"));
  });

  test("una reencolada parte antes que una nueva", async () => {
    const h = setup({ parallel: 1 });
    const parked = await h.create("estacionada", 1);
    const running = await h.create("en curso", 2);
    const fresh = await h.create("nueva", 3);
    h.parkFirst.add(parked.id);
    h.scheduler.start();
    await until(() => expect(h.status(parked)).toBe("parked"));
    await h.working(running);

    // La decisión se resuelve con el cupo ocupado: la corrida espera, y la nueva no se le adelanta.
    h.resolveGate(parked);
    await h.scheduler.tick();
    expect([h.status(parked), h.status(fresh)]).toEqual(["parked", undefined]);

    h.finish(running);
    await until(() => expect(h.status(parked)).toBe("running"));
    await h.scheduler.tick();
    expect(h.status(fresh)).toBeUndefined();

    await h.working(parked);
    h.finish(parked);
    await until(() => expect(h.status(fresh)).toBe("running"));
  });

  test("dos issues relacionadas no corren juntas", async () => {
    const h = setup({ parallel: 2 });
    const first = await h.create("primera", 1);
    const second = await h.create("segunda", 2);
    await h.local.relate(first.ref, "related", second.ref);
    await h.issues.sync(h.local, { projectId: h.projectId, project: { tracker: "local", id: h.projectId } });
    await h.scheduler.tick();

    expect([first, second].map(h.status)).toEqual(["running", undefined]);
    expect(await h.scheduler.queue.of(h.projectId)).toMatchObject([
      { issue: { id: second.id }, state: "waiting", reason: expect.stringMatching(/relacionada con .*en vuelo/) },
    ]);

    h.scheduler.start();
    await h.working(first);
    h.finish(first);
    await until(() => expect(h.status(second)).toBe("running"));
  });

  test("una issue que bloquea a otra en vuelo tampoco se lanza", async () => {
    const h = setup({ parallel: 2 });
    const blocker = await h.create("bloqueante", 1);
    const blocked = await h.create("bloqueada", 2);
    await h.local.relate(blocker.ref, "blocks", blocked.ref);
    await h.issues.sync(h.local, { projectId: h.projectId, project: { tracker: "local", id: h.projectId } });
    // La bloqueada ya corre (a mano, o apilada sobre un PR): el bloqueante no entra a la vez.
    h.flows.start("dev", { type: "issue", id: blocked.id }, {}, { projectId: h.projectId });

    await h.scheduler.tick();

    expect(h.status(blocker)).toBeUndefined();
  });

  test("un repo o runtime en pausa no se lanza y queda con su motivo; vuelve a lanzar en el tick de 5 min", async () => {
    vi.useFakeTimers();
    const paused = new Set<string>(["runtime:fake"]);
    const h = setup({ parallel: 1, breakers: { open: (scope) => (paused.has(scope) ? "login vencido" : undefined) } });
    const issue = await h.create("a");

    h.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.status(issue)).toBeUndefined();
    expect(await h.scheduler.queue.of(h.projectId)).toMatchObject([{ state: "waiting", reason: "runtime:fake en pausa: login vencido" }]);

    paused.clear();
    await vi.advanceTimersByTimeAsync(SCHEDULER_TICK_MS);
    expect(h.status(issue)).toBe("running");
  });

  test("el breaker github no frena el lanzamiento: solo frena a quien publica", async () => {
    const h = setup({ parallel: 1, breakers: { open: (scope) => (scope === "github" ? "sin conexión" : undefined) } });
    const issue = await h.create("a");

    await h.scheduler.tick();

    expect(h.status(issue)).toBe("running");
  });

  test("al cerrarse un breaker lanza lo que esperaba sin aguardar el tick de 5 min", async () => {
    vi.useFakeTimers();
    let paused = true;
    const h = setup({ parallel: 1, breakers: { open: (scope) => (paused && scope === "runtime:fake" ? "sin cuota" : undefined) } });
    const issue = await h.create("a");
    h.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.status(issue)).toBeUndefined();

    paused = false;
    h.store.tx((tx) => tx.emit({ type: "breaker.closed", origin: "core", payload: { scope: "runtime:fake" } }));
    await vi.advanceTimersByTimeAsync(0);

    expect(h.status(issue)).toBe("running");
  });

  test("projects.skipIssue saca la issue de la cola y devolverla la deja lanzar", async () => {
    const h = setup({ parallel: 2 });
    const skipped = await h.create("saltada", 1);
    const other = await h.create("otra", 2);
    h.scheduler.skipIssue({ projectId: h.projectId, issueId: skipped.id, skipped: true }, "ui");

    await h.scheduler.tick();

    expect([skipped, other].map(h.status)).toEqual([undefined, "running"]);
    expect(await h.scheduler.queue.of(h.projectId)).toMatchObject([{ issue: { id: skipped.id }, state: "blocked", reason: expect.stringContaining("saltada a mano") }]);
    expect(h.events("issue.skipped")).toMatchObject([{ origin: "ui", payload: { issueId: skipped.id } }]);

    h.scheduler.start();
    h.scheduler.skipIssue({ projectId: h.projectId, issueId: skipped.id, skipped: false }, "ui");
    await until(() => expect(h.status(skipped)).toBe("running"));
  });

  test("skipIssue rechaza una issue que no es del proyecto", async () => {
    const h = setup();
    const other = h.projects.create(NewProject.parse({ slug: "otro", name: "Otro", tracker: "local" }), "cli");
    const issue = await h.create("a");

    expect(() => h.scheduler.skipIssue({ projectId: other.id, issueId: issue.id, skipped: true }, "ui")).toThrow(/no es del proyecto/);
  });

  test("un proyecto pausado no lanza nada", async () => {
    const h = setup({ parallel: 2 });
    const issue = await h.create("a");
    h.projects.update(h.projectId, { status: "paused" }, "ui");

    await h.scheduler.tick();

    expect(h.status(issue)).toBeUndefined();
  });

  test("tras un reinicio a mitad no lanza de más: cuenta las corridas que siguen vivas", async () => {
    const before = setup({ parallel: 2 });
    const [a, b, c] = [await before.create("a", 1), await before.create("b", 2), await before.create("c", 3)];
    await before.scheduler.tick();
    await Promise.all([before.working(a), before.working(b)]);
    expect([a, b, c].map(before.status)).toEqual(["running", "running", undefined]);
    // Un corte: lo que tenía en vuelo no vuelve a avanzar.
    void before.crash();
    before.abandon();

    const after = setup({ parallel: 2, reopen: before.home });
    expect(after.flows.recover()).toBe(2);
    await after.scheduler.tick();

    expect([a, b, c].map(after.status)).toEqual(["running", "running", undefined]);
    await Promise.all([after.working(a), after.working(b)]);
    after.scheduler.start();
    after.finish(a);
    await until(() => expect(after.status(c)).toBe("running"));
  });
});
