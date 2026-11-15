import { describe, expect, test } from "vitest";
import { parseLegacyMetrics } from "./legacy-metrics";

describe("parseLegacyMetrics", () => {
  test("lee las líneas, ignora las vacías y deja mode en real si falta", () => {
    const text = [
      '{"issue":"ENG-1","result":"listo","usd":5.77,"minutes":45,"review-rounds":2,"por_rol":{"dev":{"modelo":"opus","effort":"xhigh","tokens":10,"usd":2.05}}}',
      "",
      '{"issue":"ENG-2","result":"falló","mode":"council","usd":0,"extra":"se conserva"}',
    ].join("\n");

    expect(parseLegacyMetrics(text)).toEqual([
      {
        issue: "ENG-1",
        result: "listo",
        mode: "real",
        usd: 5.77,
        minutes: 45,
        "review-rounds": 2,
        por_rol: { dev: { modelo: "opus", effort: "xhigh", tokens: 10, usd: 2.05 } },
      },
      { issue: "ENG-2", result: "falló", mode: "council", usd: 0, extra: "se conserva" },
    ]);
  });

  test("una línea corrupta o sin issue lanza con su número", () => {
    expect(() => parseLegacyMetrics('{"issue":"ENG-1","result":"listo"}\n{roto')).toThrow("metrics.jsonl línea 2: no es JSON.");
    expect(() => parseLegacyMetrics('{"result":"listo"}')).toThrow(/línea 1:.*issue/s);
  });
});
