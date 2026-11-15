import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Client, type Event } from "@clanker/api";
import { createConnections, createFileSecrets, createProcs, createRepos, newId, openStore, startCore, type Core, type Store } from "@clanker/core";
import { ORPCError } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createFakeRuntime } from "./fake-runtime";
import { tempGitRepo, type TempGitRepo } from "./git";
import { seedDb, type TestHome } from "./home";

// El core armado como en producción (Flows, Workspaces, Agents y la API) pero con el runtime fake en
// lugar de Claude. Vive aquí porque el core no puede importar el testkit.

const juguete = fileURLToPath(new URL("../fixtures/runs/juguete", import.meta.url));

let home: TestHome;
let store: Store;
let repo: TempGitRepo;
let core: Core | undefined;
let aborts: AbortController[];

beforeEach(() => {
  home = seedDb("empty");
  store = openStore({ path: home.dbPath });
  repo = tempGitRepo({});
  aborts = [];
});

afterEach(async () => {
  for (const abort of aborts) abort.abort();
  await core?.close();
  core = undefined;
  store.close();
  repo.cleanup();
  home.cleanup();
});

async function boot(env: Record<string, string> = { CORE_RUNTIME: "fake" }): Promise<Client> {
  core = await startCore({
    store,
    dataDir: home.path,
    connections: createConnections(store, createFileSecrets({ dir: join(home.path, "secrets") })),
    runtimes: [createFakeRuntime({ fixtures: juguete, speed: Infinity })],
    env,
    scheduler: false,
    coreVersion: "0.0.0",
    onShutdown: () => {},
  });
  return createClient({ url: core.server.url, token: core.server.token, origin: "cli" });
}

/** Un proyecto local con la plantilla `juguete` por defecto, apuntando al repo temporal. */
async function createToyProject(client: Client, flowParams: Record<string, unknown>) {
  return client.projects.create({
    slug: "demo",
    name: "Demo",
    tracker: "local",
    defaultFlowId: "juguete",
    defaultProfileId: "juguete",
    flowParams,
  });
}

/** Los eventos de `types` del proyecto, en vivo, desde ahora. */
async function follow(client: Client, projectId: Event["projectId"], types: Event["type"][]) {
  const abort = new AbortController();
  aborts.push(abort);
  const stream = await client.events.stream({ filter: { projectId, types } }, { signal: abort.signal });
  return async () => {
    const next = await stream.next();
    if (next.done) throw new Error("el stream terminó sin entregar el evento esperado");
    return next.value;
  };
}

