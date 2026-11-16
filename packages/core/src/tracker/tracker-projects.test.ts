import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NewProject } from "@clanker/api";
import { createRouterClient, ORPCError } from "@orpc/server";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createConnections, type Connections } from "../connections/connections";
import { startFakeLinear, type FakeLinear } from "../testing/linear/fake-linear";
import { createLinearTracker } from "../linear/tracker";
import { createDefs } from "../defs/defs";
import { createProjects, type Projects } from "../projects/projects";
import { createRouter } from "../server/router";
import { apiDeps, withPrs } from "../testing/router-deps";
import { createFileSecrets } from "../secrets/encrypted-file";
import { issues as issuesTable, projects as projectsTable, syncCursors } from "../store/schema";
import { openStore, type Store } from "../store/store";
import { createIssues } from "./issues";
import { createTrackerProjects, type TrackerProjects } from "./tracker-projects";

const CLIENT_ID = "test-client-id";

let dir: string;
let store: Store;
let linear: FakeLinear | undefined;
let connections: Connections;
let projects: TrackerProjects;
let clankerProjects: Projects;

async function connectWorkspace(workspace: string): Promise<FakeLinear> {
  const fake = await startFakeLinear({ clientId: CLIENT_ID, workspace });
  const conns = createConnections(store, createFileSecrets({ dir: join(dir, "secrets") }), {
    linear: { clientId: CLIENT_ID, redirectPort: 0, endpoints: fake.endpoints },
  });
  const { url, done } = await conns.linearAuth("ui");
  const authorize = await fetch(url, { redirect: "manual" });
  await fetch(authorize.headers.get("location")!);
  await done;
  connections = conns;
  return fake;
}

beforeEach(() => {
  linear = undefined;
  dir = mkdtempSync(join(tmpdir(), "clanker-tracker-projects-"));
  store = openStore({ path: join(dir, "clanker.db") });
  clankerProjects = createProjects({ store, defs: createDefs(store) });
  projects = createTrackerProjects({
    connections: { list: () => connections.list() },
    linear: (account) => createLinearTracker({ connections, account, endpoint: linear!.endpoints.graphql }),
    projects: clankerProjects,
  });
});

afterEach(async () => {
  await linear?.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("lista los proyectos de Linear con su workspace, los de la persona primero y luego por nombre", async () => {
  const fake = await connectWorkspace("acme");
  linear = fake;
  const w = fake.workspace;
  w.addProject("Zeta", { lead: w.viewer });
  w.addProject("Alfa");
  w.addProject("Beta", { members: [w.viewer] });

  const listed = await projects.list("linear");

  expect(listed.map((p) => [p.name, p.mine, p.account])).toEqual([
    ["Beta", true, "acme"],
    ["Zeta", true, "acme"],
    ["Alfa", false, "acme"],
  ]);
  expect(listed[0]!.ref).toEqual({ tracker: "linear", id: expect.any(String) });
});

test("sin Linear conectado el error manda a Conexiones", async () => {
  connections = createConnections(store, createFileSecrets({ dir: join(dir, "secrets") }), {});

  await expect(projects.list("linear")).rejects.toThrow(/conéctalo en Conexiones/);
});

test("un tracker sin adapter para listar dice que se escriba el id", async () => {
  connections = createConnections(store, createFileSecrets({ dir: join(dir, "secrets") }), {});

  await expect(projects.list("jira")).rejects.toThrow(/jira/);
});

test("trackers.projects traduce esos errores a BAD_REQUEST", async () => {
  connections = createConnections(store, createFileSecrets({ dir: join(dir, "secrets") }), {});
  const router = createRouter(withPrs({
    store,
    connections,
    issues: createIssues(store),
    ...apiDeps(store, "/tmp/clanker"),
    trackerProjects: projects,
    coreVersion: "0",
    bootId: "boot",
    startedAt: 0,
    dataDir: "/tmp/clanker",
    onShutdown: () => {},
  }));
  const client = createRouterClient(router, { context: { origin: "ui" } });

  const error = await client.trackers.projects({ tracker: "linear" }).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ORPCError);
  expect(error).toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("Conexiones") });
});

test("resolve convierte slugId, identificador y URL del proyecto en su UUID, y deja pasar un UUID sin consultar", async () => {
  const fake = await connectWorkspace("acme");
  linear = fake;
  const project = fake.workspace.addProject("Facturación", { identifier: "P-ENG-1525" });

  expect(await projects.resolve("linear", "P-ENG-1525")).toBe(project.id);
  expect(await projects.resolve("linear", project.slugId)).toBe(project.id);
  expect(await projects.resolve("linear", `https://linear.app/acme/project/facturacion-${project.slugId}/overview`)).toBe(project.id);
  const before = fake.workspace.operations.length;
  expect(await projects.resolve("linear", project.id)).toBe(project.id);
  expect(fake.workspace.operations).toHaveLength(before);
  expect(await projects.resolve("jira", "PROJ")).toBe("PROJ");
});

test("resolve de un proyecto que ningún workspace tiene dice cómo seguir", async () => {
  linear = await connectWorkspace("acme");

  await expect(projects.resolve("linear", "P-XX-1")).rejects.toThrow(/No encontré el proyecto "P-XX-1" en Linear \(acme\)/);
});

