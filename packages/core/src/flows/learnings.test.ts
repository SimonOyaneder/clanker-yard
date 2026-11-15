import { afterEach, describe, expect, test } from "vitest";
import type { FlowDef } from "@clanker/api";
import { createLearnings } from "../learnings/learnings";
import { newId } from "../store/conventions";
import { harness as createHarness } from "./harness";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const flow = {
  schema: 1,
  id: "agent-learnings",
  name: "Agente con learnings",
  trigger: { type: "manual" },
  start: "plan",
  nodes: { plan: { type: "agent", role: "dev", mode: "plan", brief: {}, on: { ok: "@done", changes: "@done" } } },
} as const satisfies FlowDef;

function run(learnings: string[], projectId?: ReturnType<typeof newId<"prj">>) {
  const h = createHarness({
    script: () => Promise.resolve({ structured: { outcome: "ok", summary: "listo", learnings, payload: { n: 1 } } }),
  });
  cleanups.push(h.cleanup);
  h.save(flow);
  const runId = h.flows.start("agent-learnings", { type: "issue", id: "ENG-1" }, undefined, { profile: "default", ...(projectId && { projectId }) });
  return { h, runId, store: h.store };
}

describe("Report.learnings", () => {
  test("quedan proposed en el proyecto de la corrida y la corrida sigue sin esperar a nadie", async () => {
    const projectId = newId("prj");
    const { h, runId, store } = run(["  Los specs usan `let_it_be`  ", "El lint corre con `npm run lint`"], projectId);

    await h.finished(runId);

    expect(h.flows.getRun(runId)).toMatchObject({ status: "done", outcome: "done" });
    expect(createLearnings(store).list({ projectId }).map(({ text, status, source, sourceRunId, repoId, roles }) => ({ text, status, source, sourceRunId, repoId, roles }))).toEqual([
      { text: "El lint corre con `npm run lint`", status: "proposed", source: "agent", sourceRunId: runId, repoId: null, roles: [] },
      { text: "Los specs usan `let_it_be`", status: "proposed", source: "agent", sourceRunId: runId, repoId: null, roles: [] },
    ]);
    expect(store.events.since(0, { runId, types: ["learning.proposed"] })).toHaveLength(2);
  });

  test("uno repetido o vacío no se propone, y una corrida sin proyecto no propone nada", async () => {
    const projectId = newId("prj");
    const first = run(["Usa el helper", "Usa el helper", "   "], projectId);
    await first.h.finished(first.runId);
    expect(createLearnings(first.store).list({ projectId })).toHaveLength(1);

    const second = run(["Algo que nadie va a aprobar"]);
    await second.h.finished(second.runId);
    expect(createLearnings(second.store).list()).toEqual([]);
  });
});
