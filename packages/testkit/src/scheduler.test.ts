import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Client, type Event, type ProjectId } from "@clanker/api";
import { combinedBaseBranch, createConnections, createFileSecrets, createIssues, createLocalTracker, createRepos, openStore, type Core, type Store } from "@clanker/core";
import { startCore } from "./start-core";
import { ORPCError } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createFakeRuntime } from "./fake-runtime";
import { tempGitRepo, type TempGitRepo } from "./git";
import { seedDb, type TestHome } from "./home";
import { seedPr } from "@clanker/core/testing";

/** El plazo de un `vi.waitFor`: el default de 1 s no alcanza con la suite en paralelo y bajo carga. */
const WAIT = { timeout: 10_000 };

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

async function boot({ scheduler = true }: { scheduler?: boolean } = {}): Promise<Client> {
  core = await startCore({
    store,
    scheduler,
    dataDir: home.path,
    connections: createConnections({ store, secrets: createFileSecrets({ dir: join(home.path, "secrets") }) }),
    runtimes: [createFakeRuntime({ fixtures: juguete, speed: Infinity })],
    env: { CORE_RUNTIME: "fake" },
    coreVersion: "0.0.0",
    onShutdown: () => {},
  });
  return createClient({ url: core.server.url, token: core.server.token, origin: "cli" });
}

