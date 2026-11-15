import { describe, expect, test } from "vitest";
import { diffBodies } from "./write";

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
