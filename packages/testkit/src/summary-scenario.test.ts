import { join } from "node:path";
import { createClient, type Client, type ProjectSummary } from "@clanker/api";
import { createConnections, createFileSecrets, openStore, type Core, type Store } from "@clanker/core";
import { startCore } from "./start-core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createFakeRuntime } from "./fake-runtime";
import { seedDb, type TestHome } from "./home";
import { seedSummary, SUMMARY_PROJECT_SLUG } from "./summary-scenario";

// El escenario de las capturas del Resumen (`DEMO_SCENARIO=summary`) visto por la API, como lo ve la UI: lo importado del
// clanker-loop y lo nuevo de Yard en el mismo proyecto, con totales que cuadran entre `projects.summary` y `metrics.*`.

let home: TestHome;
let store: Store;
let core: Core;
let client: Client;
let project: { id: ProjectSummaryProject };
type ProjectSummaryProject = Awaited<ReturnType<typeof seedSummary>>["projectId"];

beforeEach(async () => {
  home = seedDb("empty");
  store = openStore({ path: home.dbPath });
  core = await startCore({
    store,
    dataDir: home.path,
    connections: createConnections(store, createFileSecrets({ dir: join(home.path, "secrets") })),
    runtimes: [createFakeRuntime({ fixtures: join(import.meta.dirname, "../fixtures/runs/juguete"), speed: Infinity })],
    env: { CORE_RUNTIME: "fake" },
    scheduler: false,
    coreVersion: "0.0.0",
    onShutdown: () => {},
  });
  client = createClient({ url: core.server.url, token: core.server.token, origin: "cli" });
  const { projectId } = await seedSummary({ client, store });
  project = { id: projectId };
});

afterEach(async () => {
  await core.close();
  store.close();
  home.cleanup();
});

const total = (rows: { costMicros: number }[]) => rows.reduce((sum, r) => sum + r.costMicros, 0);

test("el proyecto mezcla las corridas importadas y las de Yard, y el origen las separa", async () => {
  const slug = (await client.projects.list()).find((p) => p.id === project.id)?.slug;
  expect(slug).toBe(SUMMARY_PROJECT_SLUG);

  const all = await client.projects.summary({ id: project.id });
  const imported = await client.projects.summary({ id: project.id, imported: true });
  const yard = await client.projects.summary({ id: project.id, imported: false });

  expect(imported).toMatchObject({ runs: 5, costMicros: 22_150_000 });
  expect(yard.runs).toBe(4);
  expect(all.runs).toBe(imported.runs + yard.runs);
  expect(all.costMicros).toBe(imported.costMicros + yard.costMicros);
  expect(yard.results).toEqual([{ result: "done", count: 3 }, { result: "failed", count: 1 }]);
});

test("los totales de projects.summary son los de metrics.byRole, byModel, byDay y, en Yard, byStep", async () => {
  for (const imported of [undefined, true, false] as const) {
    const filter = { projectId: project.id, ...(imported === undefined ? {} : { imported }) };
    const summary: ProjectSummary = await client.projects.summary({ id: project.id, ...(imported === undefined ? {} : { imported }) });

    expect(total(summary.byRole)).toBe(summary.costMicros);
    expect(total(await client.metrics.byRole(filter))).toBe(summary.costMicros);
    expect(total(await client.metrics.byModel(filter))).toBe(summary.costMicros);
    expect(total(await client.metrics.byDay(filter))).toBe(summary.costMicros);
    expect(total(await client.metrics.byIssue(filter))).toBe(summary.costMicros);
  }
  const yard = await client.projects.summary({ id: project.id, imported: false });
  expect(total(await client.metrics.byStep({ projectId: project.id }))).toBe(yard.costMicros);
  expect(await client.metrics.byStep({ projectId: project.id, imported: true })).toEqual([]);
});

test("las rondas por issue suman las importadas y las de Yard de la misma issue", async () => {
  const issues = await client.issues.list({ projectId: project.id });
  const idOf = (key: string) => issues.find((i) => i.ref.key === key)!.id;
  const byIssue = await client.metrics.byIssue({ projectId: project.id });

  // DEMO-4: review 3, bot 3, ci 2 en el loop viejo y review 1, external 1 en Yard.
  expect(byIssue.find((i) => i.issueId === idOf("DEMO-4"))).toMatchObject({ runs: 2, rounds: { review: 4, bot: 3, ci: 2, external: 1 } });
  expect(byIssue.find((i) => i.issueId === idOf("DEMO-12"))).toMatchObject({ runs: 1, rounds: { review: 3, external: 2 } });
  expect(issues.find((i) => i.ref.key === "DEMO-12")?.title).toBe("Documentar el módulo de fechas en el README");
});
