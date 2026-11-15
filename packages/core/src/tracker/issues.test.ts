import type { Issue, ProjectId } from "@clanker/api";
import { createRouterClient, ORPCError } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Connections } from "../connections/connections";
import { createRouter } from "../server/router";
import { apiDeps } from "../server/testing";
import { newId } from "../store/conventions";
import { issues as issuesTable } from "../store/schema";
import { openStore, type Store } from "../store/store";
import { createIssues, type Issues } from "./issues";
import { createLocalTracker, type LocalTracker } from "./local";
import type { Tracker } from "./tracker";

let store: Store;
let local: LocalTracker;
let issues: Issues;
let projectId: ProjectId;

beforeEach(() => {
  store = openStore({ path: ":memory:" });
  local = createLocalTracker(store);
  issues = createIssues(store, local);
  projectId = newId("prj");
});

afterEach(() => store.close());

const binding = () => ({
  projectId,
  project: { tracker: "local", id: "demo" } as const,
});
const synced = () => store.events.since(0, { types: ["issue.synced"] });

describe("sync", () => {
  test("la primera vez vuelca todas las issues del proyecto al caché y emite issue.synced por cada una", async () => {
    await local.createIssue("demo", { title: "a", priority: 2 });
    await local.createIssue("demo", { title: "b" });
    await local.createIssue("otro", { title: "de otro proyecto" });

    expect(await issues.sync(local, binding(), "watch")).toBe(2);

    const cached = issues.list({ projectId });
    expect(
      cached.map((i) => [i.ref.key, i.title, i.priority, i.projectId]),
    ).toEqual([
      ["DEMO-1", "a", 2, projectId],
      ["DEMO-2", "b", 0, projectId],
    ]);
    expect(
      synced().map((e) => [e.origin, e.projectId, e.subject, e.payload]),
    ).toEqual(
      cached.map((i) => [
        "watch",
        projectId,
        { type: "issue", id: i.id },
        { issueId: i.id, changed: ["created"] },
      ]),
    );
  });

  test("después solo trae lo que cambió, con los campos que cambiaron en el evento", async () => {
    const a = (await local.createIssue("demo", { title: "a" })).ref;
    await local.createIssue("demo", { title: "b" });
    await issues.sync(local, binding());
    const before = synced().length;

    expect(await issues.sync(local, binding())).toBe(0);
    expect(synced()).toHaveLength(before);

    await local.setStatus(a, "done");
    await local.comment(a, "listo");
    expect(await issues.sync(local, binding())).toBe(1);

    const [id] = issues.list({ status: ["done"] }).map((i) => i.id);
    expect(synced().at(-1)?.payload).toEqual({
      issueId: id,
      changed: ["status", "rawStatus", "remoteUpdatedAt"],
    });
    expect(issues.get(id!)).toMatchObject({
      status: "done",
      rawStatus: "Done",
    });
  });

  test("adopta por key la issue que importó el loop viejo en vez de duplicarla", async () => {
    // `clanker import legacy` guarda la key como `tracker_id`: el loop viejo no conocía el id del tracker.
    const imported = newId("iss");
    store.tx((tx) =>
      tx.db
        .insert(issuesTable)
        .values({
          id: imported,
          tracker: "linear",
          trackerId: "DEMO-1",
          key: "DEMO-1",
          url: "https://linear.app/acme/issue/DEMO-1",
          projectId: newId("prj"),
          trackerProject: "placeholder",
          title: "DEMO-1",
          body: "",
          status: "done",
          rawStatus: "mergeado",
          priority: 0,
          labels: [],
          relations: { blocks: [], blockedBy: [], related: [] },
          remoteUpdatedAt: 0,
        })
        .run(),
    );
    const { ref } = await local.createIssue("demo", { title: "Título real", priority: 2 });
    const asLinear: Tracker = {
      ...local,
      id: "linear",
      listIssues: async (project, filter) =>
        (await local.listIssues(project, filter)).map((issue) => ({ ...issue, ref: { tracker: "linear", id: "uuid-1", key: ref.key, url: ref.url } })),
    };

    expect(await issues.sync(asLinear, { projectId, project: { tracker: "linear", id: "demo" } })).toBe(1);

    const rows = store.db.select().from(issuesTable).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: imported, trackerId: "uuid-1", key: ref.key, projectId, title: "Título real", priority: 2 });
  });

  test("las relaciones y los sub-issues llegan al caché", async () => {
    const parent = (await local.createIssue("demo", { title: "padre" })).ref;
    const child = (await local.createIssue("demo", { title: "hija", parent }))
      .ref;
    await local.relate(parent, "blocks", child);
    await issues.sync(local, binding());

    const [cachedParent, cachedChild] = issues.list({ projectId });
    expect(cachedChild).toMatchObject({
      parent,
      relations: { blockedBy: [parent] },
    });
    expect(cachedParent?.relations.blocks).toEqual([child]);
  });

  test("ignora lo que cambió en otros proyectos del tracker", async () => {
    await local.createIssue("demo", { title: "a" });
    await issues.sync(local, binding());
    const other = (await local.createIssue("otro", { title: "x" })).ref;
    await local.setStatus(other, "done");

    expect(await issues.sync(local, binding())).toBe(0);
    expect(issues.list()).toHaveLength(1);
  });

  test("dos proyectos de Clanker sobre el mismo tracker tienen cursores independientes", async () => {
    await local.createIssue("demo", { title: "a" });
    await local.createIssue("otro", { title: "b" });
    const otherId = newId("prj");

    await issues.sync(local, binding());
    expect(
      await issues.sync(local, {
        projectId: otherId,
        project: { tracker: "local", id: "otro" },
      }),
    ).toBe(1);
    expect(issues.list({ projectId: otherId }).map((i) => i.title)).toEqual([
      "b",
    ]);
  });

  test("si el tracker falla no escribe nada y el próximo sync reintenta desde el mismo cursor", async () => {
    await local.createIssue("demo", { title: "a" });
    await issues.sync(local, binding());
    await local.createIssue("demo", { title: "b" });

    let failing = true;
    const flaky: Tracker = {
      ...local,
      getIssue: (ref) =>
        failing
          ? Promise.reject(new Error("tracker caído"))
          : local.getIssue(ref),
    };
    await expect(issues.sync(flaky, binding())).rejects.toThrow(
      "tracker caído",
    );
    expect(issues.list()).toHaveLength(1);

    failing = false;
    expect(await issues.sync(flaky, binding())).toBe(1);
    expect(issues.list().map((i) => i.title)).toEqual(["a", "b"]);
  });
});

