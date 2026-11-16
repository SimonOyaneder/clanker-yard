import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { catalogPrices, estimateMicros } from "./prices";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Un `XDG_CACHE_HOME` con el catálogo de opencode. */
function cacheWith(catalog: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-prices-"));
  dirs.push(dir);
  mkdirSync(join(dir, "opencode"));
  writeFileSync(join(dir, "opencode", "models.json"), JSON.stringify(catalog));
  return dir;
}

const terra = {
  input: 1,
  output: 5,
  cache_read: 0.05,
  cache_write: 1.25,
  tiers: [{ input: 2, output: 7.5, cache_read: 0.1, cache_write: 2.5, tier: { type: "context", size: 272000 } }],
};

describe("catalogPrices", () => {
  test("lee el precio de proveedor/modelo del catálogo de models.dev que baja opencode, con sus tramos", () => {
    const priceOf = catalogPrices({ XDG_CACHE_HOME: cacheWith({ openai: { models: { "gpt-6.1-terra": { cost: terra } } } }) });

    expect(priceOf("openai/gpt-6.1-terra")).toEqual({
      input: 1,
      output: 5,
      cache_read: 0.05,
      cache_write: 1.25,
      tiers: [{ size: 272000, rates: { input: 2, output: 7.5, cache_read: 0.1, cache_write: 2.5 } }],
    });
    expect(priceOf("openai/otro")).toBeUndefined();
    expect(priceOf("sin-proveedor")).toBeUndefined();
  });

  test("sin catálogo, o con uno que no se entiende, no hay precios", () => {
    expect(catalogPrices({ XDG_CACHE_HOME: join(tmpdir(), "no-existe-opencode") })("openai/gpt-6.1-terra")).toBeUndefined();
    const broken = cacheWith("no es un catálogo");
    expect(catalogPrices({ XDG_CACHE_HOME: broken })("openai/gpt-6.1-terra")).toBeUndefined();
  });
});

describe("estimateMicros", () => {
  const tokens = (input: number, output: number, read = 0) => ({ input, output, reasoning: 0, cache: { read, write: 0 } });

  test("cobra cada tipo de token a su tarifa por millón", () => {
    expect(estimateMicros({ input: 1, output: 5, cache_read: 0.05 }, tokens(100_000, 10_000, 100_000))).toBe(155_000);
  });

  test("un prompt más largo que el tramo usa la tarifa del tramo", () => {
    const price = { input: 1, output: 5, cache_read: 0.05, tiers: [{ size: 272_000, rates: { input: 2, output: 7.5, cache_read: 0.1 } }] };
    expect(estimateMicros(price, tokens(100_000, 10_000, 100_000))).toBe(155_000);
    expect(estimateMicros(price, tokens(200_000, 10_000, 100_000))).toBe(485_000);
  });
});
