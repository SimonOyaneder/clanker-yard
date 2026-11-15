import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Client, type Event, type ProjectId } from "@clanker/api";
import { createConnections, createFileSecrets, createIssues, createLocalTracker, createRepos, openStore, startCore, type Core, type Store } from "@clanker/core";
import { ORPCError } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createFakeRuntime } from "./fake-runtime";
import { tempGitRepo, type TempGitRepo } from "./git";
import { seedDb, type TestHome } from "./home";

// El Scheduler en el core armado como en producción, con el runtime fake: el producto lanza las issues
// solo, sin que nadie apriete "Correr" (`runs.start`).

/** `vi.waitFor` con holgura: la suite entera corre en paralelo y un tick puede tardar más de 1 s. */
const until = (check: () => unknown) => vi.waitFor(check, { timeout: 10_000 });

const juguete = fileURLToPath(new URL("../fixtures/runs/juguete", import.meta.url));

let home: TestHome;
let store: Store;
let repo: TempGitRepo;
let core: Core | undefined;

beforeEach(() => {
  home = seedDb("empty");
  store = openStore({ path: home.dbPath });
  repo = tempGitRepo({});
});

afterEach(async () => {
  await core?.close();
  core = undefined;
  store.close();
  repo.cleanup();
  home.cleanup();
});

async function boot(): Promise<Client> {
  core = await startCore({
    store,
    dataDir: home.path,
    connections: createConnections(store, createFileSecrets({ dir: join(home.path, "secrets") })),
    runtimes: [createFakeRuntime({ fixtures: juguete, speed: Infinity })],
    env: { CORE_RUNTIME: "fake" },
    coreVersion: "0.0.0",
    onShutdown: () => {},
  });
  return createClient({ url: core.server.url, token: core.server.token, origin: "cli" });
}

async function toyProject(client: Client, parallel = 2) {
  const repoId = createRepos(store).add({ name: "demo", path: repo.dir });
  return client.projects.create({
    slug: "demo",
    name: "Demo",
    tracker: "local",
    defaultFlowId: "juguete",
    defaultProfileId: "juguete",
    parallel,
    flowParams: { repo: repoId },
  });
}

const eventsOf = (types: Event["type"][]) => store.events.since(0, { types });

describe("el Scheduler del core", () => {
  test("lanza solo las issues de la cola y las corre hasta el final", async () => {
    const client = await boot();
    const project = await toyProject(client);

    const first = await client.issues.createLocal({ projectId: project.id, title: "Una", priority: 1 });
    const second = await client.issues.createLocal({ projectId: project.id, title: "Otra", priority: 2 });

    await until(async () => {
      expect((await client.runs.list({ projectId: project.id })).map((r) => [r.subject.id, r.status, r.outcome]).sort()).toEqual(
        [[first.id, "done", "done"], [second.id, "done", "done"]].sort(),
      );
    });
    expect(eventsOf(["issue.claimed"]).map((e) => e.payload.issueId).sort()).toEqual([first.id, second.id].sort());
    expect(await client.projects.queue({ id: project.id })).toEqual([]);
  });

  test("al arrancar lanza lo que ya estaba en la cola", async () => {
    let client = await boot();
    const project = await toyProject(client);
    await core!.close();
    core = undefined;
    // Las issues llegan con el core apagado (la UI de otra máquina, un sync).
    const issue = await createIssueOffline(project.id);

    client = await boot();

    await until(async () => {
      expect(await client.runs.list({ projectId: project.id })).toMatchObject([{ subject: { id: issue }, status: "done" }]);
    });
  });

  test("system.setLanes y projects.setParallel cambian los cupos y rigen de inmediato", async () => {
    const client = await boot();
    const project = await toyProject(client, 1);

    expect(await client.system.lanes()).toEqual({ dev: { active: 0, capacity: 4 }, maintenance: { active: 0, capacity: 2 } });
    expect(await client.system.setLanes({ maintenance: 3 })).toEqual({ dev: { active: 0, capacity: 4 }, maintenance: { active: 0, capacity: 3 } });
    expect((await client.system.lanes()).maintenance.capacity).toBe(3);
    await expect(client.system.setLanes({ dev: 0 })).rejects.toThrow();

    expect(await client.projects.setParallel({ id: project.id, parallel: 3 })).toMatchObject({ parallel: 3 });
    expect(eventsOf(["project.updated"]).at(-1)).toMatchObject({ origin: "cli", payload: { fields: ["parallel"] } });
  });

  test("projects.skipIssue: la issue saltada no se lanza y la API rechaza lo que no existe", async () => {
    const client = await boot();
    const project = await toyProject(client);
    // Con el proyecto pausado el Scheduler no lanza nada mientras se arma la cola.
    await client.projects.update({ id: project.id, status: "paused" });
    const skipped = await client.issues.createLocal({ projectId: project.id, title: "Saltada", priority: 1 });
    const other = await client.issues.createLocal({ projectId: project.id, title: "Otra", priority: 2 });
    await client.projects.skipIssue({ id: project.id, issueId: skipped.id });

    await client.projects.update({ id: project.id, status: "active" });

    await until(async () => {
      expect((await client.runs.list({ projectId: project.id })).map((r) => [r.subject.id, r.status])).toEqual([[other.id, "done"]]);
    });
    expect(await client.projects.queue({ id: project.id })).toMatchObject([{ issue: { id: skipped.id }, state: "blocked" }]);
    await expect(client.projects.skipIssue({ id: project.id, issueId: "iss_00000000000000000000000001" })).rejects.toSatisfy(
      (e: unknown) => e instanceof ORPCError && e.code === "BAD_REQUEST",
    );
  });
});

