import { type ClankerProject, type ProjectId } from "@clanker/api";
import { createRouterClient, ORPCError } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { createDefs, type Defs } from "../defs/defs";
import { createRouter } from "../server/router";
import { apiDeps } from "../server/testing";
import { newId } from "../store/conventions";
import { openStore, type Store } from "../store/store";
import { createIssues } from "../tracker/issues";
import { InvalidProjectError, ProjectNotFoundError, createProjects, type Projects } from "./projects";

let store: Store;
let defs: Defs;
let projects: Projects;

beforeEach(() => {
  store = openStore({ path: ":memory:" });
  defs = createDefs(store);
  defs.register("flow", z.unknown());
  defs.register("profile", z.unknown());
  projects = createProjects(store, defs);
});

afterEach(() => store.close());

const events = (...types: string[]) => store.events.since(0, { types: types as never });

describe("create", () => {
  test("un proyecto local usa su id como trackerRef y parte activo con los defaults", () => {
    const project = projects.create(
      { slug: "demo", name: "Demo", tracker: "local", parallel: 1, flowParams: {} },
      "cli",
    );

    expect(project).toEqual({
      id: expect.stringMatching(/^prj_/),
      slug: "demo",
      name: "Demo",
      tracker: "local",
      trackerRef: project.id,
      defaultFlowId: null,
      defaultProfileId: null,
      parallel: 1,
      status: "active",
      flowParams: {},
    });
    expect(projects.get(project.id)).toEqual(project);
    expect(events("project.created")).toMatchObject([
      { origin: "cli", projectId: project.id, payload: { projectId: project.id } },
    ]);
  });

  test("guarda el flujo y el perfil por defecto, los params y el cupo", () => {
    defs.save({ kind: "flow", slug: "juguete", scope: "builtin", body: {}, source: "builtin" });
    defs.save({ kind: "profile", slug: "max", scope: "user", body: {}, source: "ui" });

    const project = projects.create(
      {
        slug: "ba",
        name: "BA",
        tracker: "linear",
        trackerRef: "BA",
        defaultFlowId: "juguete",
        defaultProfileId: "max",
        parallel: 3,
        flowParams: { reviewRounds: 2 },
      },
      "ui",
    );

    expect(project).toMatchObject({
      trackerRef: "BA",
      defaultFlowId: "juguete",
      defaultProfileId: "max",
      parallel: 3,
      flowParams: { reviewRounds: 2 },
    });
  });

  test("rechaza un slug repetido, un tracker y ref repetidos y defaults que no existen, sin guardar nada", () => {
    const linear = { name: "BA", tracker: "linear", trackerRef: "BA", parallel: 1, flowParams: {} } as const;
    projects.create({ ...linear, slug: "ba" }, "ui");

    expect(() => projects.create({ ...linear, slug: "ba", trackerRef: "OTRO" }, "ui")).toThrow(/slug "ba"/);
    expect(() => projects.create({ ...linear, slug: "eng-2" }, "ui")).toThrow(/ya hay un proyecto de linear para "BA"/i);
    expect(() => projects.create({ ...linear, slug: "x", trackerRef: "X", defaultFlowId: "nope" }, "ui")).toThrow(
      /No existe el flujo "nope"/,
    );
    expect(() => projects.create({ ...linear, slug: "x", trackerRef: "X", defaultProfileId: "nope" }, "ui")).toThrow(
      InvalidProjectError,
    );
    expect(projects.list().map((p) => p.slug)).toEqual(["ba"]);
    expect(events("project.created")).toHaveLength(1);
  });
});

