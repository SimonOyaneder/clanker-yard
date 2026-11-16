import { spawn, type ChildProcess } from "node:child_process";
import { createProcs, openStore } from "@clanker/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { startNightScenario, type NightScenario } from "./night-scenario";

// El criterio de la fase 2 (`docs/design.html#fases`): "un proyecto corre toda la noche sin detenerse, un rebase no
// espera a la issue en curso y un corte se retoma solo". Cinco issues de Linear (dos apiladas) pasan por el core
// real con el Scheduler y Watch encendidos, el runtime fake, el GitHub simulado, un remoto git real y un reloj
// falso que corre unas 25 veces más rápido (`night-scenario.ts`). Sin ningún LLM ni sleeps reales largos.

vi.setConfig({ testTimeout: 150_000 });

let scene: NightScenario | undefined;
let orphan: ChildProcess | undefined;
afterEach(async () => {
  orphan?.kill("SIGKILL");
  orphan = undefined;
  await scene?.cleanup();
  scene = undefined;
});

const SHARED_ON_MAIN = 'export const shared = { owner: "base", value: 2 };\n';

describe("la noche", () => {
  test("cinco issues, un merge, un conflicto, un council, un breaker, una decisión y un corte", async () => {
    const night = (scene = await startNightScenario());
    const { github, holds } = night;
    const projectId = night.project.id;
    const sql = <T>(query: string, ...args: string[]) => night.store.db.$client.prepare(query).all(...args) as T[];
    const commentsOf = (pr: { number: number }) => github.pr(pr.number).node().comments.map((c) => c.body.split("\n")[0]);
    const issueOf = async (key: string) => (await night.client.issues.list({ projectId })).find((i) => i.ref.key === key)!;
    /** El PR de la issue `key`: su branch es el `branch` de la corrida. */
    const prOf = async (key: string) => {
      const { params } = await runOf(key);
      return github.pulls().find((p) => p.head.ref === params.branch)!;
    };
    /** La corrida raíz de dev de la issue `key`. */
    const runOf = async (key: string) => {
      const issue = await issueOf(key);
      const runs = (await night.client.runs.list({ projectId })).filter((r) => r.subject.id === issue.id && r.lane === "dev" && r.parentRunId === null);
      expect(runs).toHaveLength(1);
      return runs[0]!;
    };
    /** Las corridas raíz del flujo `slug` (las de mantenimiento arrancan solas, por un evento de Watch). */
    const runsOfFlow = async (slug: string) => (await night.client.runs.list({ projectId })).filter((r) => r.flow.slug === slug && r.parentRunId === null);
    const devLane = async () => (await night.client.system.lanes()).dev;

    // Tramo 1: WEB-1 y WEB-3 corren a la vez; WEB-2, bloqueada por WEB-1, se apila sobre su PR apenas está verde.
    const first = night.addIssue({ title: "Agregar a", priority: 1 });
    night.addIssue({ title: "Agregar b", priority: 2, blockedBy: first });
    night.addIssue({ title: "Agregar shared", priority: 2 });
    await night.until("los tres PRs en draft", async () => {
      expect(github.pulls()).toHaveLength(3);
      for (const key of ["WEB-1", "WEB-2", "WEB-3"]) expect((await runOf(key)).status).toBe("done");
    });
    const [prA, prB, prC] = await Promise.all(["WEB-1", "WEB-2", "WEB-3"].map(prOf));
    expect([prA!.draft, prB!.draft, prC!.draft]).toEqual([true, true, true]);
    expect([prA!.base.ref, prB!.base.ref, prC!.base.ref]).toEqual(["main", prA!.head.ref, "main"]);
    expect([commentsOf(prA!), commentsOf(prB!), commentsOf(prC!)]).toEqual([["/review"], ["/review"], ["/review"]]);

    // Tramo 2: llegan WEB-4 y WEB-5 y sus agentes quedan en curso: el carril de dev está lleno.
    holds.hold("WEB-4:plan");
    holds.hold("WEB-5:plan");
    night.addIssue({ title: "Agregar d", priority: 3 });
    night.addIssue({ title: "Agregar e", priority: 3 });
    await night.until("dev lleno", async () => {
      expect([holds.held("WEB-4:plan"), holds.held("WEB-5:plan")]).toEqual([1, 1]);
      expect(await devLane()).toEqual({ active: 2, capacity: 2 });
    });

    // Tramo 3, con dev lleno: se mergea el PR de WEB-1 (restack del de WEB-2) y la base se mueve sobre el archivo de WEB-3
    // (rebase por conflicto). El agente del rebase queda en curso para cortar el core justo ahí.
    holds.hold("-:conflict");
    night.merge(prA!.number);
    night.pushToMain({ "src/shared.ts": SHARED_ON_MAIN }, "feat(shared): the base owns the value");
    await night.until("el restack de WEB-2 terminado y el rebase de WEB-3 en curso", async () => {
      expect(await runsOfFlow("restack")).toMatchObject([{ lane: "maintenance", status: "done", outcome: "done" }]);
      expect(holds.held("-:conflict")).toBe(1);
    });
    // WEB-2 quedó sobre `main`, con sus commits, y pidió `/review` otra vez (era un draft que el restack pusheó).
    expect(github.pr(prB!.number).node().baseRefName).toBe("main");
    expect(night.remoteLog(prB!.head.ref).map((c) => c.subject)).toEqual(["feat(b): add the b helper"]);
    expect(commentsOf(prB!)).toEqual(["/review", "/review"]);
    // El rebase corre en mantenimiento y dev sigue lleno: nadie esperó a nadie.
    const [rebase] = await runsOfFlow("rebase-conflicto");
    expect(rebase).toMatchObject({ lane: "maintenance", status: "running", subject: { type: "pr" } });
    expect(await devLane()).toEqual({ active: 2, capacity: 2 });
    expect((await night.client.system.lanes()).maintenance.active).toBe(1);

    // El corte, con WEB-4 y WEB-5 en su agente y el rebase a medias en el suyo. Un proceso de un core anterior sigue vivo.
    orphan = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    const orphanExit = new Promise((resolve) => orphan!.once("exit", (_code, signal) => resolve(signal)));
    const dead = openStore({ path: night.home.dbPath });
    createProcs({ store: dead, bootId: "boot_dead" }).track(orphan, { kind: "agent" });
    await night.restart();
    expect(await orphanExit).toBe("SIGKILL");
    dead.close();
    expect(night.store.events.since(0, { types: ["core.recovered"] }).at(-1)?.payload).toMatchObject({ orphans: 1 });
    // El cierre devolvió a pending los tres pasos de agente en curso, sin gastarles intento, y el core nuevo los retomó
    // (el mismo paso con otro attempt, no uno nuevo); dev sigue lleno.
    expect(sql("SELECT node_id, deferrals, recoveries FROM step_runs WHERE deferrals > 0 ORDER BY node_id")).toEqual([
      { node_id: "plan", deferrals: 1, recoveries: 0 },
      { node_id: "plan", deferrals: 1, recoveries: 0 },
      { node_id: "resolve", deferrals: 1, recoveries: 0 },
    ]);
    await night.until("los tres agentes retomados", async () => {
      expect([holds.held("WEB-4:plan"), holds.held("WEB-5:plan"), holds.held("-:conflict")]).toEqual([1, 1, 1]);
      expect(await devLane()).toEqual({ active: 2, capacity: 2 });
    });
    expect(sql("SELECT run_id, node_id, visit FROM step_runs GROUP BY run_id, node_id, visit HAVING count(*) > 1")).toEqual([]);
    expect(sql("SELECT pid FROM procs WHERE boot_id = 'boot_dead'")).toEqual([]);

    // El rebase termina con dev todavía lleno: WEB-3 sobre la base nueva, un solo `/review` más y sin duplicados.
    holds.release("-:conflict");
    await night.until("el rebase de WEB-3 terminado", async () => {
      expect(await runsOfFlow("rebase-conflicto")).toMatchObject([{ status: "done", outcome: "done" }]);
      expect(commentsOf(prC!)).toEqual(["/review", "/review"]);
    });
    expect(github.pr(prC!.number).node().mergeable).toBe("MERGEABLE");
    expect(night.remoteLog(prC!.head.ref).map((c) => c.subject)).toEqual(["feat(shared): add the shared owner"]);
    expect(night.repo.git("--git-dir", night.repo.remoteDir!, "show", `${prC!.head.ref}:src/shared.ts`)).toBe('export const shared = { owner: "c", value: 2 };');
    expect(await devLane()).toEqual({ active: 2, capacity: 2 });
    expect(github.pulls()).toHaveLength(3);

    // Un thread de council sobre el PR de WEB-2: el flujo lo aplica como `fixup!` visible (sin force push) y lo responde.
    const published = night.remoteLog(prB!.head.ref).length;
    github.pr(prB!.number).councilThread("b debería sumar 2", { path: "src/b.ts", line: 2 });
    await night.until("el fixup de WEB-2 pusheado", () => {
      expect(night.remoteLog(prB!.head.ref)).toHaveLength(published + 1);
    });
    // El CI de GitHub arranca con el push (el simulador no corre nada solo): el flujo espera ese check verde y termina.
    github.pr(prB!.number).ci("green");
    await night.until("el council de WEB-2", async () => {
      expect(await runsOfFlow("council")).toMatchObject([{ lane: "maintenance", status: "done", outcome: "done" }]);
    });
    expect(night.remoteLog(prB!.head.ref)[0]!.subject).toMatch(/^fixup! /);
    expect(github.pr(prB!.number).node().reviewThreads[0]?.comments.nodes).toHaveLength(2);
    expect(await devLane()).toEqual({ active: 2, capacity: 2 });

    // El entorno del repo se cae justo cuando WEB-5 llega a sus checks: se abre el breaker `repo:` con su alerta, el paso
    // espera sin gastar intento y, cuando el entorno vuelve, el breaker se cierra solo y la corrida sigue.
    night.environmentFlag.down();
    holds.release("WEB-5:plan");
    const breaker = await night.until("el breaker del repo", async () => {
      const open = await night.client.system.breakers();
      expect(open).toMatchObject([{ scope: expect.stringMatching(/^repo:/), cause: "environment" }]);
      return open[0]!;
    });
    expect(await night.client.decisions.list({ kind: ["alert"], status: ["pending"] })).toMatchObject([{ id: breaker.decisionId }]);
    const e = await runOf("WEB-5");
    expect(e.status).toBe("running");
    expect(sql("SELECT status, attempt - recoveries - deferrals AS spent FROM step_runs WHERE run_id = ? AND node_id = 'checks'", e.id)).toEqual([{ status: "pending", spent: 0 }]);
    night.environmentFlag.up();
    await night.until("el breaker cerrado y WEB-5 publicado", async () => {
      expect(await night.client.system.breakers()).toEqual([]);
      expect((await runOf("WEB-5")).status).toBe("done");
    });
    expect(night.store.events.since(0, { types: ["breaker.opened", "breaker.closed"] }).map((event) => event.type)).toEqual(["breaker.opened", "breaker.closed"]);
    expect(await night.client.decisions.list({ kind: ["alert"], status: ["pending"] })).toEqual([]);

    // WEB-4 gasta más que el tope del proyecto: solo su corrida se estaciona (y suelta su cupo de dev), lo demás sigue.
    holds.release("WEB-4:plan");
    const parked = await night.until("WEB-4 estacionada por el tope de gasto", async () => {
      const d = await runOf("WEB-4");
      expect(d.status).toBe("parked");
      return d;
    });
    expect(parked.parkReason).toBe("limit");
    const [gate] = await night.client.decisions.list({ runId: parked.id, status: ["pending"] });
    expect(gate).toMatchObject({ options: ["continue", "continue:latest-profile", "cancel"] });
    expect((await devLane()).active).toBe(0);

    // Todas las issues que no se estacionaron terminaron con su PR en draft (el de WEB-1, ya mergeado, salió así).
    for (const key of ["WEB-1", "WEB-2", "WEB-3", "WEB-5"]) expect((await runOf(key)).outcome).toBe("done");
    expect((await Promise.all(["WEB-2", "WEB-3", "WEB-5"].map(prOf))).map((p) => [p.draft, p.state])).toEqual([[true, "open"], [true, "open"], [true, "open"]]);

    // Resolver la decisión devuelve la corrida a la cola de su carril, con su worktree, y esa issue también llega a su PR.
    await night.client.decisions.resolve({ id: gate!.id, option: "continue" });
    await night.until("WEB-4 con su PR en draft", async () => {
      expect((await runOf("WEB-4")).outcome).toBe("done");
      expect((await prOf("WEB-4")).draft).toBe(true);
    });

    // Al final de la noche: nadie falló, nada se duplicó y no queda ningún proceso, lease ni slot tomado.
    expect((await night.client.runs.list({ projectId })).filter((r) => r.outcome === "failed" || r.status === "failed")).toEqual([]);
    expect(night.store.events.since(0, { types: ["error"] }).filter((event) => event.payload.scope !== "agent.context")).toEqual([]);
    expect(sql("SELECT run_id, node_id, visit FROM step_runs GROUP BY run_id, node_id, visit HAVING count(*) > 1")).toEqual([]);
    expect(sql("SELECT id FROM pull_requests GROUP BY repo_id, number HAVING count(*) > 1")).toEqual([]);
    // Cada evento de Watch arrancó su flujo una sola vez, también el que cayó en el corte.
    for (const slug of ["restack", "rebase-conflicto", "council"]) expect(await runsOfFlow(slug)).toHaveLength(1);
    // El cierre de un paso (kill del proceso, release del worktree y del slot) termina un instante después de `run.finished`.
    await night.until("sin procesos, worktrees ni slots tomados", () => {
      expect(sql("SELECT pid FROM procs")).toEqual([]);
      expect(sql("SELECT state FROM workspaces WHERE holder_run_id IS NOT NULL")).toEqual([]);
      expect(sql("SELECT idx FROM slots WHERE holder_run_id IS NOT NULL")).toEqual([]);
    });
  });
});