describe("el repo de la issue", () => {
  let other: TempGitRepo;
  beforeEach(() => {
    other = tempGitRepo({});
  });
  afterEach(() => other.cleanup());

  /** Un proyecto con dos repos, `front` y `back`, cada uno con su label; el flujo por defecto es `juguete`. */
  async function twoRepoProject(client: Client) {
    const repos = createRepos(store);
    const front = repos.add({ name: "front", path: repo.dir });
    const back = repos.add({ name: "back", path: other.dir });
    const project = await client.projects.create({
      slug: "demo",
      name: "Demo",
      tracker: "local",
      defaultFlowId: "juguete",
      defaultProfileId: "juguete",
      repos: [{ repoId: front, labels: ["frontend"] }, { repoId: back, labels: ["backend"] }],
    });
    return { project, front, back };
  }

  test("una issue que toca dos repos corre dos veces, una por repo y en el orden del proyecto", async () => {
    const client = await boot();
    const { project, front, back } = await twoRepoProject(client);

    const both = await client.issues.createLocal({ projectId: project.id, title: "Cruza", labels: ["backend", "frontend"] });

    await until(async () => {
      const runs = await client.runs.list({ projectId: project.id });
      expect(runs.map((r) => [r.status, r.outcome])).toEqual([["done", "done"], ["done", "done"]]);
    });
    const runs = (await client.runs.list({ projectId: project.id })).sort((a, b) => a.startedAt - b.startedAt);
    expect(runs.map((r) => [r.subject.id, r.params.repo])).toEqual([[both.id, front], [both.id, back]]);
    // Con una corrida en cada repo ya no queda nada por lanzar, aunque la issue siga en progreso.
    expect(await client.projects.queue({ id: project.id })).toEqual([]);
  });

  test("una issue ambigua deja una decisión con los repos y corre en el que se elige", async () => {
    const client = await boot();
    const { project, back } = await twoRepoProject(client);

    const issue = await client.issues.createLocal({ projectId: project.id, title: "No se sabe", labels: ["otro"] });

    const [question] = await vi.waitFor(async () => {
      const pending = await client.decisions.list({ projectId: project.id, status: ["pending"] });
      expect(pending).toHaveLength(1);
      return pending;
    });
    expect(question).toMatchObject({ kind: "question", subject: { type: "issue", id: issue.id }, options: ["front", "back"] });
    expect(await client.projects.queue({ id: project.id })).toMatchObject([{ issue: { id: issue.id }, state: "blocked" }]);
    expect(await client.runs.list({ projectId: project.id })).toEqual([]);

    // Un tick nuevo (la issue siguiente) no repite la pregunta de la primera mientras siga pendiente.
    const next = await client.issues.createLocal({ projectId: project.id, title: "Tampoco se sabe" });
    await until(async () => expect(await client.decisions.list({ projectId: project.id })).toHaveLength(2));
    expect((await client.decisions.list({ projectId: project.id })).map((d) => d.subject?.id).sort()).toEqual([issue.id, next.id].sort());

    await client.decisions.resolve({ id: question!.id, option: "back" });

    await until(async () => {
      expect((await client.runs.list({ projectId: project.id })).map((r) => [r.subject.id, r.params.repo, r.status])).toEqual([[issue.id, back, "done"]]);
    });
  });

  test("runs.start de una issue ambigua pide el repo; con params.repo corre", async () => {
    const client = await boot();
    const { project, back } = await twoRepoProject(client);
    const issue = await client.issues.createLocal({ projectId: project.id, title: "No se sabe" });

    await expect(client.runs.start({ projectId: project.id, issueId: issue.id })).rejects.toThrow(/no calza ningún repo/);
    const run = await client.runs.start({ projectId: project.id, issueId: issue.id, params: { repo: back } });

    expect(run.params).toMatchObject({ repo: back });
  });
});

/** Una issue local que llega con el core apagado: nadie la lanza hasta el próximo arranque. */
async function createIssueOffline(projectId: ProjectId): Promise<string> {
  const issues = createIssues(store, createLocalTracker(store));
  return (await issues.createLocal({ projectId, title: "Pendiente" }, "cli")).id;
}
