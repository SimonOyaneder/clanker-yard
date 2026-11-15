import { describe, expect, test } from "vitest"
import { compactCount, costUsd, elapsed } from "./format"

describe("costUsd", () => {
  test("un costo bajo $1 conserva sus decimales y uno mayor se redondea a centavos", () => {
    expect(costUsd(0)).toBe("$0")
    expect(costUsd(12_500)).toBe("$0.0125")
    expect(costUsd(100_000)).toBe("$0.10")
    expect(costUsd(3_100_000)).toBe("$3.10")
  })
})

describe("elapsed", () => {
  test("segundos, minutos y horas", () => {
    expect(elapsed(48_000)).toBe("48 s")
    expect(elapsed(125_000)).toBe("2 min 05 s")
    expect(elapsed(3_780_000)).toBe("1 h 03 min")
  })
})

describe("compactCount", () => {
  test("miles y millones con coma decimal", () => {
    expect(compactCount(820)).toBe("820")
    expect(compactCount(48_200)).toBe("48,2 k")
    expect(compactCount(6_200_000)).toBe("6,2 M")
    expect(compactCount(2_000_000)).toBe("2 M")
  })
})
