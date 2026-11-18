import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SLOW_TESTS, testTier } from "../vitest.slow.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("testTier", () => {
  // `testTier(undefined, ...)` lee `CLANKER_TESTS`, y `npm run test:all` corre con `all`.
  beforeEach(() => vi.stubEnv("CLANKER_TESTS", undefined));
  afterEach(() => vi.unstubAllEnvs());

  test("sin variable ni filtros la suite deja fuera los lentos", () => {
    expect(testTier(undefined, ["run"])).toBe("fast");
    expect(testTier("", [])).toBe("fast");
  });

  test("CLANKER_TESTS manda", () => {
    expect(testTier("slow", ["run", "packages/ui"])).toBe("slow");
    expect(testTier("all", ["run"])).toBe("all");
    expect(testTier("fast", ["run", "night"])).toBe("fast");
    expect(() => testTier("todo", [])).toThrow(/fast, slow o all/);
  });

  test("nombrar archivos o carpetas, o pedir related, corre también los lentos", () => {
    expect(testTier(undefined, ["run", "packages/testkit/src/night.test.ts"])).toBe("all");
    expect(testTier(undefined, ["run", "night"])).toBe("all");
    expect(testTier(undefined, ["related", "--run", "packages/core/src/store/store.ts"])).toBe("all");
    expect(testTier(undefined, ["run", "--maxWorkers=3", "--testTimeout=30000"])).toBe("fast");
  });
});

test("cada test lento de la lista existe", () => {
  expect(SLOW_TESTS.filter((file) => !existsSync(join(root, file)))).toEqual([]);
});
