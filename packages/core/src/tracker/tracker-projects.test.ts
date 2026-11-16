import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouterClient, ORPCError } from "@orpc/server";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createConnections, type Connections } from "../connections/connections";
import { startFakeLinear, type FakeLinear } from "../linear/fake-linear";
import { createLinearTracker } from "../linear/tracker";
import { createRouter } from "../server/router";
import { apiDeps } from "../server/testing";
import { createFileSecrets } from "../secrets/encrypted-file";
import { openStore, type Store } from "../store/store";
import { createIssues } from "./issues";
import { createTrackerProjects, type TrackerProjects } from "./tracker-projects";

const CLIENT_ID = "test-client-id";

let dir: string;
let store: Store;
let linear: FakeLinear | undefined;
let connections: Connections;
let projects: TrackerProjects;

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
  projects = createTrackerProjects({
    connections: { list: () => connections.list() },
    linear: (account) => createLinearTracker({ connections, account, endpoint: linear!.endpoints.graphql }),
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
  const router = createRouter({
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
  });
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
  const router = createRouter({
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
  });
  const client = createRouterClient(router, { context: { origin: "ui" } });

  const created = await client.projects.create({ slug: "facturacion", name: "Facturación", tracker: "linear", trackerRef: "P-ENG-1525" });
  expect(created.trackerRef).toBe(project.id);
  const updated = await client.projects.update({ id: created.id, trackerRef: other.slugId });
  expect(updated.trackerRef).toBe(other.id);
  const error = await client.projects.create({ slug: "x", name: "X", tracker: "linear", trackerRef: "P-NOPE-1" }).catch((e: unknown) => e);
  expect(error).toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("No encontré el proyecto") });
});
