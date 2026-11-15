import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IssueRef, ProjectId, StatusCategory } from "@clanker/api";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createConnections, type Connections } from "../connections/connections";
import { createFileSecrets } from "../secrets/encrypted-file";
import { newId } from "../store/conventions";
import { openStore, type Store } from "../store/store";
import { createIssues } from "../tracker/issues";
import { IssueNotFoundError, type Tracker } from "../tracker/tracker";
import { startFakeLinear, type FakeLinear } from "./fake-linear";
import type { FakeIssue, FakeProject, FakeTeam, FakeWorkspace } from "./fake-workspace";
import { createLinearGraphql, LinearApiError } from "./graphql";
import { createLinearTracker, NO_PROJECT, type LinearTrackerOptions } from "./tracker";

const CLIENT_ID = "test-client-id";

/** Los estados de un equipo, en su orden: `states.clanker-yard.json` es lo que Linear devolvió para el equipo CLA. */
const states = (name: "clanker-yard" | "with-review") =>
  JSON.parse(readFileSync(new URL(`./fixtures/states.${name}.json`, import.meta.url), "utf8")) as { name: string; type: string }[];

let dir: string;
let store: Store;
let linear: FakeLinear;
let connections: Connections;
let w: FakeWorkspace;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "clanker-linear-tracker-"));
  store = openStore({ path: join(dir, "clanker.db") });
  linear = await startFakeLinear({ clientId: CLIENT_ID });
  w = linear.workspace;
  connections = createConnections(store, createFileSecrets({ dir: join(dir, "secrets") }), {
    linear: { clientId: CLIENT_ID, redirectPort: 0, endpoints: linear.endpoints },
  });
  const { url, done } = await connections.linearAuth("ui");
  const authorize = await fetch(url, { redirect: "manual" });
  await fetch(authorize.headers.get("location")!);
  await done;
});