describe("runs sobre el runtime fake", () => {
  test("crea un proyecto y una issue local, lanza la corrida y recibe run.finished con outcome done", async () => {
    const client = await boot();
    const repoId = createRepos(store).add({ name: "demo", path: repo.dir });
    const project = await createToyProject(client, { repo: repoId });
    const issue = await client.issues.createLocal({ projectId: project.id, title: "Saluda" });
    const nextFinished = await follow(client, project.id, ["run.finished"]);

    const started = await client.runs.start({ projectId: project.id, issueId: issue.id });
    const finished = await nextFinished();

    expect(started).toMatchObject({
      projectId: project.id,
      flow: { slug: "juguete", version: 1 },
      subject: { type: "issue", id: issue.id },
      lane: "dev",
    });
    expect(finished).toMatchObject({ runId: started.id, origin: "core", payload: { outcome: "done" } });
    expect(await client.runs.list({ projectId: project.id })).toMatchObject([
      { id: started.id, status: "done", outcome: "done" },
    ]);
    expect((await client.system.health()).activeRuns).toBe(0);
  });

  test("runs.get devuelve los pasos con su outcome y el costo, y el worktree queda suelto", async () => {
    const client = await boot();
    const repoId = createRepos(store).add({ name: "demo", path: repo.dir });
    const project = await createToyProject(client, { repo: repoId });
    const issue = await client.issues.createLocal({ projectId: project.id, title: "Saluda" });
    const nextFinished = await follow(client, project.id, ["run.finished"]);

    const { id } = await client.runs.start({ projectId: project.id, issueId: issue.id });
    await nextFinished();
    const run = await client.runs.get({ id });

    expect(run).toMatchObject({ status: "done", outcome: "done", params: { repo: repoId, base: "main" }, endedAt: expect.any(Number) });
    expect(run.steps.map((s) => [s.nodeId, s.status, s.outcome])).toEqual([
      ["acquire", "done", "ok"],
      ["saludar", "done", "ok"],
      ["release", "done", "ok"],
    ]);
    // 0.0125 USD en micros, todo en el paso del agente.
    expect(run.steps.map((s) => s.costMicros)).toEqual([0, 12_500, 0]);
    expect(run.costMicros).toBe(12_500);
    expect(run.steps.every((s) => s.outputHash !== null || s.nodeId === "release")).toBe(true);

    const lease = store.events.since(0, { runId: id, types: ["lease.acquired", "lease.released"] });
    expect(lease.map((e) => e.type)).toEqual(["lease.acquired", "lease.released"]);

    // Lo que la UI necesita para dibujar la corrida: su flujo, el worktree que tomó y lo que consumió.
    expect(run.flowDef).toMatchObject({ id: "juguete", start: "acquire" });
    expect(run.workspace).toEqual({ repo: "demo", branch: issue.id, base: "main" });
    expect(run.usage).toMatchObject({ input: expect.any(Number), output: expect.any(Number) });
    expect(run.usage.input + run.usage.output).toBeGreaterThan(0);
    expect(run.steps.every((s) => s.startedAt !== null && s.endedAt !== null)).toBe(true);
  });

  test("sin repos en el proyecto ni en sus flowParams, runs.start es BAD_REQUEST, no crea la corrida y no reclama la issue", async () => {
    const client = await boot();
    const project = await createToyProject(client, {});
    const issue = await client.issues.createLocal({ projectId: project.id, title: "Saluda" });

    await expect(client.runs.start({ projectId: project.id, issueId: issue.id })).rejects.toSatisfy(
      (e) => e instanceof ORPCError && e.code === "BAD_REQUEST" && /no tiene ninguno: regístralo con repos\.add/.test(e.message),
    );
    expect(await client.runs.list({})).toEqual([]);
    expect(await client.issues.get({ id: issue.id })).toMatchObject({ status: "todo" });
  });
});

