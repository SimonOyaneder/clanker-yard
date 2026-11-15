import { afterEach, expect, test, vi } from "vitest";
import { startTechleadScenario, type TechleadScenario } from "./techlead-scenario";

// El mapeo de estados de un proyecto (`projects.update`) llega al adapter de Linear del core real: reclamar una issue la
// mueve al estado que el mapeo del proyecto llama `in_progress`, no al que el adapter elegiría solo.

vi.setConfig({ testTimeout: 60_000 });

let scenario: TechleadScenario | undefined;
afterEach(async () => {
  await scenario?.cleanup();
  scenario = undefined;
});

test("reclamar una issue de Linear usa el estado que el mapeo del proyecto llama in_progress", async () => {
  scenario = await startTechleadScenario({ tracker: "linear" });
  const { client, project, linear } = scenario;
  await client.projects.update({ id: project.id, statusMapping: { "In Progress": "todo", "In Review": "in_progress" } });

  const { run } = await scenario.run();
  await scenario.finished(run.id);

  const issues = await linear!.workspace.execute("{ issues { nodes { state { name } } } }").then((r) => (r.data as { issues: { nodes: { state: { name: string } }[] } }).issues.nodes);
  expect(issues.map((i) => i.state.name)).toEqual(["In Review"]);
});