describe("update", () => {
  let project: ClankerProject;
  beforeEach(() => {
    project = projects.create({ slug: "demo", name: "Demo", tracker: "local", parallel: 1, flowParams: {} }, "ui");
  });

  test("cambia solo lo que viene y emite project.updated con esos campos", () => {
    const updated = projects.update(project.id, { name: "Otro", parallel: 2 }, "cli");

    expect(updated).toEqual({ ...project, name: "Otro", parallel: 2 });
    expect(events("project.updated")).toMatchObject([
      { origin: "cli", projectId: project.id, payload: { fields: ["name", "parallel"] } },
    ]);
  });

  test("un cambio de estado emite el evento de ese estado y un patch sin cambios no emite nada", () => {
    projects.update(project.id, { status: "paused" }, "ui");
    projects.update(project.id, { status: "active" }, "ui");
    projects.update(project.id, { status: "archived" }, "ui");
    projects.update(project.id, { name: "Demo", status: "archived" }, "ui");

    expect(events("project.paused", "project.resumed", "project.archived").map((e) => e.type)).toEqual([
      "project.paused",
      "project.resumed",
      "project.archived",
    ]);
    expect(events("project.updated")).toEqual([]);
  });

  test("null borra el flujo por defecto; un flujo que no existe se rechaza", () => {
    defs.save({ kind: "flow", slug: "juguete", scope: "builtin", body: {}, source: "builtin" });
    expect(projects.update(project.id, { defaultFlowId: "juguete" }, "ui").defaultFlowId).toBe("juguete");
    expect(projects.update(project.id, { defaultFlowId: null }, "ui").defaultFlowId).toBeNull();
    expect(() => projects.update(project.id, { defaultFlowId: "nope" }, "ui")).toThrow(InvalidProjectError);
  });

  test("un proyecto que no existe lanza ProjectNotFoundError", () => {
    expect(() => projects.update(newId("prj"), { name: "x" }, "ui")).toThrow(ProjectNotFoundError);
  });
});

describe("API", () => {
  function api() {
    const router = createRouter({
      store,
      connections: {} as never,
      issues: createIssues(store),
      ...apiDeps(store, "/tmp/clanker"),
      coreVersion: "0",
      bootId: "boot",
      startedAt: 0,
      dataDir: "/tmp/clanker",
      onShutdown: () => {},
    });
    return createRouterClient(router, { context: { origin: "ui" } });
  }
  const code = (expected: string, message?: RegExp) => (e: unknown) =>
    e instanceof ORPCError && e.code === expected && (message?.test(e.message) ?? true);

  test("create, get, list y update; los errores llegan como BAD_REQUEST o NOT_FOUND", async () => {
    const client = api();
    const demo = await client.projects.create({ slug: "demo", name: "Demo", tracker: "local" });
    await client.projects.create({ slug: "a", name: "A", tracker: "linear", trackerRef: "A" });

    expect(await client.projects.get({ id: demo.id })).toEqual(demo);
    expect((await client.projects.list()).map((p) => p.slug)).toEqual(["a", "demo"]);
    expect(await client.projects.update({ id: demo.id, name: "Nuevo" })).toMatchObject({ name: "Nuevo" });
    await expect(client.projects.create({ slug: "demo", name: "x", tracker: "local" })).rejects.toSatisfy(
      code("BAD_REQUEST", /slug "demo"/),
    );
    const missing = newId("prj") as ProjectId;
    await expect(client.projects.get({ id: missing })).rejects.toSatisfy(code("NOT_FOUND"));
    await expect(client.projects.update({ id: missing, name: "x" })).rejects.toSatisfy(code("NOT_FOUND"));
  });

  test("runs.start rechaza lo que no puede lanzar con un mensaje accionable", async () => {
    const client = api();
    const demo = await client.projects.create({ slug: "demo", name: "Demo", tracker: "local" });
    const other = await client.projects.create({ slug: "otro", name: "Otro", tracker: "local" });
    const issue = await client.issues.createLocal({ projectId: demo.id, title: "una" });

    await expect(client.runs.start({ projectId: newId("prj"), issueId: issue.id })).rejects.toSatisfy(code("NOT_FOUND"));
    await expect(client.runs.start({ projectId: demo.id, issueId: newId("iss") })).rejects.toSatisfy(code("NOT_FOUND"));
    await expect(client.runs.start({ projectId: other.id, issueId: issue.id })).rejects.toSatisfy(
      code("BAD_REQUEST", /otro proyecto/),
    );
    await expect(client.runs.start({ projectId: demo.id, issueId: issue.id })).rejects.toSatisfy(
      code("BAD_REQUEST", /no tiene flujo por defecto/),
    );
    await expect(client.runs.start({ projectId: demo.id, issueId: issue.id, flow: "nope" })).rejects.toSatisfy(
      code("BAD_REQUEST", /No existe el flujo "nope"/),
    );
    await client.projects.update({ id: demo.id, status: "paused" });
    await expect(client.runs.start({ projectId: demo.id, issueId: issue.id, flow: "nope" })).rejects.toSatisfy(
      code("BAD_REQUEST", /está paused/),
    );
    await expect(client.runs.get({ id: newId("run") })).rejects.toSatisfy(code("NOT_FOUND"));
    expect(await client.runs.list({})).toEqual([]);
  });
});
