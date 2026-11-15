import { afterEach, describe, expect, test } from "vitest";
import { openStore, type Store } from "../store/store";
import { Profile } from "@clanker/api";
import { createDefs } from "./defs";
import { createDefWriter, DefNotFoundError, diffBodies } from "./write";

const open: Store[] = [];
afterEach(() => {
  for (const store of open.splice(0)) store.close();
});

describe("update por slug", () => {
  function setup() {
    const store = openStore({ path: ":memory:" });
    open.push(store);
    const defs = createDefs(store);
    defs.register("profile", Profile);
    const writer = createDefWriter({ defs, flows: { validate: () => ({ errors: [], warnings: [] }), save: () => { throw new Error("no es un flujo"); } } });
    const { id } = defs.save({ kind: "profile", slug: "default", scope: "user", body: { roles: { dev: { model: "sonnet" } } }, source: "ui" });
    return { defs, writer, id };
  }
  const body = { roles: { dev: { model: "opus" } } };

  test("acepta el slug además del id y deja la misma versión nueva", () => {
    const { defs, writer, id } = setup();

    const bySlug = writer.update({ kind: "profile", id: "default", body, dryRun: false }, "mcp");

    expect(bySlug).toMatchObject({ changed: true, def: { id, slug: "default", version: 2 } });
    expect(defs.get("profile", id)?.body).toEqual(body);
    expect(writer.update({ kind: "profile", id, body, dryRun: false }, "mcp")).toMatchObject({ changed: false });
  });

  test("un slug que no existe es NOT_FOUND", () => {
    const { writer } = setup();
    expect(() => writer.update({ kind: "profile", id: "nadie", body, dryRun: false }, "mcp")).toThrow(DefNotFoundError);
  });
});

describe("diffBodies", () => {
  test("dice las hojas que cambian, con su ruta, y nada si es lo mismo", () => {
    const before = { name: "A", modes: { dev: { outcomes: ["ok"], session: "new" } }, hooks: true };
    const after = { name: "B", modes: { dev: { outcomes: ["ok", "fail"], session: "new" } } };

    expect(diffBodies(before, before)).toEqual([]);
    expect(diffBodies(before, after)).toEqual([
      { path: "hooks", before: true, after: undefined },
      { path: "modes.dev.outcomes", before: ["ok"], after: ["ok", "fail"] },
      { path: "name", before: "A", after: "B" },
    ]);
  });

  test("el orden de las claves no cuenta y un body nuevo es un solo cambio en la raíz", () => {
    expect(diffBodies({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toEqual([]);
    expect(diffBodies(undefined, { a: 1 })).toEqual([{ path: "", before: undefined, after: { a: 1 } }]);
  });
});
