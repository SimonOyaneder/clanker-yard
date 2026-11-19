import { afterEach, describe, expect, test } from "vitest";
import type { FlowDef, ProposedLearning, RepoId } from "@clanker/api";
import { createLearnings } from "../learnings/learnings";
import { newId } from "../store/conventions";
import { harness as createHarness } from "../testing/flows-harness";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const flowOf = (mode: string) =>
  ({
    schema: 1,
    id: "agent-learnings",
    name: "Agente con learnings",
    trigger: { type: "manual" },
    start: "plan",
    nodes: { plan: { type: "agent", role: "dev", mode, brief: {}, on: { ok: "@done", changes: "@done" } } },
  }) as const satisfies FlowDef;

const inProject = (...texts: string[]): ProposedLearning[] => texts.map((text) => ({ text, scope: "project" }));
const inRepo = (...texts: string[]): ProposedLearning[] => texts.map((text) => ({ text, scope: "repo" }));

function run(learnings: ProposedLearning[], projectId?: ReturnType<typeof newId<"prj">>, mode = "implement", repoId?: RepoId) {
  const h = createHarness({
    script: () => Promise.resolve({ structured: { outcome: "ok", summary: "listo", learnings, payload: { n: 1 } } }),
    workspaceOf: () => ({ path: "/work/tree", base: "main", ...(repoId && { repoId }) }),
  });
  cleanups.push(h.cleanup);
  h.save(flowOf(mode));
  const runId = h.flows.start("agent-learnings", { type: "issue", id: "ENG-1" }, undefined, { profile: "default", ...(projectId && { projectId }) });
  return { h, runId, store: h.store };
}

describe("Report.learnings", () => {
  test("quedan proposed en el proyecto de la corrida y la corrida sigue sin esperar a nadie", async () => {
    const projectId = newId("prj");
    const { h, runId, store } = run(inProject("  Los specs usan `let_it_be`  "), projectId);

    await h.finished(runId);

    expect(h.flows.getRun(runId)).toMatchObject({ status: "done", outcome: "done" });
    expect(createLearnings({ store }).list({ projectId }).map(({ text, status, source, sourceRunId, repoId, roles }) => ({ text, status, source, sourceRunId, repoId, roles }))).toEqual([
      { text: "Los specs usan `let_it_be`", status: "proposed", source: "agent", sourceRunId: runId, repoId: null, roles: [] },
    ]);
    expect(store.events.since(0, { runId, types: ["learning.proposed"] })).toHaveLength(1);
  });

  test("máximo 1 por paso: guarda el primero y avisa del resto sin fallar", async () => {
    const projectId = newId("prj");
    const { h, runId, store } = run(inProject("Primero", "Segundo", "Tercero"), projectId);

    await h.finished(runId);

    expect(h.flows.getRun(runId)).toMatchObject({ status: "done" });
    expect(createLearnings({ store }).list({ projectId }).map((l) => l.text)).toEqual(["Primero"]);
    expect(store.events.since(0, { runId, types: ["error"] }).map((e) => e.payload)).toEqual([
      { scope: "learnings", message: expect.stringContaining("se descartaron 2") },
    ]);
  });

  test("un propuesto casi igual a uno existente (minúsculas, backticks, puntuación) se descarta", async () => {
    const projectId = newId("prj");
    const first = run(inProject("Usa `let_it_be`."), projectId);
    await first.h.finished(first.runId);
    const learnings = createLearnings({ store: first.store });
    learnings.reject(learnings.list({ projectId })[0]!.id, "ui");

    const again = learnings.propose({ projectId, text: "usa let_it_be", roles: [], tags: [] }, "ui");

    expect(again).toMatchObject({ text: "Usa `let_it_be`.", status: "rejected" });
    expect(learnings.list({ projectId })).toHaveLength(1);
  });

  test("un modo que no propone (dev en plan) no deja learnings, ni se los pide al agente", async () => {
    const projectId = newId("prj");
    const { h, runId, store } = run(inProject("Algo que nadie pidió"), projectId, "plan");

    await h.finished(runId);

    expect(createLearnings({ store }).list({ projectId })).toEqual([]);
    const spec = h.calls[0]!.spec!;
    expect(spec.prompt).not.toContain("Learnings (`learnings` del reporte)");
    expect(spec.outputSchema.properties).not.toHaveProperty("learnings");
  });

  test("dev en implement recibe el criterio con su ejemplo bueno y malo, y el esquema acepta learnings", async () => {
    const { h, runId } = run([], newId("prj"));

    await h.finished(runId);

    const spec = h.calls[0]!.spec!;
    expect(spec.prompt).toContain("máximo 1 por corrida; si dudas, no lo propongas");
    expect(spec.prompt).toContain("Reutilizable");
    expect(spec.prompt).toContain("Bueno:");
    expect(spec.prompt).toContain("Malo:");
    expect(spec.outputSchema.properties).toHaveProperty("learnings");
    expect(spec.prompt).toContain("Cada learning lleva `scope`");
  });

  test("el agente elige el alcance: repo va al repo del worktree y project al proyecto de la corrida", async () => {
    const projectId = newId("prj");
    const repoId = newId("repo");
    const toRepo = run(inRepo("Corre packwerk sin rutas"), projectId, "implement", repoId);
    await toRepo.h.finished(toRepo.runId);
    const toProject = run(inProject("El modelo nuevo vive en el engine dashboard"), projectId, "implement", repoId);
    await toProject.h.finished(toProject.runId);

    const scopes = [toRepo, toProject].flatMap(({ store }) => createLearnings({ store }).list().map(({ text, projectId: p, repoId: r }) => ({ text, projectId: p, repoId: r })));
    expect(scopes).toEqual([
      { text: "Corre packwerk sin rutas", projectId: null, repoId },
      { text: "El modelo nuevo vive en el engine dashboard", projectId, repoId: null },
    ]);
  });

  test("si falta el alcance que pidió el agente, el learning va al otro", async () => {
    const projectId = newId("prj");
    const repoId = newId("repo");
    const noRepo = run(inRepo("Sin worktree con repo"), projectId);
    await noRepo.h.finished(noRepo.runId);
    const noProject = run(inProject("Sin proyecto"), undefined, "implement", repoId);
    await noProject.h.finished(noProject.runId);

    expect(createLearnings({ store: noRepo.store }).list()).toMatchObject([{ text: "Sin worktree con repo", projectId, repoId: null }]);
    expect(createLearnings({ store: noProject.store }).list()).toMatchObject([{ text: "Sin proyecto", projectId: null, repoId }]);
  });

  test("uno repetido o vacío no se propone, y una corrida sin proyecto ni repo no propone nada", async () => {
    const projectId = newId("prj");
    const first = run(inProject("   ", "Usa el helper"), projectId);
    await first.h.finished(first.runId);
    expect(createLearnings({ store: first.store }).list({ projectId })).toHaveLength(1);

    const second = run(inProject("Algo que nadie va a aprobar"));
    await second.h.finished(second.runId);
    expect(createLearnings({ store: second.store }).list()).toEqual([]);
  });
});
