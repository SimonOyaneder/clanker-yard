import { afterEach, describe, expect, test } from "vitest";
import { openStore, type Store } from "../../store/store";
import { estimateCostMicros, type TurnTokens } from "../pricing";

const open: Store[] = [];
afterEach(() => {
  for (const store of open.splice(0)) store.close();
});

const store = () => {
  const s = openStore({ path: ":memory:" });
  open.push(s);
  return s;
};

const none: TurnTokens = { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0, tokensCacheWrite1h: 0 };

describe.each([
  { model: "gpt-6-luna", standard: 1630, atLimit: 27_700, aboveLimit: 55_150, cachedAtLimit: 20_500, cachedAboveLimit: 40_750 },
  { model: "gpt-6.1-terra", standard: 16_150, atLimit: 277_000, aboveLimit: 551_502, cachedAtLimit: 200_000, cachedAboveLimit: 397_503 },
  { model: "gpt-6.1-sol", standard: 32_300, atLimit: 554_000, aboveLimit: 1_103_004, cachedAtLimit: 400_000, cachedAboveLimit: 795_005 },
  { model: "gpt-6.2-sol", standard: 32_300, atLimit: 554_000, aboveLimit: 1_103_004, cachedAtLimit: 400_000, cachedAboveLimit: 795_005 },
  { model: "gpt-6.2-astra", standard: 129_200, atLimit: 2_216_000, aboveLimit: 4_412_016, cachedAtLimit: 1_600_000, cachedAboveLimit: 3_180_020 },
  { model: "gpt-5.6-luna", standard: 3660, atLimit: 55_600, aboveLimit: 110_600, cachedAtLimit: 41_200, cachedAboveLimit: 81_801 },
])("precios migrados de Codex: $model", ({ model, standard, atLimit, aboveLimit, cachedAtLimit, cachedAboveLimit }) => {
  test("cobra entrada, salida, lectura y escritura de caché sin inferir otra duración", () => {
    const { db } = store();
    const tokens = { tokensIn: 1000, tokensOut: 2000, tokensCacheRead: 3000, tokensCacheWrite: 4000, tokensCacheWrite1h: 0 };
    expect(estimateCostMicros(db, model, Date.now(), tokens)).toBe(standard);
    expect(estimateCostMicros(db, model, Date.now(), { ...tokens, tokensCacheWrite1h: 1000 })).toBe(standard);
  });

  test("cobra el turno entero con prompt largo solo al superar 272 000 tokens", () => {
    const { db } = store();
    const tokens = { ...none, tokensIn: 272_000, tokensOut: 1000 };
    expect(estimateCostMicros(db, model, Date.now(), tokens)).toBe(atLimit);
    expect(estimateCostMicros(db, model, Date.now(), { ...tokens, tokensIn: 272_001 })).toBe(aboveLimit);
  });

  test("cuenta lectura y escritura de caché en el umbral de prompt largo", () => {
    const { db } = store();
    const tokens = { ...none, tokensIn: 100_000, tokensOut: 1000, tokensCacheRead: 100_000, tokensCacheWrite: 72_000 };
    expect(estimateCostMicros(db, model, Date.now(), tokens)).toBe(cachedAtLimit);
    expect(estimateCostMicros(db, model, Date.now(), { ...tokens, tokensCacheWrite: 72_001 })).toBe(cachedAboveLimit);
  });
});