describe("runs.start con los repos del proyecto", () => {
  /** Un repo temporal con `branch` además de `main`; `cleanup` al final del test. */
  const extraRepos: TempGitRepo[] = [];
  afterEach(() => {
    for (const extra of extraRepos.splice(0)) extra.cleanup();
  });
  function extraRepo(opts: Parameters<typeof tempGitRepo>[0] = {}) {
    const extra = tempGitRepo(opts);
    extraRepos.push(extra);
    return extra;
  }

  test("reclama la issue y arranca con el repo que mandan sus labels y su branch por defecto como base", async () => {
    const client = await boot();
    const back = await client.repos.add({ path: repo.dir, name: "back" });
    const web = extraRepo();
    web.git("branch", "-m", "main", "master");
    const front = await client.repos.add({ path: web.dir, name: "front" });
    const project = await client.projects.create({
      slug: "demo",
      name: "Demo",
      tracker: "local",
      defaultFlowId: "juguete",
      defaultProfileId: "juguete",
      repos: [
        { repoId: back.id, labels: ["backend"] },
        { repoId: front.id, labels: ["frontend"] },
      ],
    });
    const frontend = await client.issues.createLocal({ projectId: project.id, title: "Botón", labels: ["frontend"] });
    const untagged = await client.issues.createLocal({ projectId: project.id, title: "Sin label" });
    const nextClaimed = await follow(client, project.id, ["issue.claimed"]);

    const run = await client.runs.start({ projectId: project.id, issueId: frontend.id });
    const fallback = await client.runs.start({ projectId: project.id, issueId: untagged.id });

    expect(run.params).toEqual({ repo: front.id, base: "master" });
    expect(fallback.params).toEqual({ repo: back.id, base: "main" });
    expect(await nextClaimed()).toMatchObject({ subject: { type: "issue", id: frontend.id }, payload: { issueId: frontend.id } });
    expect(await client.issues.get({ id: frontend.id })).toMatchObject({
      status: "in_progress",
      assignee: { id: expect.any(String) },
    });
  });

  test("los flowParams del proyecto pisan los defaults del flujo y lo que pasa quien lanza pisa a los dos", async () => {
    const client = await boot();
    const target = extraRepo({ branches: { release: [{ message: "chore: release" }], staging: [{ message: "chore: staging" }] } });
    const registered = await client.repos.add({ path: target.dir });
    const project = await client.projects.create({
      slug: "demo",
      name: "Demo",
      tracker: "local",
      defaultFlowId: "juguete",
      defaultProfileId: "juguete",
      repos: [{ repoId: registered.id }],
      flowParams: { base: "release" },
    });
    const first = await client.issues.createLocal({ projectId: project.id, title: "Una" });
    const second = await client.issues.createLocal({ projectId: project.id, title: "Otra" });

    const byProject = await client.runs.start({ projectId: project.id, issueId: first.id });
    const byCaller = await client.runs.start({ projectId: project.id, issueId: second.id, params: { base: "staging" } });

    // El default del flujo es `main`: el flowParams del proyecto lo pisa.
    expect(byProject.params).toEqual({ repo: registered.id, base: "release" });
    expect(byCaller.params).toEqual({ repo: registered.id, base: "staging" });
  });

  test("un flowParam que el flujo por defecto no declara (la política de otro flujo) no rompe runs.start", async () => {
    const client = await boot();
    const registered = await client.repos.add({ path: repo.dir });
    const project = await createToyProject(client, { rebaseNonDraft: "ask" });
    await client.projects.update({ id: project.id, repos: [{ repoId: registered.id }] });
    const issue = await client.issues.createLocal({ projectId: project.id, title: "Saluda" });

    const run = await client.runs.start({ projectId: project.id, issueId: issue.id });

    expect(run.params).not.toHaveProperty("rebaseNonDraft");
  });

  test("lanzar dos veces la misma issue devuelve la misma corrida", async () => {
    const client = await boot();
    const registered = await client.repos.add({ path: repo.dir });
    const project = await createToyProject(client, {});
    await client.projects.update({ id: project.id, repos: [{ repoId: registered.id }] });
    const issue = await client.issues.createLocal({ projectId: project.id, title: "Saluda" });

    const first = await client.runs.start({ projectId: project.id, issueId: issue.id });
    const again = await client.runs.start({ projectId: project.id, issueId: issue.id });

    expect(again.id).toBe(first.id);
    expect(await client.runs.list({ projectId: project.id })).toHaveLength(1);
  });

  test("si el tracker no deja reclamar la issue, runs.start es BAD_REQUEST y no crea la corrida", async () => {
    const client = await boot();
    const registered = await client.repos.add({ path: repo.dir });
    const project = await createToyProject(client, { repo: registered.id });
    const issue = await client.issues.createLocal({ projectId: project.id, title: "Ajena" });
    store.db.$client.exec(`UPDATE local_issues SET assignee = '{"id":"otra","name":"Otra persona"}'`);

    await expect(client.runs.start({ projectId: project.id, issueId: issue.id })).rejects.toSatisfy(
      (e) => e instanceof ORPCError && e.code === "BAD_REQUEST" && /asignada a Otra persona/.test(e.message),
    );
    expect(await client.runs.list({})).toEqual([]);
  });
});

