import { describe, expect, test } from "vitest"
import { footerStatus } from "./core-status"

const ok = { error: null, updatedAt: null }

describe("footerStatus", () => {
  test("con el core vivo dice core en vivo", () => {
    expect(footerStatus({ status: "live", version: "0.0.0" }, ok)).toEqual({ text: "core en vivo", tone: "live" })
  })

  test("el core caído o arrancando manda sobre los datos", () => {
    const failing = { error: "boom", updatedAt: 1 }
    expect(footerStatus({ status: "down", reason: "x" }, failing)).toEqual({ text: "core caído", tone: "down" })
    expect(footerStatus({ status: "starting" }, failing)).toEqual({ text: "iniciando core…", tone: "pending" })
  })

  test("con el core vivo y un error de datos muestra el error", () => {
    expect(footerStatus({ status: "live", version: "0.0.0" }, { error: "boom", updatedAt: null }).tone).toBe("error")
  })

  test("sin core propio sigue el último poll", () => {
    expect(footerStatus(undefined, ok).text).toBe("cargando…")
    expect(footerStatus(undefined, { error: null, updatedAt: 10_000 }, 15_000).text).toBe("en vivo · hace 5 s")
  })
})