async function toyProject(client: Client, parallel = 2) {
  const repoId = createRepos({ store }).add({ name: "demo", path: repo.dir });
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

test("con el Scheduler apagado, system.setLanes no lanza la cola", async () => {
  const client = await boot({ scheduler: false });
  const project = await toyProject(client);
  await client.issues.createLocal({ projectId: project.id, title: "Una" });

  await client.system.setLanes({ dev: 5 });
  // Cerrar el core espera el tick en curso, si alguno se pidió: lo que haya lanzado ya está en los eventos.
  await core?.close();
  core = undefined;

  expect(eventsOf(["run.started"])).toEqual([]);
});

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

  test("una issue bloqueada por dos PRs en ramas distintas sale de la base combinada de los dos", async () => {
    repo.cleanup();
    repo = tempGitRepo({
      commits: [{ message: "chore: base", files: { "a.txt": "a\n", "b.txt": "b\n" } }],
      branches: { "cla-1": [{ message: "feat: uno", files: { "a.txt": "uno\n" } }], "cla-2": [{ message: "feat: dos", files: { "b.txt": "dos\n" } }] },
    });
    const client = await boot();
    const project = await toyProject(client, 2);
    // Pausado mientras se arma la cola: si no, la issue se lanzaría antes de que existan sus padres.
    await client.projects.update({ id: project.id, status: "paused" });
    const local = createLocalTracker({ store });
    const [one, two] = [await local.createIssue(project.id, { title: "uno", status: "in_progress" }), await local.createIssue(project.id, { title: "dos", status: "in_progress" })];
    const child = await client.issues.createLocal({ projectId: project.id, title: "Con dos padres" });
    await local.relate(one.ref, "blocks", child.ref);
    await local.relate(two.ref, "blocks", child.ref);
    await createIssues({ store, local }).sync(local, { projectId: project.id, project: { tracker: "local", id: project.id } }, "cli");
    const repoId = createRepos({ store }).list()[0]!.id;
    for (const [i, parent] of [one, two].entries()) {
      const issueId = createIssues({ store, local }).list({ projectId: project.id }).find((issue) => issue.ref.id === parent.ref.id)!.id;
      seedPr(store, { repoId, number: 20 + i, headRef: `cla-${i + 1}`, headSha: "abc", isDraft: true, issueId });
    }

    await client.projects.update({ id: project.id, status: "active", stackOn: "any_open", repos: [{ repoId, labels: [] }] });

    const branch = combinedBaseBranch(child.ref.key);
    await until(async () => {
      expect(await client.runs.list({ projectId: project.id })).toMatchObject([{ subject: { id: child.id }, status: "done", params: { base: branch } }]);
    });
    // La branch de la issue sale de la base sintética: trae los dos padres, y la base quedó registrada.
    const { branch: issueBranch } = store.db.$client.prepare("SELECT branch FROM workspaces").get() as { branch: string };
    expect(repo.git("merge-base", "--is-ancestor", "cla-1", issueBranch)).toBe("");
    expect(repo.git("merge-base", "--is-ancestor", "cla-2", issueBranch)).toBe("");
    expect(store.db.$client.prepare("SELECT status FROM combined_bases WHERE branch = ?").all(branch)).toEqual([{ status: "active" }]);
  });

  test("una issue espera con tope 0 y sale de la branch del PR local al permitir el primer piso", async () => {
    repo.cleanup();
    repo = tempGitRepo({
      branches: { "cla-1-padre": [{ message: "feat: padre", files: { "padre.txt": "padre\n" } }] },
    });
    const client = await boot();
    const project = await toyProject(client);
    const parent = await client.issues.createLocal({ projectId: project.id, title: "Padre" });
    await until(async () => {
      expect(await client.runs.list({ projectId: project.id })).toMatchObject([{ subject: { id: parent.id }, status: "done", outcome: "done" }]);
    });
    await client.projects.update({ id: project.id, status: "paused" });
    const repoId = createRepos({ store }).list()[0]!.id;
    seedPr(store, {
      repoId,
      number: null,
      state: "local",
      headRef: "cla-1-padre",
      headSha: repo.git("rev-parse", "cla-1-padre"),
      issueId: parent.id,
      title: "feat: padre",
    });
    const child = await client.issues.createLocal({ projectId: project.id, title: "Hijo" });
    await createLocalTracker({ store }).relate(parent.ref, "blocks", child.ref);

    await client.projects.update({ id: project.id, status: "active", maxStackDepth: 0, repos: [{ repoId, labels: [] }] });
    await until(async () => {
      expect(await client.projects.queue({ id: project.id })).toMatchObject([{ issue: { id: child.id }, state: "waiting", reason: expect.stringContaining("no apila PRs") }]);
    });
    await expect(client.runs.start({ projectId: project.id, issueId: child.id })).rejects.toThrow(/no apila PRs/);
    expect(eventsOf(["issue.claimed"]).map((e) => e.payload.issueId)).not.toContain(child.id);
    await client.projects.update({ id: project.id, maxStackDepth: 1 });

    await until(async () => {
      const runs = await client.runs.list({ projectId: project.id });
      expect(runs.find((run) => run.subject.id === child.id)).toMatchObject({
        status: "done",
        outcome: "done",
        params: { base: "cla-1-padre" },
      });
    });
    const { branch } = store.db.$client.prepare("SELECT branch FROM workspaces WHERE base_ref = ?").get("cla-1-padre") as { branch: string };
    expect(repo.git("merge-base", "--is-ancestor", "cla-1-padre", branch)).toBe("");
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

  test("system.setLanes y projects.update({ parallel }) cambian los cupos y rigen de inmediato", async () => {
    const client = await boot();
    const project = await toyProject(client, 1);

    expect(await client.system.lanes()).toEqual({ dev: { active: 0, capacity: 4 }, maintenance: { active: 0, capacity: 2 } });
    expect(await client.system.setLanes({ maintenance: 3 })).toEqual({ dev: { active: 0, capacity: 4 }, maintenance: { active: 0, capacity: 3 } });
    expect((await client.system.lanes()).maintenance.capacity).toBe(3);
    await expect(client.system.setLanes({ dev: 0 })).rejects.toThrow();

    expect(await client.projects.update({ id: project.id, parallel: 3 })).toMatchObject({ parallel: 3 });
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
  async function twoRepoProject(client: Client, opts: { names?: [string, string]; flowParams?: (front: string) => Record<string, unknown> } = {}) {
    const repos = createRepos({ store });
    const [frontName, backName] = opts.names ?? ["front", "back"];
    const front = repos.add({ name: frontName, path: repo.dir });
    const back = repos.add({ name: backName, path: other.dir });
    const project = await client.projects.create({
      slug: "demo",
      name: "Demo",
      tracker: "local",
      defaultFlowId: "juguete",
      defaultProfileId: "juguete",
      repos: [{ repoId: front, labels: ["frontend"] }, { repoId: back, labels: ["backend"] }],
      flowParams: opts.flowParams?.(front) ?? {},
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

  test("una issue de dos repos con base combinada en cada uno corre en los dos y el tick sigue con el resto", async () => {
    const files = { "a.txt": "a\n", "b.txt": "b\n" };
    repo.cleanup();
    other.cleanup();
    repo = tempGitRepo({
      commits: [{ message: "chore: base", files }],
      branches: { "cla-1": [{ message: "feat: uno", files: { "a.txt": "uno\n" } }], "cla-2": [{ message: "feat: dos", files: { "b.txt": "dos\n" } }] },
    });
    other = tempGitRepo({
      commits: [{ message: "chore: base", files }],
      branches: { "cla-3": [{ message: "feat: tres", files: { "a.txt": "tres\n" } }], "cla-4": [{ message: "feat: cuatro", files: { "b.txt": "cuatro\n" } }] },
    });
    const client = await boot();
    const { project, front, back } = await twoRepoProject(client);
    await client.projects.update({ id: project.id, status: "paused" });
    const local = createLocalTracker({ store });
    const blockers = [];
    for (const title of ["uno", "dos", "tres", "cuatro"]) blockers.push(await local.createIssue(project.id, { title, status: "in_progress" }));
    const both = await client.issues.createLocal({ projectId: project.id, title: "Cruza con dos padres en cada repo", labels: ["backend", "frontend"] });
    const free = await client.issues.createLocal({ projectId: project.id, title: "Libre", labels: ["backend"] });
    for (const blocker of blockers) await local.relate(blocker.ref, "blocks", both.ref);
    const cache = createIssues({ store, local });
    await cache.sync(local, { projectId: project.id, project: { tracker: "local", id: project.id } }, "cli");
    // Dos PRs abiertos de los bloqueantes en cada repo: la issue sale de una base combinada en los dos.
    for (const [i, blocker] of blockers.entries()) {
      const issueId = cache.list({ projectId: project.id }).find((issue) => issue.ref.id === blocker.ref.id)!.id;
      seedPr(store, { repoId: i < 2 ? front : back, number: 20 + i, headRef: `cla-${i + 1}`, headSha: "abc", isDraft: true, issueId });
    }

    await client.projects.update({ id: project.id, status: "active", stackOn: "any_open" });

    const branch = combinedBaseBranch(both.ref.key);
    await until(async () => {
      const runs = (await client.runs.list({ projectId: project.id })).filter((r) => r.subject.id === both.id);
      expect(runs.map((r) => [r.params.repo, r.params.base, r.status]).sort()).toEqual(
        [[front, branch, "done"], [back, branch, "done"]].sort(),
      );
      expect((await client.runs.list({ projectId: project.id })).find((r) => r.subject.id === free.id)?.status).toBe("done");
    });
    expect(store.db.$client.prepare("SELECT repo_id, status FROM combined_bases WHERE branch = ? ORDER BY repo_id").all(branch)).toEqual(
      [{ repo_id: front, status: "active" }, { repo_id: back, status: "active" }].sort((a, b) => a.repo_id.localeCompare(b.repo_id)),
    );
  });

  test("una issue ambigua deja una decisión con los repos y corre en el que se elige", async () => {
    const client = await boot();
    const { project, back } = await twoRepoProject(client);

    const issue = await client.issues.createLocal({ projectId: project.id, title: "No se sabe", labels: ["otro"] });

    const [question] = await vi.waitFor(async () => {
      const pending = await client.decisions.list({ projectId: project.id, status: ["pending"] });
      expect(pending).toHaveLength(1);
      return pending;
    }, WAIT);
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

  test("un repo fijado en los flowParams del proyecto no saca a la issue de los repos de sus labels", async () => {
    const client = await boot();
    const { project, front, back } = await twoRepoProject(client, { flowParams: (front) => ({ repo: front }) });

    const both = await client.issues.createLocal({ projectId: project.id, title: "Cruza", labels: ["backend", "frontend"] });

    // Si el flowParam pisara al repo de la cadena, cada corrida caería en front y la issue volvería a la cola sin fin.
    await until(async () => {
      expect(await client.projects.queue({ id: project.id })).toEqual([]);
      expect((await client.runs.list({ projectId: project.id })).map((r) => r.status)).toEqual(["done", "done"]);
    });
    const runs = (await client.runs.list({ projectId: project.id })).sort((a, b) => a.startedAt - b.startedAt);
    expect(runs.map((r) => [r.subject.id, r.params.repo])).toEqual([[both.id, front], [both.id, back]]);
  });

  test("con dos repos del mismo nombre la pregunta los distingue y la issue corre en el elegido", async () => {
    const client = await boot();
    const { project, front, back } = await twoRepoProject(client, { names: ["app", "app"] });

    const issue = await client.issues.createLocal({ projectId: project.id, title: "No se sabe", labels: ["otro"] });

    const [question] = await vi.waitFor(async () => {
      const pending = await client.decisions.list({ projectId: project.id, status: ["pending"] });
      expect(pending).toHaveLength(1);
      return pending;
    }, WAIT);
    expect(question!.options).toEqual([`app (${front})`, `app (${back})`]);
    await client.decisions.resolve({ id: question!.id, option: `app (${back})` });

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
  const issues = createIssues({ store, local: createLocalTracker({ store }) });
  return (await issues.createLocal({ projectId, title: "Pendiente" }, "cli")).id;
}
