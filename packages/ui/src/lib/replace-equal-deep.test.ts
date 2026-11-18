import { describe, expect, test } from "vitest"
import { replaceEqualDeep } from "./replace-equal-deep"

describe("replaceEqualDeep", () => {
  test("lo que vuelve igual es lo anterior, con la misma identidad", () => {
    const prev = [{ id: "a", state: { ci: "green", labels: ["x"] } }, { id: "b", state: null }]
    const next = structuredClone(prev)
    expect(replaceEqualDeep(prev, next)).toBe(prev)
  })

  test("si cambia un elemento, los demás conservan su identidad", () => {
    const prev = [{ id: "a", n: 1 }, { id: "b", n: 2 }]
    const next = [{ id: "a", n: 1 }, { id: "b", n: 3 }]
    const out = replaceEqualDeep(prev, next)
    expect(out).toEqual(next)
    expect(out).not.toBe(prev)
    expect(out[0]).toBe(prev[0])
    expect(out[1]).not.toBe(prev[1])
  })

  test("detecta claves que se agregan, se quitan o cambian de largo", () => {
    expect(replaceEqualDeep({ a: 1 }, { a: 1, b: 2 })).toEqual({ a: 1, b: 2 })
    const prev = { a: 1, b: 2 }
    expect(replaceEqualDeep(prev, { a: 1 })).toEqual({ a: 1 })
    expect(replaceEqualDeep({ a: 1, b: undefined }, { a: 1, c: undefined })).toEqual({ a: 1, c: undefined })
    expect(replaceEqualDeep([1, 2], [1])).toEqual([1])
  })

  test("lo que no es array ni objeto plano se compara por identidad", () => {
    const prev = new Map([["a", 1]])
    const next = new Map([["a", 1]])
    expect(replaceEqualDeep(prev, next)).toBe(next)
    expect(replaceEqualDeep(undefined, [1])).toEqual([1])
  })
})
