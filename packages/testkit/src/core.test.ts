import { renameSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Client, type Event } from "@clanker/api";
import { createFileSecrets, createProcs, createRepos, openStore, startCore, type Core, type Store } from "@clanker/core";
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
    secrets: createFileSecrets({ dir: join(home.path, "secrets") }),
    runtimes: [createFakeRuntime({ fixtures: juguete, speed: Infinity })],
    env,
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
  });

  test("sin el repo en los params del proyecto, runs.start es BAD_REQUEST y no crea la corrida", async () => {
    const client = await boot();
    const project = await createToyProject(client, {});
    const issue = await client.issues.createLocal({ projectId: project.id, title: "Saluda" });

    await expect(client.runs.start({ projectId: project.id, issueId: issue.id })).rejects.toSatisfy(
      (e) => e instanceof ORPCError && e.code === "BAD_REQUEST" && /Falta el param "repo"/.test(e.message),
    );
    expect(await client.runs.list({})).toEqual([]);
  });
});

describe("arranque", () => {
  test("la plantilla juguete queda instalada como builtin y arrancar de nuevo no suma versiones", async () => {
    await boot();
    await core?.close();
    core = undefined;
    await boot();

    expect(store.events.since(0, { types: ["def.versioned"] })).toHaveLength(3);
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