describe("projects.queue", () => {
  test("una issue ya lanzada sale de la cola, también cuando su corrida termina, y la otra sigue lista", async () => {
    const client = await boot();
    const repoId = createRepos(store).add({ name: "demo", path: repo.dir });
    const project = await createToyProject(client, { repo: repoId });
    const first = await client.issues.createLocal({ projectId: project.id, title: "Una", priority: 1 });
    const second = await client.issues.createLocal({ projectId: project.id, title: "Otra" });
    const nextFinished = await follow(client, project.id, ["run.finished"]);

    expect((await client.projects.queue({ id: project.id })).map((e) => [e.issue.id, e.state])).toEqual([
      [first.id, "ready"],
      [second.id, "ready"],
    ]);
    await client.runs.start({ projectId: project.id, issueId: first.id });
    await nextFinished();

    expect((await client.projects.queue({ id: project.id })).map((e) => [e.issue.id, e.state])).toEqual([[second.id, "ready"]]);
  });

  test("un proyecto que no existe es NOT_FOUND", async () => {
    const client = await boot();

    await expect(client.projects.queue({ id: "prj_00000000000000000000000000" })).rejects.toSatisfy(
      (e) => e instanceof ORPCError && e.code === "NOT_FOUND",
    );
  });
});

describe("arranque", () => {
  test("las plantillas juguete y techlead-clasico quedan instaladas como builtin y arrancar de nuevo no suma versiones", async () => {
    await boot();
    const versions = store.events.since(0, { types: ["def.versioned"] }).length;
    await core?.close();
    core = undefined;
    await boot();

    expect(store.events.since(0, { types: ["def.versioned"] })).toHaveLength(versions);
    expect(store.db.$client.prepare("SELECT slug FROM defs WHERE kind = 'flow' AND scope = 'builtin' ORDER BY slug").all()).toEqual([
      { slug: "juguete" },
      { slug: "pr-feedback" },
      { slug: "rebase-conflicto" },
      { slug: "restack" },
      { slug: "restack-feedback" },
      { slug: "restack-rewritten" },
      { slug: "techlead-clasico" },
    ]);
  });

  test("al devolverse un sujeto prestado, la dueña relee el head_sha de su worktree", async () => {
    await boot();
    const owner = newId("run");
    const borrower = newId("run");
    store.db.$client
      .prepare(
        "INSERT INTO workspaces (id, repo_id, path, branch, base_ref, head_sha, state, holder_run_id, fencing_token) VALUES ('wsp_1', 'demo', ?, 'main', 'main', 'viejo', 'leased', ?, 3)",
      )
      .run(repo.dir, owner);

    store.tx((tx) => tx.emit({ type: "run.returned", origin: "core", runId: borrower, payload: { runId: borrower, fromRunId: owner } }));

    await vi.waitFor(() => expect(store.db.$client.prepare("SELECT head_sha FROM workspaces").get()).toEqual({ head_sha: repo.git("rev-parse", "HEAD") }));
  });

  test("al arrancar despacha los pasos pending que dejó el core anterior", async () => {
    let client = await boot();
    const repoId = createRepos(store).add({ name: "demo", path: repo.dir });
    const project = await createToyProject(client, { repo: repoId });
    const issue = await client.issues.createLocal({ projectId: project.id, title: "Saluda" });
    const nextRetry = await follow(client, project.id, ["step.retrying"]);
    // Sin la carpeta del repo, workspace.acquire falla y el paso queda pending con su backoff.
    renameSync(repo.dir, `${repo.dir}-away`);
    const { id } = await client.runs.start({ projectId: project.id, issueId: issue.id });
    await nextRetry();
    await core?.close();
    core = undefined;
    renameSync(`${repo.dir}-away`, repo.dir);
    // El backoff ya venció cuando arranca el core siguiente.
    store.db.$client.exec(`UPDATE step_runs SET not_before = 0 WHERE run_id = '${id}'`);

    client = await boot();
    const nextFinished = await follow(client, project.id, ["run.finished"]);

    expect(await nextFinished()).toMatchObject({ runId: id, payload: { outcome: "done" } });
  });

  test("carga los packs de <dataDir>/packs y un pack roto deja un evento error sin impedir el arranque", async () => {
    mkdirSync(join(home.path, "packs", "bueno"), { recursive: true });
    writeFileSync(join(home.path, "packs", "bueno", "pack.json"), JSON.stringify({ id: "bueno", version: 1, activate: { githubOrgs: ["acme"] } }));
    mkdirSync(join(home.path, "packs", "roto"), { recursive: true });
    writeFileSync(join(home.path, "packs", "roto", "pack.json"), "{ no es json");

    await boot();

    expect(store.db.$client.prepare("SELECT slug FROM defs WHERE kind = 'pack'").all()).toEqual([{ slug: "bueno" }]);
    expect(store.events.since(0, { types: ["error"] })).toMatchObject([
      { origin: "core", payload: { scope: "packs.load", message: expect.stringContaining("roto") } },
    ]);
  });

  test("CORE_RUNTIME que no está registrado hace fallar el arranque diciendo cuáles hay", async () => {
    await expect(boot({ CORE_RUNTIME: "claude-sdk" })).rejects.toThrow(/CORE_RUNTIME="claude-sdk".*\(fake\)/);
    await expect(boot({})).rejects.toThrow(/CORE_RUNTIME="claude-sdk"/);
  });
});

