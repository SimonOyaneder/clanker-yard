import { describe, expect, test } from "vitest";
import type { BranchResult } from "./catalog";
import { itemsMerge, worst } from "./consolidators";

const branch = (outcome: string, output: unknown = {}): BranchResult => ({ outcome, output });
const args = { items: "findings", rank: "severity", changesIf: ["red", "yellow"] } as const;
const finding = (severity: string, path: string, line: number, claim: string, extra: Record<string, unknown> = {}) => ({
  id: "local",
  severity,
  path,
  line,
  claim,
  ...extra,
});
const merge = (byBranch: Record<string, BranchResult>, extra: Record<string, unknown> = {}) =>
  itemsMerge.run(byBranch, itemsMerge.args!.parse({ ...args, ...extra }));
const claims = (result: ReturnType<typeof merge>) =>
  (result.output as { findings: { claim: string }[] }).findings.map((f) => f.claim);

describe("worst", () => {
  test("elige error > fail > changes > ok", () => {
    expect(worst.run({ a: branch("ok"), b: branch("changes") }, {}).outcome).toBe("changes");
    expect(worst.run({ a: branch("changes"), b: branch("fail"), c: branch("ok") }, {}).outcome).toBe("fail");
    expect(worst.run({ a: branch("fail"), b: branch("error") }, {}).outcome).toBe("error");
  });

  test("sin ramas da ok y deja el output de cada una", () => {
    expect(worst.run({}, {}).outcome).toBe("ok");
    expect(worst.run({ a: branch("ok", { n: 1 }) }, {}).output).toEqual({ branches: { a: { outcome: "ok", output: { n: 1 } } } });
  });

  test("un outcome que no conoce es un error con la rama", () => {
    expect(() => worst.run({ a: branch("reply") }, {})).toThrow(/outcome "reply" de la rama "a"/);
  });
});

describe("items.merge", () => {
  test("agrupa por path y línea con ±3 y deja el de mayor rango", () => {
    const result = merge({
      a: branch("changes", { findings: [finding("yellow", "x.ts", 10, "a-10")] }),
      b: branch("changes", { findings: [finding("red", "x.ts", 13, "b-13"), finding("yellow", "x.ts", 14, "b-14")] }),
    });

    // 13 está a 3 de 10 (mismo hallazgo, gana el rojo); 14 está a 4 y queda aparte.
    expect(claims(result)).toEqual(["b-13", "b-14"]);
    expect(result.outcome).toBe("changes");
  });

  test("otro path o más de 3 líneas no se agrupan", () => {
    const result = merge({
      a: branch("changes", { findings: [finding("yellow", "x.ts", 10, "uno")] }),
      b: branch("changes", { findings: [finding("yellow", "y.ts", 10, "dos"), finding("yellow", "x.ts", 20, "tres")] }),
    });

    expect(claims(result)).toEqual(["uno", "dos", "tres"]);
  });

  test("dos hallazgos de la misma rama cerca no se funden: el reviewer ya los distinguió", () => {
    const result = merge({
      a: branch("changes", { findings: [finding("yellow", "x.ts", 10, "uno"), finding("yellow", "x.ts", 11, "dos")] }),
    });

    expect(claims(result)).toEqual(["uno", "dos"]);
  });

  test("a igual rango gana el trivial, y si no, el de la rama anterior", () => {
    const trivial = merge({
      a: branch("ok", { findings: [finding("white", "x.ts", 1, "a")] }),
      b: branch("ok", { findings: [finding("white", "x.ts", 2, "b", { trivial: true })] }),
    });
    const first = merge({
      a: branch("changes", { findings: [finding("yellow", "x.ts", 1, "a")] }),
      b: branch("changes", { findings: [finding("yellow", "x.ts", 2, "b")] }),
    });

    expect(claims(trivial)).toEqual(["b"]);
    expect(claims(first)).toEqual(["a"]);
  });

  test("los ⚪ pasan solo con trivial y no piden cambios", () => {
    const result = merge({
      a: branch("ok", {
        findings: [finding("white", "x.ts", 1, "nit"), finding("white", "x.ts", 50, "typo", { trivial: true })],
      }),
    });

    expect(claims(result)).toEqual(["typo"]);
    expect(result.outcome).toBe("ok");
  });

  test("ordena 🔴 → 🟡 → ⚪ y respeta el orden de llegada dentro de un rango", () => {
    const result = merge({
      a: branch("changes", { findings: [finding("white", "a.ts", 1, "w", { trivial: true }), finding("yellow", "a.ts", 30, "y1")] }),
      b: branch("changes", { findings: [finding("red", "b.ts", 1, "r"), finding("yellow", "b.ts", 30, "y2")] }),
    });

    expect(claims(result)).toEqual(["r", "y1", "y2", "w"]);
  });

  test("changesIf, order y onlyIfTrivial son configurables", () => {
    const byBranch = { a: branch("ok", { findings: [finding("low", "a.ts", 1, "x"), finding("high", "a.ts", 50, "y")] }) };

    const result = merge(byBranch, { order: ["high", "low"], changesIf: ["high"], onlyIfTrivial: ["low"] });

    expect(claims(result)).toEqual(["y"]);
    expect(result.outcome).toBe("changes");
  });

  test("el id es el hash de las claves indicadas: estable entre rondas y distinto por rama o claim", () => {
    const round1 = merge({ a: branch("changes", { findings: [finding("yellow", "x.ts", 10, "uno", { id: "f1" })] }) });
    const round2 = merge({ a: branch("changes", { findings: [finding("yellow", "x.ts", 14, "uno", { id: "f9", fix: "otro texto" })] }) });
    const other = merge({ b: branch("changes", { findings: [finding("yellow", "x.ts", 10, "uno")] }) });
    const another = merge({ a: branch("changes", { findings: [finding("yellow", "x.ts", 10, "dos")] }) });
    const byPath = merge({ a: branch("changes", { findings: [finding("yellow", "y.ts", 10, "uno")] }) }, { idKeys: ["claim"] });
    const byClaim = merge({ a: branch("changes", { findings: [finding("yellow", "x.ts", 10, "uno")] }) }, { idKeys: ["claim"] });
    const id = (r: ReturnType<typeof merge>) => (r.output as { findings: { id: string }[] }).findings[0]?.id;

    expect(id(round1)).toMatch(/^[0-9a-f]{12}$/);
    expect(id(round2)).toBe(id(round1));
    expect(id(other)).not.toBe(id(round1));
    expect(id(another)).not.toBe(id(round1));
    expect(id(byPath)).toBe(id(byClaim));
  });

  test("una rama sin la lista no aporta; una lista mal formada o un rango desconocido son errores", () => {
    expect(claims(merge({ a: branch("ok", {}), b: branch("ok", null) }))).toEqual([]);
    expect(() => merge({ a: branch("ok", { findings: "x" }) })).toThrow(/"findings" de la rama "a" no es una lista/);
    expect(() => merge({ a: branch("ok", { findings: [3] }) })).toThrow(/no es un objeto/);
    expect(() => merge({ a: branch("ok", { findings: [finding("orange", "a.ts", 1, "x")] }) })).toThrow(/severity "orange"/);
  });

  test("rechaza args con claves desconocidas", () => {
    expect(itemsMerge.args!.safeParse({ ...args, window: 3, idkeys: [] }).success).toBe(false);
  });
});