afterEach(async () => {
  await linear.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function tracker(options: Partial<LinearTrackerOptions> = {}): Tracker {
  return createLinearTracker({ connections, endpoint: linear.endpoints.graphql, ...options });
}

const refOf = (issue: FakeIssue): IssueRef => ({
  tracker: "linear",
  id: issue.id,
  key: issue.identifier,
  url: `https://linear.app/clanker-yard/issue/${issue.identifier}`,
});

const mutations = () => w.operations.filter((o) => o.query.includes("mutation")).length;

describe("el Linear falso", () => {
  test("valida cada query contra el esquema de Linear: un campo que no existe se rechaza", async () => {
    const result = await w.execute("{ viewer { id nombre } }");

    expect(result.errors?.[0]?.message).toMatch(/Cannot query field "nombre" on type "User"/);
  });
});

describe("estados", () => {
  let team: FakeTeam;
  let project: FakeProject;

  /** Una issue en cada estado del equipo, leída con el adapter: [estado de Linear, categoría]. */
  async function categories(options?: Partial<LinearTrackerOptions>) {
    for (const state of team.states) w.addIssue({ team, title: state.name, state: state.name, project });
    const issues = await tracker(options).listIssues({ tracker: "linear", id: project.id }, {});
    return issues.map((i) => [i.rawStatus, i.status]);
  }

  beforeEach(() => {
    project = w.addProject("MVP");
  });

  test("el equipo CLA tal como lo grabó Linear: cada estado cae en su categoría y Duplicate es canceled", async () => {
    team = w.addTeam("CLA", states("clanker-yard"));

    expect(await categories()).toEqual([
      ["Duplicate", "canceled"],
      ["Canceled", "canceled"],
      ["Done", "done"],
      ["In Progress", "in_progress"],
      ["Todo", "todo"],
      ["Backlog", "backlog"],
    ]);
  });

  test("un equipo con triage e In Review: triage es backlog y un started que dice review es in_review", async () => {
    team = w.addTeam("ENG", states("with-review"));

    expect(Object.fromEntries(await categories())).toEqual({
      Triage: "backlog",
      Backlog: "backlog",
      Todo: "todo",
      "In Progress": "in_progress",
      "In Review": "in_review",
      Done: "done",
      Canceled: "canceled",
      Duplicate: "canceled",
    });
  });

  test("el mapeo de un proyecto pisa el por defecto solo en los estados que nombra", async () => {
    team = w.addTeam("ENG", [...states("with-review"), { name: "In Staging", type: "started" }]);

    const mapped = Object.fromEntries(
      await categories({ statusMapping: (id) => (id === project.id ? { "In Staging": "in_review", Todo: "backlog" } : undefined) }),
    );

    expect(mapped).toMatchObject({ "In Staging": "in_review", Todo: "backlog", "In Progress": "in_progress", Backlog: "backlog" });
  });

  test("setStatus elige el estado del equipo de esa categoría: triage y Duplicate solo si no hay otro", async () => {
    team = w.addTeam("ENG", states("with-review"));
    const issue = w.addIssue({ team, title: "x", project });
    const set = async (status: StatusCategory) => {
      await tracker().setStatus(refOf(issue), status);
      return issue.state.name;
    };

    expect(await set("in_review")).toBe("In Review");
    expect(await set("backlog")).toBe("Backlog");
    expect(await set("canceled")).toBe("Canceled");
    expect(await set("done")).toBe("Done");
    expect(await set("todo")).toBe("Todo");
    expect(await set("in_progress")).toBe("In Progress");
  });

  test("setStatus usa el mapeo del proyecto para escoger el estado", async () => {
    team = w.addTeam("ENG", [...states("with-review"), { name: "In Staging", type: "started" }]);
    const issue = w.addIssue({ team, title: "x", project });

    await tracker({ statusMapping: () => ({ "In Review": "in_progress", "In Staging": "in_review" }) }).setStatus(refOf(issue), "in_review");

    expect(issue.state.name).toBe("In Staging");
  });

  test("setStatus a una categoría que el equipo no tiene dice qué estados hay y qué ajustar", async () => {
    team = w.addTeam("CLA", states("clanker-yard"));
    const issue = w.addIssue({ team, title: "x", project });

    const failed = tracker().setStatus(refOf(issue), "in_review");

    await expect(failed).rejects.toThrow(/no tiene un estado de categoría "in_review".*"Backlog".*ajusta el mapeo/);
    expect(mutations()).toBe(0);
  });

  test("setStatus falla si Linear acepta el cambio y no lo aplica", async () => {
    team = w.addTeam("CLA", states("clanker-yard"));
    const issue = w.addIssue({ team, title: "x", project });
    w.ignoreStateUpdates = true;

    await expect(tracker().setStatus(refOf(issue), "done")).rejects.toThrow(/Linear ignoró el cambio de CLA-1 a "done": sigue en "Todo"/);
  });
});

describe("claim", () => {
  let team: FakeTeam;
  beforeEach(() => {
    team = w.addTeam("ENG", states("with-review"));
  });

  test("asigna a la persona del token y pasa la issue a in_progress", async () => {
    const issue = w.addIssue({ team, title: "x" });

    await tracker().claim(refOf(issue));

    expect(issue.assignee).toEqual(w.viewer);
    expect(issue.state.name).toBe("In Progress");
    expect(await tracker().getIssue(refOf(issue))).toMatchObject({
      status: "in_progress",
      assignee: { id: w.viewer.id, name: w.viewer.name },
    });
  });

  test("reclamar dos veces la misma issue no falla", async () => {
    const issue = w.addIssue({ team, title: "x", assignee: w.viewer, state: "In Progress" });

    await expect(tracker().claim(refOf(issue))).resolves.toBeUndefined();
  });

  test("un claim que Linear acepta y no aplica (caso ENG-9084) da error y dice qué quedó sin hacer", async () => {
    const issue = w.addIssue({ team, title: "x" });
    w.ignoreStateUpdates = true;

    const failed = tracker().claim(refOf(issue));

    await expect(failed).rejects.toThrow(new RegExp(`Linear ignoró el claim de ${issue.identifier}: sigue en "Todo"\\.`));
    // La asignación sí quedó: el error es por el estado, y es lo que hay que mirar.
    expect(issue.assignee).toEqual(w.viewer);
  });

  test("una issue asignada a otra persona no se reclama y no se toca", async () => {
    const issue = w.addIssue({ team, title: "x", assignee: w.addUser("Otra Persona") });

    await expect(tracker().claim(refOf(issue))).rejects.toThrow(/ya está asignada a Otra Persona/);
    expect(mutations()).toBe(0);
    expect(issue.state.name).toBe("Todo");
  });

  test("una issue que ya no existe es IssueNotFoundError", async () => {
    const issue = w.addIssue({ team, title: "x" });
    w.archive(issue);

    await expect(tracker().claim(refOf(issue))).rejects.toThrow(IssueNotFoundError);
  });
});

describe("comment y getIssue", () => {
  test("el comentario sale con el prefijo [clanker], sin repetirlo si ya lo trae", async () => {
    const team = w.addTeam("ENG", states("with-review"));
    const issue = w.addIssue({ team, title: "x" });

    await tracker().comment(refOf(issue), "tomé la issue");
    await tracker().comment(refOf(issue), "[clanker] ya estaba listo");

    const { comments } = await tracker().getIssue(refOf(issue));
    expect(comments.map((c) => [c.author.name, c.text])).toEqual([
      [w.viewer.name, "[clanker] tomé la issue"],
      [w.viewer.name, "[clanker] ya estaba listo"],
    ]);
    await expect(tracker().comment(refOf(issue), "  ")).rejects.toThrow(/vacío/);
  });

  test("los comentarios vienen del más antiguo al más nuevo, de todas las páginas, con el autor o el bot", async () => {
    const team = w.addTeam("ENG", states("with-review"));
    const issue = w.addIssue({ team, title: "x" });
    const ana = w.addUser("Ana");
    w.addComment(issue, { user: ana, body: "primero" });
    w.addComment(issue, { botName: "Dependabot", body: "segundo" });
    for (let n = 3; n <= 120; n++) w.addComment(issue, { user: ana, body: `comentario ${n}` });

    const { comments } = await tracker().getIssue(refOf(issue));

    expect(comments).toHaveLength(120);
    expect(comments.slice(0, 2).map((c) => [c.author.name, c.text])).toEqual([
      ["Ana", "primero"],
      ["Dependabot", "segundo"],
    ]);
    expect(comments.at(-1)?.text).toBe("comentario 120");
    expect(comments.filter((c) => c.text === "primero")).toHaveLength(1);
  });

  test("getIssue trae sub-issue, milestone, labels, estimate y prioridad", async () => {
    const team = w.addTeam("ENG", states("with-review"));
    const project = w.addProject("MVP");
    const parent = w.addIssue({ team, title: "padre", project });
    const child = w.addIssue({
      team,
      title: "hija",
      description: "detalle",
      priority: 2,
      estimate: 3,
      labels: ["tracker", "no-clanker"],
      project,
      parent,
      milestone: { name: "Fase 1", targetDate: "2026-12-31" },
    });

    expect(await tracker().getIssue(refOf(child))).toEqual({
      ref: refOf(child),
      project: project.id,
      title: "hija",
      body: "detalle",
      status: "todo",
      rawStatus: "Todo",
      priority: 2,
      labels: ["tracker", "no-clanker"],
      estimate: 3,
      parent: refOf(parent),
      milestone: { name: "Fase 1", due: "2026-12-31" },
      relations: { blocks: [], blockedBy: [], related: [] },
      comments: [],
      updatedAt: child.updatedAt,
    });
    expect(await tracker().getIssue(refOf(parent))).toMatchObject({ body: "", priority: 0, project: project.id });
  });

  test("una issue sin proyecto lleva NO_PROJECT", async () => {
    const issue = w.addIssue({ team: w.addTeam("ENG", states("with-review")), title: "x" });

    expect((await tracker().getIssue(refOf(issue))).project).toBe(NO_PROJECT);
  });

  test("una issue que no existe es IssueNotFoundError", async () => {
    w.addTeam("ENG", states("with-review"));
    const ghost = { tracker: "linear", id: newId("iss"), key: "ENG-99", url: "https://linear.app/clanker-yard/issue/ENG-99" } as const;

    await expect(tracker().getIssue(ghost)).rejects.toThrow(IssueNotFoundError);
  });

  test("más labels o relaciones de las que el adapter lee es un error, no una lista truncada", async () => {
    const team = w.addTeam("ENG", states("with-review"));
    const issue = w.addIssue({ team, title: "x", labels: Array.from({ length: 26 }, (_, n) => `l${n}`) });

    await expect(tracker().getIssue(refOf(issue))).rejects.toThrow(/ENG-1 tiene más de 25 labels/);
  });
});

describe("relaciones", () => {
  test("blocks, blockedBy y related se normalizan desde las dos puntas de cada relación", async () => {
    const team = w.addTeam("ENG", states("with-review"));
    const [a, b, c, d] = ["a", "b", "c", "d"].map((title) => w.addIssue({ team, title }));
    w.relate(a!, "blocks", b!);
    w.relate(b!, "blocks", c!);
    w.relate(a!, "related", d!);
    w.relate(c!, "related", a!);

    const get = async (issue: FakeIssue) => (await tracker().getIssue(refOf(issue))).relations;

    expect(await get(a!)).toEqual({ blocks: [refOf(b!)], blockedBy: [], related: [refOf(d!), refOf(c!)] });
    expect(await get(b!)).toEqual({ blocks: [refOf(c!)], blockedBy: [refOf(a!)], related: [] });
    expect(await get(c!)).toEqual({ blocks: [], blockedBy: [refOf(b!)], related: [refOf(a!)] });
    expect(await get(d!)).toEqual({ blocks: [], blockedBy: [], related: [refOf(a!)] });
  });

  test("las relaciones de listIssues son las mismas que las de getIssue", async () => {
    const team = w.addTeam("ENG", states("with-review"));
    const project = w.addProject("MVP");
    const a = w.addIssue({ team, title: "a", project });
    const b = w.addIssue({ team, title: "b", project });
    w.relate(a, "blocks", b);

    const listed = await tracker().listIssues({ tracker: "linear", id: project.id }, {});

    expect(
      listed.map((i) => [i.ref.key, i.relations.blocks.length, i.relations.blockedBy.length]).sort(([x], [y]) => String(x).localeCompare(String(y))),
    ).toEqual([
      ["ENG-1", 1, 0],
      ["ENG-2", 0, 1],
    ]);
  });
});

describe("proyectos e issues", () => {
  test("listProjects trae todos los proyectos, de todas las páginas", async () => {
    for (let n = 1; n <= 120; n++) w.addProject(`P${n}`);

    const projects = await tracker().listProjects();

    expect(projects).toHaveLength(120);
    expect(projects[0]).toEqual({ ref: { tracker: "linear", id: expect.any(String) }, name: "P1" });
  });

  test("listIssues trae solo las del proyecto, de todas las páginas, y aplica el filtro normalizado", async () => {
    const team = w.addTeam("ENG", states("with-review"));
    const mvp = w.addProject("MVP");
    const other = w.addProject("Otro");
    for (let n = 1; n <= 60; n++) w.addIssue({ team, title: `mvp ${n}`, project: mvp, labels: n % 2 === 0 ? ["no-clanker"] : [] });
    w.addIssue({ team, title: "de otro", project: other });
    w.addIssue({ team, title: "sin proyecto" });
    w.addIssue({ team, title: "en curso", project: mvp, state: "In Progress", labels: ["tracker"] });
    const project = { tracker: "linear", id: mvp.id } as const;

    const all = await tracker().listIssues(project, {});
    const queue = await tracker().listIssues(project, { status: ["todo"], excludeLabels: ["no-clanker"] });
    const labelled = await tracker().listIssues(project, { labels: ["tracker"] });

    expect(all).toHaveLength(61);
    expect(new Set(all.map((i) => i.project))).toEqual(new Set([mvp.id]));
    expect(queue).toHaveLength(30);
    expect(queue.every((i) => i.status === "todo" && !i.labels.includes("no-clanker"))).toBe(true);
    expect(labelled.map((i) => i.title)).toEqual(["en curso"]);
  });
});

describe("changesSince", () => {
  let team: FakeTeam;
  beforeEach(() => {
    team = w.addTeam("ENG", states("with-review"));
  });

  test("sin cursor trae todas las issues del workspace; con el cursor, solo las que cambiaron después", async () => {
    const [a, b, c] = ["a", "b", "c"].map((title) => w.addIssue({ team, title, project: w.addProject(title) }));

    const first = await tracker().changesSince();
    expect(first.changed.map((r) => r.key).sort()).toEqual(["ENG-1", "ENG-2", "ENG-3"]);
    expect(await tracker().changesSince(first.cursor)).toEqual({ changed: [], cursor: first.cursor });

    w.update(b!, { state: "In Progress" });
    w.relate(a!, "blocks", c!);
    const second = await tracker().changesSince(first.cursor);
    expect(second.changed.map((r) => r.key).sort()).toEqual(["ENG-1", "ENG-2", "ENG-3"]);
    expect(second.cursor > first.cursor).toBe(true);

    w.update(c!, { title: "c2" });
    const third = await tracker().changesSince(second.cursor);
    expect(third.changed).toEqual([refOf(c!)]);
    expect(await tracker().changesSince(third.cursor)).toEqual({ changed: [], cursor: third.cursor });
  });

  test("lee todas las páginas de los cambios", async () => {
    for (let n = 1; n <= 230; n++) w.addIssue({ team, title: `i${n}` });

    const { changed } = await tracker().changesSince();

    expect(new Set(changed.map((r) => r.id)).size).toBe(230);
  });

  test("un workspace vacío deja el cursor en el epoch y la primera issue que aparece se ve", async () => {
    const empty = await tracker().changesSince();
    expect(empty).toEqual({ changed: [], cursor: "1970-01-01T00:00:00.000Z" });

    const issue = w.addIssue({ team, title: "nueva" });

    expect((await tracker().changesSince(empty.cursor)).changed).toEqual([refOf(issue)]);
  });

  test("un cursor que no es de este tracker se rechaza con el paso a seguir", async () => {
    await expect(tracker().changesSince("42")).rejects.toThrow(/no es de este tracker.*sin cursor/);
  });
});

describe("conexión", () => {
  test("sin cuenta de Linear conectada dice cómo conectarla", async () => {
    await connections.disconnect("linear", "clanker-yard", "ui");

    await expect(tracker().listProjects()).rejects.toThrow(/No hay una cuenta de Linear conectada/);
  });

  test("con la cuenta indicada usa su token; una que no está conectada falla", async () => {
    await expect(tracker({ account: "clanker-yard" }).listProjects()).resolves.toEqual([]);
    await expect(tracker({ account: "otro" }).listProjects()).rejects.toThrow(/otro/);
  });

  test("un token que Linear rechaza es un error con el paso a seguir", async () => {
    const gql = createLinearGraphql({ endpoint: linear.endpoints.graphql, token: async () => "caducado" });

    await expect(gql("{ viewer { id } }")).rejects.toThrow(LinearApiError);
    await expect(gql("{ viewer { id } }")).rejects.toThrow(/Unauthorized|reconecta Linear/);
  });

  test("una cuota agotada (429 y RATELIMITED) dice cuánto esperar", async () => {
    const limited: typeof fetch = async () =>
      new Response(JSON.stringify({ errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] }), {
        status: 429,
        headers: { "retry-after": "30" },
      });
    const gql = createLinearGraphql({ endpoint: "http://linear.invalid/graphql", token: async () => "t", fetch: limited });

    await expect(gql("{ viewer { id } }")).rejects.toMatchObject({ code: "RATELIMITED", message: expect.stringMatching(/reintenta en 30 s/) });
  });
});

describe("con el caché de issues", () => {
  test("sync vuelca el proyecto de Linear y después solo lo que cambió, con el claim a la vista", async () => {
    const team = w.addTeam("ENG", states("with-review"));
    const mvp = w.addProject("MVP");
    const other = w.addProject("Otro");
    const todo = w.addIssue({ team, title: "una", project: mvp });
    const quiet = w.addIssue({ team, title: "otra", project: mvp });
    w.addIssue({ team, title: "de otro proyecto", project: other });
    const linearTracker = tracker();
    const issues = createIssues(store);
    const projectId = newId("prj") as ProjectId;
    const binding = { projectId, project: { tracker: "linear", id: mvp.id } } as const;

    expect(await issues.sync(linearTracker, binding)).toBe(2);
    await linearTracker.claim(refOf(todo));
    expect(await issues.sync(linearTracker, binding)).toBe(1);

    const cached = issues.list({ projectId }).map((i) => [i.ref.key, i.status, i.assignee?.id]);
    expect(cached).toHaveLength(2);
    expect(cached).toContainEqual([todo.identifier, "in_progress", w.viewer.id]);
    expect(cached).toContainEqual([quiet.identifier, "todo", undefined]);
    expect(await issues.sync(linearTracker, binding)).toBe(0);
  });
});
