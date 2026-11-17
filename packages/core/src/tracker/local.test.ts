import type { IssueRef } from "@clanker/api";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openStore, type Store } from "../store/store";
import { createLocalTracker, type LocalTracker } from "./local";
import { IssueNotFoundError } from "./tracker";

let store: Store;
let tracker: LocalTracker;
let clock: number;

beforeEach(() => {
  store = openStore({ path: ":memory:" });
  clock = 1_000;
  tracker = createLocalTracker(store, { now: () => ++clock });
});

afterEach(() => store.close());

const demo = { tracker: "local", id: "demo" } as const;

async function create(
  title: string,
  project = "demo",
  extra: object = {},
): Promise<IssueRef> {
  return (await tracker.createIssue(project, { title, ...extra })).ref;
}

describe("capacidades", () => {
  test("declara todas las capacidades y cada una funciona", async () => {
    expect(tracker.id).toBe("local");
    expect(tracker.capabilities).toEqual({
      relations: true,
      subIssues: true,
      milestones: true,
      priorities: true,
      estimates: true,
    });

    const parent = await create("padre");
    const child = await tracker.createIssue("demo", {
      title: "hija",
      parent,
      priority: 1,
      estimate: 3,
      milestone: { name: "Fase 0", due: "2026-12-31" },
    });
    await tracker.relate(parent, "blocks", child.ref);

    const read = await tracker.getIssue(child.ref);
    expect(read).toMatchObject({
      parent,
      priority: 1,
      estimate: 3,
      milestone: { name: "Fase 0", due: "2026-12-31" },
      relations: { blockedBy: [parent] },
    });
  });
});

describe("crear y leer", () => {
  test("aplica los defaults y numera las keys por proyecto", async () => {
    const first = await tracker.createIssue("demo", { title: "primera" });
    const second = await tracker.createIssue("demo", {
      title: "segunda",
      labels: ["a"],
      status: "backlog",
    });
    const other = await tracker.createIssue("otro", {
      title: "de otro proyecto",
    });

    expect(first).toMatchObject({
      ref: { tracker: "local", key: "DEMO-1" },
      project: "demo",
      body: "",
      status: "todo",
      rawStatus: "Todo",
      priority: 0,
      labels: [],
      relations: { blocks: [], blockedBy: [], related: [] },
    });
    expect(first.assignee).toBeUndefined();
    expect(second).toMatchObject({
      ref: { key: "DEMO-2" },
      status: "backlog",
      rawStatus: "Backlog",
      labels: ["a"],
    });
    expect(other.ref.key).toBe("OTRO-1");
    expect(await tracker.listProjects()).toEqual([
      { ref: demo, name: "demo" },
      { ref: { tracker: "local", id: "otro" }, name: "otro" },
    ]);
  });

  test("una hija necesita un padre que exista", async () => {
    const ghost: IssueRef = {
      tracker: "local",
      id: "lis_inexistente",
      key: "DEMO-9",
      url: "clanker-local:///issues/x",
    };
    await expect(
      tracker.createIssue("demo", { title: "hija", parent: ghost }),
    ).rejects.toThrow(IssueNotFoundError);
  });

  test("getIssue de una issue que no existe, o de otro tracker, lanza IssueNotFoundError", async () => {
    const ref = await create("x");
    await expect(tracker.getIssue({ ...ref, id: "lis_otra" })).rejects.toThrow(
      /no existe en el tracker/,
    );
    await expect(
      tracker.getIssue({ ...ref, tracker: "linear" }),
    ).rejects.toThrow(IssueNotFoundError);
  });

  test("listIssues filtra por estado y labels", async () => {
    await create("a", "demo", { labels: ["bug", "no-clanker"] });
    await create("b", "demo", { labels: ["bug"] });
    await create("c", "demo", { labels: ["feature"], status: "done" });
    await create("d", "otro");

    const titles = async (filter: Parameters<LocalTracker["listIssues"]>[1]) =>
      (await tracker.listIssues(demo, filter)).map((issue) => issue.title);

    expect(await titles({})).toEqual(["a", "b", "c"]);
    expect(await titles({ status: ["todo"] })).toEqual(["a", "b"]);
    expect(
      await titles({ status: ["todo"], excludeLabels: ["no-clanker"] }),
    ).toEqual(["b"]);
    expect(await titles({ labels: ["bug", "no-clanker"] })).toEqual(["a"]);
    expect(await titles({ status: ["backlog"] })).toEqual([]);
  });
});

