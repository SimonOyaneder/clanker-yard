import { join } from "node:path";
import { createClient, type Client } from "@clanker/api";
import { createConnections, createFileSecrets, createRepos, openStore, startCore, type Core, type Store } from "@clanker/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createFakeRuntime } from "./fake-runtime";
import { seedDb, type TestHome } from "./home";
import { seedLearnings } from "./learnings-scenario";

// El escenario de la revisión de learnings (`DEMO_SCENARIO=learnings`) visto por la API, como lo ve la UI: lo importado
// del clanker-loop, lo de agentes y personas por revisar, y lo ya revisado en sus otros tres estados.

let home: TestHome;
let store: Store;
let core: Core;
let client: Client;

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
  const repoId = createRepos(store).add({ name: "demo", path: home.path, remote: null });
  const project = await client.projects.create({ slug: "demo", name: "Demo", tracker: "local", defaultFlowId: "juguete", defaultProfileId: "juguete" });
  const issue = await client.issues.createLocal({ projectId: project.id, title: "Saluda al mundo" });
  const run = await client.runs.start({ projectId: project.id, issueId: issue.id, params: { repo: repoId } });
  await seedLearnings({ client, store, repoId, demoProjectId: project.id, runId: run.id });
});

afterEach(async () => {
  await core.close();
  store.close();
  home.cleanup();
});

test("deja por revisar los importados, los de agentes y los escritos a mano, y ya revisados los de las otras pestañas", async () => {
  const all = await client.learnings.list();
  const count = (status: string, source?: string) => all.filter((l) => l.status === status && (!source || l.source === source)).length;

  expect(count("proposed", "import")).toBe(26);
  expect(count("proposed", "agent")).toBe(5);
  expect(count("proposed", "human")).toBe(2);
  expect(count("approved")).toBe(5);
  expect(count("rejected")).toBe(2);
  expect(count("archived")).toBe(1);
});

test("hay alcances de proyecto y de repo, roles y tags, y los de agentes dicen de qué corrida salen", async () => {
  const all = await client.learnings.list();

  expect(new Set(all.map((l) => l.projectId).filter(Boolean)).size).toBe(3);
  expect(all.some((l) => l.repoId !== null && l.projectId === null)).toBe(true);
  expect(all.some((l) => l.roles.length > 1)).toBe(true);
  expect(all.some((l) => l.tags.length > 0)).toBe(true);
  expect(all.filter((l) => l.source === "agent").every((l) => l.sourceRunId !== null)).toBe(true);
  // Lo importado nunca trae rol ni corrida: son viñetas del loop viejo para todos los roles.
  expect(all.filter((l) => l.source === "import" && l.status === "proposed").every((l) => l.roles.length === 0 && l.sourceRunId === null)).toBe(true);
});
