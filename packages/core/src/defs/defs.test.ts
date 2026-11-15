import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { openStore, type Store } from "../store/store";
import { defVersions } from "../store/schema";
import { createDefs, DefValidationError, type Defs } from "./defs";

const open: Store[] = [];
afterEach(() => {
  for (const store of open.splice(0)) store.close();
});

const flowBody = z.object({ name: z.string(), steps: z.array(z.object({ id: z.string() })) });

function setup(): { store: Store; defs: Defs } {
  const store = openStore({ path: ":memory:" });
  open.push(store);
  const defs = createDefs(store);
  defs.register("flow", flowBody);
  defs.register("role", z.object({ prompt: z.string() }));
  return { store, defs };
}

const flow = { kind: "flow", slug: "dev", scope: "user", source: "ui" } as const;
const body = { name: "dev", steps: [{ id: "plan" }] };

describe("validate", () => {
  test("devuelve el body parseado y no guarda nada", () => {
    const { store, defs } = setup();

    expect(defs.validate("flow", "dev", body)).toEqual(body);

    expect(defs.list("flow")).toEqual([]);
    expect(store.events.since(0)).toEqual([]);
  });

  test("un body inválido lanza con la ruta del error", () => {
    const { defs } = setup();

    expect(() => defs.validate("flow", "dev", { name: "dev", steps: [{ id: 7 }] })).toThrow(
      /steps\.0\.id/,
    );
  });
});

