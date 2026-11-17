import { type ClankerProject, NewProject, type Origin, ProjectPatch, ProjectUpdate, type ProjectId, type RepoId } from "@clanker/api";
import { createRouterClient, ORPCError } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { createDefs, type Defs } from "../defs/defs";
import { createRouter } from "../server/router";
import { apiDeps, withPrs } from "../testing/router-deps";
import { newId } from "../store/conventions";
import { issues, syncCursors } from "../store/schema";
import { openStore, type Store } from "../store/store";
import { createIssues } from "../tracker/issues";
import { createRepos } from "../repos/repos";
import { InvalidProjectError, ProjectNotFoundError, createProjects, type Projects } from "./projects";

/** `projects.create` con los defaults de `NewProject`, como los deja la API. */
const create = (input: NewProject, origin: Origin) => projects.create(NewProject.parse(input), origin);

let store: Store;
let defs: Defs;
let projects: Projects;

beforeEach(() => {
  store = openStore({ path: ":memory:" });
  defs = createDefs({ store });
  defs.register("flow", z.unknown());
  defs.register("profile", z.unknown());
  projects = createProjects({ store, defs });
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
      trackerAccount: null,
      defaultFlowId: null,
      defaultProfileId: null,
      repos: [],
      queueFilter: {},
      conventions: {},
      parallel: 1,
      stackOn: "ci_green",
      statusMapping: {},
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

describe("defaults de proyectos nuevos", () => {
  const local = { name: "Demo", tracker: "local" } as const;

  test("sin nada guardado: sin flujo ni perfil, 1 en paralelo y sin tope", () => {
    expect(projects.defaults()).toEqual({ defaultFlowId: null, defaultProfileId: null, parallel: 1, maxCostUsd: null });
  });

  test("un proyecto nuevo toma los defaults que no pidió y lo que pide manda; los existentes no cambian", () => {
    defs.save({ kind: "flow", slug: "techlead", scope: "builtin", body: {}, source: "builtin" });
    defs.save({ kind: "profile", slug: "max", scope: "user", body: {}, source: "ui" });
    const before = create({ ...local, slug: "antes" }, "ui");

    const saved = projects.setDefaults({ defaultFlowId: "techlead", defaultProfileId: "max", parallel: 3, maxCostUsd: 5 }, "ui");
    const inherits = create({ ...local, slug: "hereda" }, "ui");
    const overrides = create({ ...local, slug: "pide", parallel: 2, maxCostUsd: null }, "ui");

    expect(projects.defaults()).toEqual(saved);
    expect(inherits).toMatchObject({ defaultFlowId: "techlead", defaultProfileId: "max", parallel: 3, maxCostUsd: 5 });
    expect(overrides).toMatchObject({ parallel: 2, maxCostUsd: null, defaultFlowId: "techlead", defaultProfileId: "max" });
    expect(projects.get(before.id)).toMatchObject({ defaultFlowId: null, parallel: 1, maxCostUsd: null });
  });

  test("lo que no se pasa no cambia, null quita el flujo y uno que no existe se rechaza sin guardar", () => {
    defs.save({ kind: "flow", slug: "techlead", scope: "builtin", body: {}, source: "builtin" });
    projects.setDefaults({ defaultFlowId: "techlead", parallel: 2 }, "ui");

    expect(projects.setDefaults({ maxCostUsd: 1 }, "ui")).toEqual({ defaultFlowId: "techlead", defaultProfileId: null, parallel: 2, maxCostUsd: 1 });
    expect(projects.setDefaults({ defaultFlowId: null }, "ui").defaultFlowId).toBeNull();
    expect(() => projects.setDefaults({ defaultFlowId: "nope" }, "ui")).toThrow(InvalidProjectError);
    expect(projects.defaults().parallel).toBe(2);
  });

  test("un flujo por defecto que ya no existe se ignora al crear en vez de impedirlo", () => {
    const flow = defs.save({ kind: "flow", slug: "techlead", scope: "user", body: {}, source: "ui" });
    projects.setDefaults({ defaultFlowId: "techlead" }, "ui");
    defs.archive("flow", flow.id, "ui");

    expect(create({ ...local, slug: "demo" }, "ui").defaultFlowId).toBeNull();
  });

  test("llegan por la API", async () => {
    const client = createRouterClient(
      createRouter(withPrs({
        store,
        connections: {} as never,
        issues: createIssues({ store }),
        ...apiDeps(store, "/tmp/clanker"),
        coreVersion: "0",
        bootId: "boot",
        startedAt: 0,
        dataDir: "/tmp/clanker",
        onShutdown: () => {},
      })),
      { context: { origin: "ui" } },
    );

    expect(await client.projects.setDefaults({ parallel: 4 })).toMatchObject({ parallel: 4 });
    expect((await client.projects.create({ slug: "demo", name: "Demo", tracker: "local" })).parallel).toBe(4);
    await expect(client.projects.setDefaults({ defaultProfileId: "nope" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("repos, cola, convenciones y tope", () => {
  let api: RepoId;
  let web: RepoId;
  beforeEach(() => {
    const repos = createRepos({ store });
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

describe("statusMapping", () => {
  const cursorKey = (project: ClankerProject) => `issues:linear:${project.trackerRef}`;
  const cursors = () => store.db.select().from(syncCursors).all().map((c) => c.key);

  test("se guarda con el proyecto y cambiarlo borra el cursor de sync para que el próximo relea todas las issues", () => {
    const project = create({ slug: "ba", name: "BA", tracker: "linear", trackerRef: "boundaries" }, "ui");
    store.db.insert(syncCursors).values({ key: cursorKey(project), cursor: "2026-11-15T00:00:00.000Z", checkedAt: 1 }).run();
    store.db.insert(syncCursors).values({ key: "issues:linear:otro", cursor: "2026-11-15T00:00:00.000Z", checkedAt: 1 }).run();

    const updated = projects.update(project.id, { statusMapping: { "In Staging": "in_review" } }, "ui");

    expect(updated.statusMapping).toEqual({ "In Staging": "in_review" });
    expect(projects.get(project.id)!.statusMapping).toEqual({ "In Staging": "in_review" });
    expect(cursors()).toEqual(["issues:linear:otro"]);
    expect(events("project.updated")).toMatchObject([{ payload: { fields: ["statusMapping"] } }]);
  });

  test("el mismo mapeo no toca el cursor", () => {
    const project = create({ slug: "ba", name: "BA", tracker: "linear", trackerRef: "boundaries", statusMapping: { Todo: "backlog" } }, "ui");
    store.db.insert(syncCursors).values({ key: cursorKey(project), cursor: "2026-11-15T00:00:00.000Z", checkedAt: 1 }).run();

    projects.update(project.id, { statusMapping: { Todo: "backlog" } }, "ui");

    expect(cursors()).toEqual([cursorKey(project)]);
  });

  test("un campo desconocido es un error claro, también el patch anidado: no se ignora en silencio", () => {
    const id = newId("prj");
    const wrapped = ProjectUpdate.safeParse({ id, patch: { name: "Otro" } });
    expect(wrapped.success).toBe(false);
    expect(wrapped.error?.issues[0]?.message).toMatch(/no tiene el campo "patch".*planos junto a id.*Acepta: name, /);
    expect(ProjectPatch.safeParse({ nombre: "x", paralel: 2 }).error?.issues[0]?.message).toMatch(/los campos "nombre", "paralel"/);
    expect(ProjectUpdate.safeParse({ id, name: "Otro" }).success).toBe(true);
  });

  test("el contrato rechaza una categoría que no existe", () => {
    expect(ProjectPatch.safeParse({ statusMapping: { Todo: "listo" } }).success).toBe(false);
    expect(ProjectPatch.safeParse({ statusMapping: { Todo: "in_review" } }).success).toBe(true);
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

  test("trackerRef cambia en un proyecto de tracker externo, suelta su cursor y no se repite entre proyectos", () => {
    const linear = create({ slug: "lin", name: "Lin", tracker: "linear", trackerRef: "old", parallel: 1, flowParams: {} }, "ui");
    create({ slug: "otro", name: "Otro", tracker: "linear", trackerRef: "taken", parallel: 1, flowParams: {} }, "ui");
    store.db.insert(syncCursors).values({ key: "issues:linear:old", cursor: "c", checkedAt: 1 }).run();

    expect(() => projects.update(linear.id, { trackerRef: "taken" }, "ui")).toThrow(/Ya hay un proyecto de linear/);
    expect(projects.update(linear.id, { trackerRef: "new" }, "ui").trackerRef).toBe("new");
    expect(store.db.select().from(syncCursors).all()).toEqual([]);
    expect(() => projects.update(project.id, { trackerRef: "x" }, "ui")).toThrow(InvalidProjectError);
  });

  test("la cuenta del tracker se guarda al crear y cambia junto con el proyecto; un proyecto local no la lleva", () => {
    const linear = create({ slug: "lin", name: "Lin", tracker: "linear", trackerRef: "old", trackerAccount: "acme", parallel: 1, flowParams: {} }, "ui");

    expect(linear.trackerAccount).toBe("acme");
    expect(project.trackerAccount).toBeNull();
    expect(projects.update(linear.id, { trackerRef: "new", trackerAccount: "clanker-yard" }, "ui")).toMatchObject({ trackerRef: "new", trackerAccount: "clanker-yard" });
    expect(() => projects.update(project.id, { trackerAccount: "acme" }, "ui")).toThrow(InvalidProjectError);
    expect(NewProject.safeParse({ slug: "l", name: "L", tracker: "local", trackerAccount: "acme" }).success).toBe(false);
  });

  test("fijar la cuenta de un proyecto que no la tenía no exige un caché vacío; cambiarla después sí", () => {
    const viejo = create({ slug: "viejo", name: "Viejo", tracker: "linear", trackerRef: "ref", parallel: 1, flowParams: {} }, "ui");
    store.db
      .insert(issues)
      .values({
        id: newId("iss"),
        tracker: "linear",
        trackerId: "uuid-1",
        key: "DEMO-1",
        url: "https://linear.app/acme/issue/DEMO-1",
        projectId: viejo.id,
        trackerProject: "ref",
        title: "DEMO-1",
        body: "",
        status: "todo",
        rawStatus: "Todo",
        priority: 0,
        labels: [],
        relations: { blocks: [], blockedBy: [], related: [] },
        remoteUpdatedAt: 0,
      })
      .run();

    expect(projects.update(viejo.id, { trackerAccount: "acme" }, "ui").trackerAccount).toBe("acme");
    expect(() => projects.update(viejo.id, { trackerAccount: "clanker-yard" }, "ui")).toThrow(/ya tiene issues/);
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

  test("pause y resume cambian el estado con el actor en el evento; repetirlos no emite nada", () => {
    expect(projects.pause(project.id, "mcp")).toMatchObject({ status: "paused" });
    projects.pause(project.id, "mcp");
    expect(projects.resume(project.id, "cli")).toMatchObject({ status: "active" });
    projects.resume(project.id, "cli");

    expect(events("project.paused", "project.resumed").map((e) => [e.type, e.origin, e.projectId])).toEqual([
      ["project.paused", "mcp", project.id],
      ["project.resumed", "cli", project.id],
    ]);
  });

  test("pause y resume no desarchivan: un proyecto archivado se rechaza, y uno que no existe también", () => {
    projects.update(project.id, { status: "archived" }, "ui");

    expect(() => projects.pause(project.id, "ui")).toThrow(/archivado: no se puede pausar/);
    expect(() => projects.resume(project.id, "ui")).toThrow(/archivado: no se puede retomar/);
    expect(projects.get(project.id)?.status).toBe("archived");
    expect(() => projects.pause(newId("prj"), "ui")).toThrow(ProjectNotFoundError);
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
    const router = createRouter(withPrs({
      store,
      connections: {} as never,
      issues: createIssues({ store }),
      ...apiDeps(store, "/tmp/clanker"),
      coreVersion: "0",
      bootId: "boot",
      startedAt: 0,
      dataDir: "/tmp/clanker",
      onShutdown: () => {},
    }));
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

  test("projects.pause y projects.resume; un archivado es BAD_REQUEST", async () => {
    const client = api();
    const demo = await client.projects.create({ slug: "demo", name: "Demo", tracker: "local" });

    expect(await client.projects.pause({ id: demo.id })).toMatchObject({ status: "paused" });
    expect(await client.projects.resume({ id: demo.id })).toMatchObject({ status: "active" });
    expect(events("project.paused", "project.resumed").map((e) => e.origin)).toEqual(["ui", "ui"]);
    await client.projects.update({ id: demo.id, status: "archived" });
    await expect(client.projects.pause({ id: demo.id })).rejects.toSatisfy(code("BAD_REQUEST", /archivado/));
    await expect(client.projects.resume({ id: newId("prj") as ProjectId })).rejects.toSatisfy(code("NOT_FOUND"));
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