describe("recuperación al arrancar", () => {
  test("un corte con el agente en curso: el core nuevo reabre el paso, conserva el worktree y termina la corrida", async () => {
    const client = await boot();
    const repoId = createRepos(store).add({ name: "demo", path: repo.dir });
    const project = await createToyProject(client, { repo: repoId });
    const issue = await client.issues.createLocal({ projectId: project.id, title: "Saluda" });
    const nextFinished = await follow(client, project.id, ["run.finished"]);
    const { id } = await client.runs.start({ projectId: project.id, issueId: issue.id });
    await nextFinished();
    await core?.close();
    core = undefined;

    // Lo que dejaría un crash con el agente de `saludar` en curso: el paso sigue `running` de otro boot,
    // `release` no llegó a existir y el worktree sigue tomado por la corrida con su lease vencido.
    store.tx(({ db }) => {
      const sqlite = db.$client;
      sqlite.prepare("UPDATE runs SET status = 'running', outcome = NULL, ended_at = NULL WHERE id = ?").run(id);
      sqlite.prepare("DELETE FROM step_runs WHERE run_id = ? AND node_id = 'release'").run(id);
      sqlite
        .prepare("UPDATE step_runs SET status = 'running', owner = 'boot_dead', outcome = NULL, output_hash = NULL WHERE run_id = ? AND node_id = 'saludar'")
        .run(id);
      sqlite.prepare("UPDATE workspaces SET state = 'leased', holder_run_id = ?, lease_until = 0").run(id);
    });

    await boot();

    await vi.waitFor(() => expect(store.events.since(0, { runId: id, types: ["run.finished"] })).toHaveLength(2));
    const restarted = await createClient({ url: core!.server.url, token: core!.server.token, origin: "cli" }).runs.get({ id });
    expect(restarted).toMatchObject({ status: "done", outcome: "done" });
    expect(restarted.steps.map((s) => [s.nodeId, s.status, s.outcome, s.attempt])).toEqual([
      ["acquire", "done", "ok", 1],
      ["saludar", "done", "ok", 2],
      ["release", "done", "ok", 1],
    ]);
    expect(store.events.since(0, { types: ["core.recovered"] })).toMatchObject([{ origin: "core", payload: { steps: 1, leases: 1, orphans: 0 } }]);
  });

  test("mata los procesos que dejó un core anterior antes de aceptar trabajo", async () => {
    const orphan = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    const dead = new Promise((resolve) => orphan.once("exit", (_code, signal) => resolve(signal)));
    createProcs({ store, bootId: "boot_dead" }).track(orphan, { kind: "agent" });

    await boot();

    expect(await dead).toBe("SIGKILL");
    expect(store.events.since(0, { types: ["core.recovered"] })).toMatchObject([{ payload: { steps: 0, leases: 0, orphans: 1 } }]);
  });

  test("un arranque sin nada que recuperar no deja evento", async () => {
    await boot();

    expect(store.events.since(0, { types: ["core.recovered"] })).toEqual([]);
  });
});
