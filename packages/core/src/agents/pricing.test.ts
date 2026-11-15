import { afterEach, describe, expect, test } from "vitest";
import { modelPrices } from "../store/schema";
import { openStore, type Store } from "../store/store";
import { estimateCostMicros, type TurnTokens } from "./pricing";

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

describe("estimateCostMicros", () => {
  test("cobra entrada, salida, lectura y las dos escrituras de caché con los precios sembrados", () => {
    const { db } = store();
    const tokens = { tokensIn: 1000, tokensOut: 500, tokensCacheRead: 10_000, tokensCacheWrite: 3000, tokensCacheWrite1h: 1000 };
    // opus: $4 entrada, $20 salida, $0,20 lectura, escritura 5 min 1,25x y 1 h 2x la entrada.
    expect(estimateCostMicros(db, "claude-opus-4-8", Date.now(), tokens)).toBe(4000 + 10_000 + 2000 + 2 * 5000 + 8000);
    expect(estimateCostMicros(db, "haiku", Date.now(), { ...none, tokensIn: 1_000_000 })).toBe(100_000);
  });

  test("rige el precio más reciente anterior al turno y el nombre más específico", () => {
    const s = store();
    const price = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
    s.tx((tx) =>
      tx.db
        .insert(modelPrices)
        .values([
          { model: "opus", ...price, input: 9_000_000, validFrom: 1000 },
          { model: "opus-4-8", ...price, validFrom: 500 },
        ])
        .run(),
    );
    const oneMillion = { ...none, tokensIn: 1_000_000 };

    expect(estimateCostMicros(s.db, "claude-opus-4-5", 999, oneMillion)).toBe(4_000_000);
    expect(estimateCostMicros(s.db, "claude-opus-4-5", 1000, oneMillion)).toBe(9_000_000);
    expect(estimateCostMicros(s.db, "claude-opus-4-8", 1000, oneMillion)).toBe(1_000_000);
  });

  test("un modelo sin precio es undefined, salvo que el turno no haya gastado nada", () => {
    const { db } = store();
    expect(estimateCostMicros(db, "claude-mystery-1", Date.now(), { ...none, tokensIn: 1 })).toBeUndefined();
    expect(estimateCostMicros(db, "<synthetic>", Date.now(), none)).toBe(0);
  });
});