describe("claim, setStatus y comment", () => {
  test("viewer es la persona que reclama", async () => {
    expect(await tracker.viewer()).toEqual({ id: "local", name: "Local" });
  });

  test("claim asigna a la persona y pasa a in_progress", async () => {
    const ref = await create("x");
    await tracker.claim(ref);

    expect(await tracker.getIssue(ref)).toMatchObject({
      assignee: { id: "local", name: "Local" },
      status: "in_progress",
      rawStatus: "In Progress",
    });
  });

  test("claim repetido por la misma persona no falla; otra persona no se la puede quitar", async () => {
    const ref = await create("x");
    await tracker.claim(ref);
    await tracker.claim(ref);

    const other = createLocalTracker(store, { me: { id: "ana", name: "Ana" } });
    await expect(other.claim(ref)).rejects.toThrow(
      /DEMO-1 ya está asignada a Local/,
    );
    expect((await tracker.getIssue(ref)).assignee?.id).toBe("local");
  });

  test("setStatus cambia la categoría y deja el estado original legible", async () => {
    const ref = await create("x");
    await tracker.setStatus(ref, "in_review");
    expect(await tracker.getIssue(ref)).toMatchObject({
      status: "in_review",
      rawStatus: "In Review",
    });
    await tracker.setStatus(ref, "canceled");
    expect(await tracker.getIssue(ref)).toMatchObject({
      status: "canceled",
      rawStatus: "Canceled",
    });
  });

  test("comment agrega comentarios en orden y rechaza uno vacío", async () => {
    const ref = await create("x");
    await tracker.comment(ref, "primero");
    await tracker.comment(ref, "segundo");

    const { comments } = await tracker.getIssue(ref);
    expect(comments.map((c) => [c.text, c.author.id])).toEqual([
      ["primero", "local"],
      ["segundo", "local"],
    ]);
    await expect(tracker.comment(ref, "  ")).rejects.toThrow(/vacío/);
  });

  test("las operaciones sobre una issue que no existe lanzan IssueNotFoundError", async () => {
    const ghost: IssueRef = {
      tracker: "local",
      id: "lis_x",
      key: "DEMO-1",
      url: "clanker-local:///issues/x",
    };
    await expect(tracker.claim(ghost)).rejects.toThrow(IssueNotFoundError);
    await expect(tracker.setStatus(ghost, "done")).rejects.toThrow(
      IssueNotFoundError,
    );
    await expect(tracker.comment(ghost, "hola")).rejects.toThrow(
      IssueNotFoundError,
    );
  });
});

describe("relaciones", () => {
  test("blocks y blockedBy son la misma relación vista desde cada lado", async () => {
    const [a, b, c] = [await create("a"), await create("b"), await create("c")];
    await tracker.relate(a, "blocks", b);
    await tracker.relate(a, "blocks", c);

    expect((await tracker.getIssue(a)).relations).toEqual({
      blocks: [b, c],
      blockedBy: [],
      related: [],
    });
    expect((await tracker.getIssue(b)).relations).toEqual({
      blocks: [],
      blockedBy: [a],
      related: [],
    });
    expect((await tracker.getIssue(c)).relations.blockedBy).toEqual([a]);
  });

  test("related es simétrica sin importar el orden en que se declare", async () => {
    const [a, b] = [await create("a"), await create("b")];
    await tracker.relate(b, "related", a);

    expect((await tracker.getIssue(a)).relations.related).toEqual([b]);
    expect((await tracker.getIssue(b)).relations.related).toEqual([a]);
  });

  test("repetir una relación no cambia nada ni cuenta como cambio", async () => {
    const [a, b] = [await create("a"), await create("b")];
    await tracker.relate(a, "related", b);
    const { cursor } = await tracker.changesSince();

    await tracker.relate(a, "related", b);
    await tracker.relate(b, "related", a);

    expect((await tracker.getIssue(a)).relations.related).toEqual([b]);
    expect(await tracker.changesSince(cursor)).toEqual({ changed: [], cursor });
  });

  test("rechaza relacionar una issue consigo misma o con una que no existe", async () => {
    const a = await create("a");
    await expect(tracker.relate(a, "blocks", a)).rejects.toThrow(
      /consigo misma/,
    );
    await expect(
      tracker.relate(a, "blocks", { ...a, id: "lis_x" }),
    ).rejects.toThrow(IssueNotFoundError);
  });
});

describe("changesSince", () => {
  test("sin cursor devuelve todas las issues y un cursor para seguir", async () => {
    const [a, b] = [await create("a"), await create("b", "otro")];

    const { changed, cursor } = await tracker.changesSince();

    expect(changed).toEqual([a, b]);
    expect(await tracker.changesSince(cursor)).toEqual({ changed: [], cursor });
  });

  test("con cursor devuelve solo lo que cambió después, una vez por issue", async () => {
    await create("a");
    const [b, c] = [await create("b"), await create("c")];
    const { cursor } = await tracker.changesSince();

    await tracker.setStatus(b, "done");
    await tracker.comment(b, "listo");
    await tracker.claim(c);

    const next = await tracker.changesSince(cursor);
    expect(next.changed).toEqual([b, c]);
    expect(next.cursor).not.toBe(cursor);
    expect(await tracker.changesSince(next.cursor)).toEqual({
      changed: [],
      cursor: next.cursor,
    });
  });

  test("un comentario y una relación cuentan como cambio de la issue", async () => {
    const [a, b, c] = [await create("a"), await create("b"), await create("c")];
    const { cursor } = await tracker.changesSince();

    await tracker.comment(a, "hola");
    expect((await tracker.changesSince(cursor)).changed).toEqual([a]);

    const afterComment = (await tracker.changesSince(cursor)).cursor;
    await tracker.relate(b, "blocks", c);
    expect((await tracker.changesSince(afterComment)).changed).toEqual([b, c]);
  });

  test("una base vacía devuelve el cursor de partida", async () => {
    expect(await tracker.changesSince()).toEqual({ changed: [], cursor: "0" });
    expect(await tracker.currentCursor()).toBe("0");
  });

  test("currentCursor es el cursor de changesSince() sin traer las issues", async () => {
    await create("a");
    await create("b");

    expect(await tracker.currentCursor()).toBe((await tracker.changesSince()).cursor);
  });

  test("un cursor que no es de este tracker es un error accionable", async () => {
    await expect(tracker.changesSince("2026-11-15T00:00:00Z")).rejects.toThrow(
      /no es de este tracker/,
    );
  });
});