test("projects.create y projects.update guardan el UUID aunque se pida con el identificador", async () => {
  const fake = await connectWorkspace("acme");
  linear = fake;
  const project = fake.workspace.addProject("Facturación", { identifier: "P-ENG-1525" });
  const other = fake.workspace.addProject("Otro");
  const router = createRouter(withPrs({
    store,
    connections,
    issues: createIssues(store),
    ...apiDeps(store, "/tmp/clanker"),
    trackerProjects: projects,
    coreVersion: "0",
    bootId: "boot",
    startedAt: 0,
    dataDir: "/tmp/clanker",
    onShutdown: () => {},
  }));
  const client = createRouterClient(router, { context: { origin: "ui" } });

  const created = await client.projects.create({ slug: "facturacion", name: "Facturación", tracker: "linear", trackerRef: "P-ENG-1525" });
  expect(created.trackerRef).toBe(project.id);
  const updated = await client.projects.update({ id: created.id, trackerRef: other.slugId });
  expect(updated.trackerRef).toBe(other.id);
  const error = await client.projects.create({ slug: "x", name: "X", tracker: "linear", trackerRef: "P-NOPE-1" }).catch((e: unknown) => e);
  expect(error).toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("No encontré el proyecto") });
});

/** Un proyecto de Linear guardado con el identificador visible, con sus issues en el caché y su cursor de sync (lo que dejó una versión anterior). */
async function legacyProject(fake: FakeLinear, identifier: string) {
  const w = fake.workspace;
  const linearProject = w.addProject("Facturación", { identifier });
  const team = w.addTeam("ENG", [{ name: "Todo", type: "unstarted" }]);
  w.addIssue({ team, title: "una", project: linearProject });
  w.addIssue({ team, title: "otra", project: linearProject });
  const created = clankerProjects.create(NewProject.parse({ slug: "facturacion", name: "Facturación", tracker: "linear", trackerRef: linearProject.id }), "ui");
  const tracker = createLinearTracker({ connections, endpoint: fake.endpoints.graphql });
  const issues = createIssues(store);
  await issues.sync(tracker, { projectId: created.id, project: { tracker: "linear", id: linearProject.id } });
  store.db.update(syncCursors).set({ key: `issues:linear:${identifier}` }).run();
  store.tx((tx) => tx.db.update(projectsTable).set({ trackerRef: identifier }).run());
  return { linearProject, id: created.id, issues };
}

test("binding normaliza un trackerRef con el identificador al UUID sin perder las issues ni el cursor", async () => {
  const fake = await connectWorkspace("acme");
  linear = fake;
  const { linearProject, id, issues } = await legacyProject(fake, "P-ENG-1525");
  const cursor = store.db.select().from(syncCursors).get()!.cursor;
  const events: string[] = [];
  store.events.subscribe(({ payload }) => events.push(JSON.stringify(payload)), { types: ["project.updated"] });

  const binding = await projects.binding(clankerProjects.get(id)!);

  expect(binding).toEqual({ projectId: id, project: { tracker: "linear", id: linearProject.id } });
  expect(clankerProjects.get(id)!.trackerRef).toBe(linearProject.id);
  expect(issues.list({ projectId: id })).toHaveLength(2);
  expect(store.db.select().from(issuesTable).all()).toHaveLength(2);
  expect(store.db.select().from(syncCursors).all()).toEqual([expect.objectContaining({ key: `issues:linear:${linearProject.id}`, cursor })]);
  expect(events).toEqual([expect.stringContaining('"trackerRef"')]);
  // Ya normalizado: no vuelve a consultar a Linear.
  const before = fake.workspace.operations.length;
  await projects.binding(clankerProjects.get(id)!);
  expect(fake.workspace.operations).toHaveLength(before);
});

test("normalize sin poder leer Linear dice qué hacer y no toca el proyecto", async () => {
  const fake = await connectWorkspace("acme");
  linear = fake;
  const { id } = await legacyProject(fake, "P-ENG-1525");
  connections = createConnections(store, createFileSecrets({ dir: join(dir, "secrets2") }), {});

  await expect(projects.normalize(id, "core")).rejects.toThrow(/guarda "P-ENG-1525".*no pude resolverlo.*Conexiones.*Ajustes/);
  expect(clankerProjects.get(id)!.trackerRef).toBe("P-ENG-1525");
});

test("projects.update permite elegir de nuevo el mismo proyecto de Linear aunque haya issues, y rechaza otro", async () => {
  const fake = await connectWorkspace("acme");
  linear = fake;
  const { linearProject, id } = await legacyProject(fake, "P-ENG-1525");
  const other = fake.workspace.addProject("Otro");
  const router = createRouter(withPrs({
    store,
    connections,
    issues: createIssues(store),
    ...apiDeps(store, "/tmp/clanker"),
    trackerProjects: projects,
    coreVersion: "0",
    bootId: "boot",
    startedAt: 0,
    dataDir: "/tmp/clanker",
    onShutdown: () => {},
  }));
  const client = createRouterClient(router, { context: { origin: "ui" } });

  const rejected = await client.projects.update({ id, trackerRef: other.id }).catch((e: unknown) => e);
  expect(rejected).toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("crea un proyecto nuevo") });

  const updated = await client.projects.update({ id, trackerRef: linearProject.id });
  expect(updated.trackerRef).toBe(linearProject.id);
  expect(store.db.select().from(issuesTable).all()).toHaveLength(2);
});