describe("save", () => {
  test("guardar dos veces el mismo body no crea una versión nueva ni un evento", () => {
    const { store, defs } = setup();

    const first = defs.save({ ...flow, body });
    const again = defs.save({ ...flow, body: { steps: [{ id: "plan" }], name: "dev" } });

    expect(first).toMatchObject({ version: 1, changed: true });
    expect(again).toEqual({ id: first.id, version: 1, changed: false });
    expect(defs.versions("flow", first.id)).toHaveLength(1);
    expect(store.events.since(0).map((e) => e.type)).toEqual(["def.versioned"]);
  });

  test("un body distinto crea la versión siguiente y las anteriores siguen legibles", () => {
    const { store, defs } = setup();
    const { id } = defs.save({ ...flow, body });

    const next = defs.save({ ...flow, body: { ...body, name: "dev v2" }, source: "mcp" });

    expect(next).toEqual({ id, version: 2, changed: true });
    expect(defs.get("flow", id)).toMatchObject({ version: 2, currentVersion: 2, source: "mcp" });
    expect(defs.get("flow", id, 1)).toMatchObject({ version: 1, currentVersion: 2, body });
    expect(defs.versions("flow", id).map((v) => v.version)).toEqual([2, 1]);
    expect(store.events.since(0).map((e) => [e.type, e.origin, e.payload])).toEqual([
      ["def.versioned", "ui", { kind: "flow", defId: id, version: 1, source: "ui" }],
      ["def.versioned", "mcp", { kind: "flow", defId: id, version: 2, source: "mcp" }],
    ]);
  });

  test("un body inválido se rechaza con la ruta del error y no guarda nada", () => {
    const { store, defs } = setup();

    const error = (() => {
      try {
        defs.save({ ...flow, body: { name: "dev", steps: [{ id: "a" }, { id: 7 }] } });
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(DefValidationError);
    expect((error as DefValidationError).issues.map((i) => i.path)).toEqual([["steps", 1, "id"]]);
    expect((error as DefValidationError).message).toContain("steps.1.id");
    expect(defs.list("flow")).toEqual([]);
    expect(store.events.since(0)).toEqual([]);
  });

  test("un kind sin validador registrado se rechaza con un mensaje accionable", () => {
    const { defs } = setup();
    expect(() => defs.save({ ...flow, kind: "recipe", body: {} })).toThrow(/defs\.register/);
  });

  test("repoId es obligatorio con scope repo y no se admite en los demás", () => {
    const { defs } = setup();
    expect(() => defs.save({ ...flow, scope: "repo", body })).toThrow(/repoId/);
    expect(() => defs.save({ ...flow, repoId: "repo_1", body })).toThrow(/repoId/);
  });

  test("el mismo slug en scopes distintos son defs distintas", () => {
    const { defs } = setup();
    const user = defs.save({ ...flow, body });
    const builtin = defs.save({ ...flow, scope: "builtin", body });
    const repoA = defs.save({ ...flow, scope: "repo", repoId: "repo_a", body });
    const repoB = defs.save({ ...flow, scope: "repo", repoId: "repo_b", body });

    expect(new Set([user.id, builtin.id, repoA.id, repoB.id]).size).toBe(4);
  });

  test("no permite guardar sobre una def archivada hasta restaurarla", () => {
    const { defs } = setup();
    const { id } = defs.save({ ...flow, body });
    defs.archive("flow", id, "ui");

    expect(() => defs.save({ ...flow, body: { ...body, name: "otro" } })).toThrow(/restáurala/);
    defs.restore("flow", id, "ui");
    expect(defs.save({ ...flow, body: { ...body, name: "otro" } }).version).toBe(2);
  });
});

describe("get y list", () => {
  test("get no encuentra un id bajo otro kind", () => {
    const { defs } = setup();
    const { id } = defs.save({ ...flow, body });

    expect(defs.get("role", id)).toBeUndefined();
    expect(defs.get("flow", "def_nope")).toBeUndefined();
    expect(defs.get("flow", id, 9)).toBeUndefined();
  });

  test("list devuelve solo el kind pedido y esconde las archivadas", () => {
    const { defs } = setup();
    const a = defs.save({ ...flow, slug: "a", body });
    defs.save({ ...flow, slug: "b", body });
    defs.save({ kind: "role", slug: "r", scope: "user", source: "ui", body: { prompt: "x" } });
    defs.archive("flow", a.id, "ui");

    expect(defs.list("flow").map((d) => d.slug)).toEqual(["b"]);
    expect(defs.list("flow", { includeArchived: true }).map((d) => d.slug)).toEqual(["a", "b"]);
    expect(defs.list("role").map((d) => d.slug)).toEqual(["r"]);
  });
});

describe("resolve", () => {
  function saveInEveryScope(defs: Defs): void {
    for (const scope of ["builtin", "pack", "user"] as const) {
      defs.save({ ...flow, scope, body: { ...body, name: scope } });
    }
    for (const repoId of ["repo_a", "repo_b"]) {
      defs.save({ ...flow, scope: "repo", repoId, body: { ...body, name: repoId } });
    }
  }
  const nameOf = (d: { body: unknown } | undefined) => (d?.body as { name: string } | undefined)?.name;

  test("gana user, luego repo, luego pack, luego builtin", () => {
    const { defs } = setup();
    saveInEveryScope(defs);
    const resolve = (repoId?: string) => nameOf(defs.resolve("flow", "dev", { repoId }));
    const archive = (scope: string) => {
      const target = defs.list("flow").find((d) => d.scope === scope)!;
      defs.archive("flow", target.id, "ui");
    };

    expect(resolve("repo_a")).toBe("user");
    archive("user");
    expect(resolve("repo_a")).toBe("repo_a");
    expect(resolve("repo_b")).toBe("repo_b");
    expect(resolve()).toBe("pack");
    archive("pack");
    expect(resolve()).toBe("builtin");
    expect(resolve("repo_a")).toBe("repo_a");
  });

  test("la def de repo de otro repo no se cuela y un slug desconocido no resuelve", () => {
    const { defs } = setup();
    defs.save({ ...flow, scope: "repo", repoId: "repo_a", body });

    expect(defs.resolve("flow", "dev", { repoId: "repo_b" })).toBeUndefined();
    expect(defs.resolve("flow", "dev")).toBeUndefined();
    expect(defs.resolve("flow", "otro", { repoId: "repo_a" })).toBeUndefined();
  });
});

describe("archive y restore", () => {
  test("archivar y restaurar emiten su evento una sola vez y son idempotentes", () => {
    const { store, defs } = setup();
    const { id } = defs.save({ ...flow, body });

    defs.archive("flow", id, "mcp");
    defs.archive("flow", id, "mcp");
    expect(defs.get("flow", id)?.archivedAt).not.toBeNull();
    defs.restore("flow", id, "ui");
    defs.restore("flow", id, "ui");
    expect(defs.get("flow", id)?.archivedAt).toBeNull();

    expect(store.events.since(0).slice(1).map((e) => [e.type, e.origin, e.payload])).toEqual([
      ["def.archived", "mcp", { kind: "flow", defId: id, version: 1 }],
      ["def.restored", "ui", { kind: "flow", defId: id, version: 1 }],
    ]);
  });

  test("una def inexistente falla con su kind e id", () => {
    const { defs } = setup();
    expect(() => defs.archive("flow", "def_nope", "ui")).toThrow("flow def_nope");
  });
});

describe("inmutabilidad de def_versions", () => {
  test("el trigger rechaza UPDATE y DELETE", () => {
    const { store, defs } = setup();
    const { id } = defs.save({ ...flow, body });

    // drizzle envuelve el error de SQLite en `cause`.
    const immutable = expect.objectContaining({
      cause: expect.objectContaining({ message: expect.stringContaining("inmutable") }),
    });
    expect(() =>
      store.tx((tx) => tx.db.update(defVersions).set({ source: "otro" }).run()),
    ).toThrow(immutable);
    expect(() => store.tx((tx) => tx.db.delete(defVersions).run())).toThrow(immutable);
    expect(defs.get("flow", id)).toMatchObject({ version: 1, source: "ui" });
  });
});
