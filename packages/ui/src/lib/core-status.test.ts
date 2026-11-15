import { describe, expect, test } from "vitest"
import { footerStatus } from "./core-status"

const live = { error: null, connected: true }

describe("footerStatus", () => {
  test("con el stream conectado dice core en vivo", () => {
    expect(footerStatus({ status: "live", version: "0.0.0" }, live)).toEqual({ text: "core en vivo", tone: "live" })
    expect(footerStatus(undefined, live)).toEqual({ text: "core en vivo", tone: "live" })
  })

  test("el core caído o arrancando manda sobre los datos", () => {
    const failing = { error: "boom", connected: false }
    expect(footerStatus({ status: "down", reason: "x" }, failing)).toEqual({ text: "core caído", tone: "down" })
    expect(footerStatus({ status: "starting" }, failing)).toEqual({ text: "iniciando core…", tone: "pending" })
  })

  test("un error de datos se muestra aunque el stream siga conectado", () => {
    expect(footerStatus({ status: "live", version: "0.0.0" }, { error: "boom", connected: true }).tone).toBe("error")
  })

  test("sin conexión todavía, o tras una caída del stream, está conectando", () => {
    expect(footerStatus(undefined, { error: null, connected: false })).toEqual({ text: "conectando…", tone: "pending" })
  })
})
