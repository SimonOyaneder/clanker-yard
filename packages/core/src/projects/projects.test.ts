import { type ClankerProject, NewProject, type Origin, type ProjectId, type RepoId } from "@clanker/api";
import { createRouterClient, ORPCError } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { createDefs, type Defs } from "../defs/defs";
import { createRouter } from "../server/router";
import { apiDeps } from "../server/testing";
import { newId } from "../store/conventions";
import { openStore, type Store } from "../store/store";
import { createIssues } from "../tracker/issues";
import { createRepos } from "../workspaces/repos";
import { InvalidProjectError, ProjectNotFoundError, createProjects, type Projects } from "./projects";

/** `projects.create` con los defaults de `NewProject`, como los deja la API. */
const create = (input: NewProject, origin: Origin) => projects.create(NewProject.parse(input), origin);

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
    const project = create(
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
      repos: [],
      queueFilter: {},
      conventions: {},
      parallel: 1,
      status: "active",
      flowParams: {},
      maxCostUsd: null,
    });
    expect(projects.get(project.id)).toEqual(project);
    expect(events("project.created")).toMatchObject([
      { origin: "cli", projectId: project.id, payload: { projectId: project.id } },
    ]);
  });

  test("guarda el flujo y el perfil por defecto, los params y el cupo", () => {
    defs.save({ kind: "flow", slug: "juguete", scope: "builtin", body: {}, source: "builtin" });
    defs.save({ kind: "profile", slug: "max", scope: "user", body: {}, source: "ui" });

    const project = create(
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
    create({ ...linear, slug: "ba" }, "ui");

    expect(() => create({ ...linear, slug: "ba", trackerRef: "OTRO" }, "ui")).toThrow(/slug "ba"/);
    expect(() => create({ ...linear, slug: "eng-2" }, "ui")).toThrow(/ya hay un proyecto de linear para "BA"/i);
    expect(() => create({ ...linear, slug: "x", trackerRef: "X", defaultFlowId: "nope" }, "ui")).toThrow(
      /No existe el flujo "nope"/,
    );
    expect(() => create({ ...linear, slug: "x", trackerRef: "X", defaultProfileId: "nope" }, "ui")).toThrow(
      InvalidProjectError,
    );
    expect(projects.list().map((p) => p.slug)).toEqual(["ba"]);
    expect(events("project.created")).toHaveLength(1);
  });
});

describe("repos, cola, convenciones y tope", () => {
  let api: RepoId;
  let web: RepoId;
  beforeEach(() => {
    const repos = createRepos(store);
    api = repos.add({ name: "api", path: "/tmp/api" });
    web = repos.add({ name: "web", path: "/tmp/web" });
  });

  test("guarda los repos en orden con sus labels, el filtro de la cola, las convenciones y el tope", () => {
    const project = create(
      {
        slug: "demo",
        name: "Demo",
        tracker: "local",
        repos: [{ repoId: web, labels: ["frontend"] }, { repoId: api }],
        queueFilter: { status: ["todo"], excludeLabels: ["no-clanker"] },
        conventions: { commits: "conventional", pr: { omitSections: ["Rollback"] } },
        maxCostUsd: 5,
      },
      "ui",
    );

    expect(project).toMatchObject({
      repos: [{ repoId: web, labels: ["frontend"] }, { repoId: api, labels: [] }],
      queueFilter: { status: ["todo"], excludeLabels: ["no-clanker"] },
      conventions: { commits: "conventional", pr: { omitSections: ["Rollback"] } },
      maxCostUsd: 5,
    });
    expect(projects.get(project.id)).toEqual(project);
  });

  test("rechaza un repo sin registrar, repetido o un label que manda a dos repos, sin guardar nada", () => {
    const base = { slug: "demo", name: "Demo", tracker: "local" } as const;
    const unknown = "repo_00000000000000000000000001";

    expect(() => create({ ...base, repos: [{ repoId: unknown }] }, "ui")).toThrow(/No existe el repo repo_0+1/);
    expect(() => create({ ...base, repos: [{ repoId: api }, { repoId: api }] }, "ui")).toThrow(/dos veces/);
    expect(() =>
      create({ ...base, repos: [{ repoId: api, labels: ["x"] }, { repoId: web, labels: ["x"] }] }, "ui"),
    ).toThrow(/El label "x" manda a dos repos/);
    expect(projects.list()).toEqual([]);
    expect(events("project.created")).toEqual([]);
  });

  test("update reemplaza la lista de repos y la cola, y emite project.updated con esos campos; los mismos valores no emiten nada", () => {
    const project = create({ slug: "demo", name: "Demo", tracker: "local", repos: [{ repoId: api }] }, "ui");

    const updated = projects.update(
      project.id,
      { repos: [{ repoId: web, labels: ["frontend"] }], queueFilter: { labels: ["clanker"] }, maxCostUsd: 2.5 },
      "cli",
    );
    projects.update(project.id, { repos: [{ repoId: web, labels: ["frontend"] }], maxCostUsd: 2.5 }, "cli");

    expect(updated).toMatchObject({ repos: [{ repoId: web, labels: ["frontend"] }], queueFilter: { labels: ["clanker"] }, maxCostUsd: 2.5 });
    expect(projects.get(project.id)).toEqual(updated);
    expect(events("project.updated")).toMatchObject([{ payload: { fields: ["queueFilter", "maxCostUsd", "repos"] } }]);
    expect(projects.update(project.id, { maxCostUsd: null }, "cli").maxCostUsd).toBeNull();
    expect(() => projects.update(project.id, { repos: [{ repoId: "repo_00000000000000000000000001", labels: [] }] }, "cli")).toThrow(
      InvalidProjectError,
    );
    expect(projects.get(project.id)!.repos).toEqual([{ repoId: web, labels: ["frontend"] }]);
  });
});

describe("update", () => {
  let project: ClankerProject;
  beforeEach(() => {
    project = create({ slug: "demo", name: "Demo", tracker: "local", parallel: 1, flowParams: {} }, "ui");
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