describe("hasChanges", () => {
  test("es true hasta el primer sync y desde entonces solo cuando el tracker cambió, sin mover el cursor", async () => {
    expect(await issues.hasChanges(local, binding())).toBe(true);

    await local.createIssue("demo", { title: "a" });
    await issues.sync(local, binding());
    expect(await issues.hasChanges(local, binding())).toBe(false);

    await local.createIssue("demo", { title: "b" });
    expect(await issues.hasChanges(local, binding())).toBe(true);
    expect(await issues.hasChanges(local, binding())).toBe(true);

    await issues.sync(local, binding());
    expect(await issues.hasChanges(local, binding())).toBe(false);
  });
});

describe("list", () => {
  test("ordena por prioridad, urgente primero y sin prioridad al final, y filtra como el tracker", async () => {
    await local.createIssue("demo", { title: "sin prioridad", labels: ["x"] });
    await local.createIssue("demo", { title: "baja", priority: 4 });
    await local.createIssue("demo", {
      title: "urgente",
      priority: 1,
      labels: ["x", "no-clanker"],
    });
    await local.createIssue("demo", {
      title: "hecha",
      priority: 2,
      status: "done",
    });
    await issues.sync(local, binding());

    const titles = (filter: Parameters<Issues["list"]>[0]) =>
      issues.list(filter).map((i: Issue) => i.title);
    expect(titles({})).toEqual(["urgente", "hecha", "baja", "sin prioridad"]);
    expect(titles({ status: ["todo"], excludeLabels: ["no-clanker"] })).toEqual(
      ["baja", "sin prioridad"],
    );
    expect(titles({ labels: ["x"] })).toEqual(["urgente", "sin prioridad"]);
    expect(titles({ projectId: newId("prj") })).toEqual([]);
  });
});

describe("API", () => {
  function client(origin: "ui" | "cli" = "ui") {
    const router = createRouter({
      store,
      connections: {} as Connections,
      issues,
      ...apiDeps(store, "/tmp/clanker"),
      coreVersion: "0",
      bootId: "boot",
      startedAt: 0,
      dataDir: "/tmp/clanker",
      onShutdown: () => {},
    });
    return createRouterClient(router, { context: { origin } });
  }

  test("crea una issue local por la API y la lee de vuelta con get y con list", async () => {
    const api = client("cli");
    const { id: projectId } = await api.projects.create({ slug: "demo", name: "Demo", tracker: "local" });

    const created = await api.issues.createLocal({
      projectId,
      title: "Demo",
      body: "para la demo",
      priority: 2,
      labels: ["demo"],
    });

    expect(created).toMatchObject({
      projectId,
      ref: { tracker: "local", key: `${projectId.toUpperCase()}-1` },
      title: "Demo",
      body: "para la demo",
      status: "todo",
      priority: 2,
      labels: ["demo"],
    });
    expect(await api.issues.get({ id: created.id })).toEqual(created);
    expect(await api.issues.list({ projectId })).toEqual([created]);
    expect(synced().at(-1)).toMatchObject({
      origin: "cli",
      subject: { type: "issue", id: created.id },
    });
  });

  test("las issues locales siguientes quedan en el mismo proyecto y list filtra por estado", async () => {
    const api = client();
    const { id: projectId } = await api.projects.create({ slug: "demo", name: "Demo", tracker: "local" });
    await api.issues.createLocal({ projectId, title: "a" });
    await api.issues.createLocal({ projectId, title: "b", status: "backlog" });

    expect(
      (await api.issues.list({ projectId })).map(
        (i) => i.ref.key.split("-")[1],
      ),
    ).toEqual(["1", "2"]);
    expect(
      (await api.issues.list({ projectId, status: ["backlog"] })).map(
        (i) => i.title,
      ),
    ).toEqual(["b"]);
  });

  test("createLocal en un proyecto que no existe es NOT_FOUND y en uno de otro tracker es BAD_REQUEST", async () => {
    const api = client();
    const linear = await api.projects.create({ slug: "linear", name: "Linear", tracker: "linear", trackerRef: "BA" });

    await expect(api.issues.createLocal({ projectId, title: "x" })).rejects.toSatisfy(
      (e) => e instanceof ORPCError && e.code === "NOT_FOUND",
    );
    await expect(api.issues.createLocal({ projectId: linear.id, title: "x" })).rejects.toSatisfy(
      (e) => e instanceof ORPCError && e.code === "BAD_REQUEST" && /solo un proyecto local/.test(e.message),
    );
  });

  test("get de una issue que no está en el caché es NOT_FOUND", async () => {
    await expect(client().issues.get({ id: newId("iss") })).rejects.toSatisfy(
      (e) => e instanceof ORPCError && e.code === "NOT_FOUND",
    );
  });
});
