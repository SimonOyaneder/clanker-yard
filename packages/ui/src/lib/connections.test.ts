import type { ClaudeStatus, Connection } from "@clanker/api"
import { describe, expect, test } from "vitest"
import { claudeLook, codeCountdown, connectionOf, expiryLabel, needsAttention, statusLook, untilReset, usagePercent, usageTone } from "./connections"

const NOW = Date.parse("2026-11-15T12:00:00Z")
const DAY = 86_400_000
const conn = (fields: Partial<Connection> = {}): Connection => ({ provider: "github", account: "octocat", scopes: [], status: "active", ...fields })
const claude = (state: ClaudeStatus["state"]): ClaudeStatus => ({ mode: "subscription", state })

describe("statusLook", () => {
  test("sin cuenta es sin configurar; activa, por vencer, vencida y revocada se distinguen", () => {
    expect(statusLook(undefined).label).toBe("sin configurar")
    expect(statusLook(conn()).label).toBe("conectada")
    expect(statusLook(conn({ expiresSoon: true })).label).toBe("por vencer")
    expect(statusLook(conn({ status: "expired" })).label).toBe("vencida")
    expect(statusLook(conn({ status: "revoked" })).label).toBe("revocada")
  })
})

describe("expiryLabel", () => {
  test("cuenta los días completos de una conexión activa y calla si no vence", () => {
    expect(expiryLabel(conn({ expiresAt: NOW + 12.5 * DAY }), NOW)).toBe("vence en 12 d")
    expect(expiryLabel(conn({ expiresAt: NOW + 3_600_000 }), NOW)).toBe("vence hoy")
    expect(expiryLabel(conn(), NOW)).toBeNull()
    expect(expiryLabel(undefined, NOW)).toBeNull()
  })

  test("una vencida dice la fecha aunque el reloj de la ventana no coincida con el del core, y una revocada calla", () => {
    expect(expiryLabel(conn({ status: "expired", expiresAt: Date.parse("2026-12-20T12:00:00Z") }), NOW)).toBe("venció el 20 dic")
    expect(expiryLabel(conn({ status: "revoked", expiresAt: NOW + DAY }), NOW)).toBeNull()
  })
})

describe("connectionOf", () => {
  test("la API key de Claude manda sobre la suscripción, como en el core", () => {
    const list = [conn({ provider: "claude", account: "subscription" }), conn({ provider: "claude", account: "api-key" }), conn({ provider: "linear", account: "acme" })]
    expect(connectionOf(list, "claude")?.account).toBe("api-key")
    expect(connectionOf(list, "linear")?.account).toBe("acme")
    expect(connectionOf(list, "github")).toBeUndefined()
  })
})

describe("claudeLook", () => {
  test("la última prueba manda; sin prueba, lo que sabe la base", () => {
    expect(claudeLook(conn({ provider: "claude", status: "expired" }), claude("ready")).label).toBe("lista")
    expect(claudeLook(conn({ provider: "claude", status: "expired" }), null).label).toBe("vencida")
    expect(claudeLook(undefined, null).label).toBe("sin configurar")
  })
})

describe("needsAttention", () => {
  test("enciende con una conexión vencida o revocada, o con un Claude caído", () => {
    expect(needsAttention([conn()], null)).toBe(false)
    expect(needsAttention([conn(), conn({ provider: "linear", status: "expired" })], null)).toBe(true)
    expect(needsAttention([conn({ status: "revoked" })], claude("ready"))).toBe(true)
    expect(needsAttention([], claude("login_expired"))).toBe(true)
    expect(needsAttention([], claude("not_installed"))).toBe(true)
  })

  test("sin configurar, por vencer, cuota agotada o un error pasajero no son caídas", () => {
    expect(needsAttention([], null)).toBe(false)
    expect(needsAttention([conn({ expiresSoon: true })], null)).toBe(false)
    expect(needsAttention([], claude("quota_exhausted"))).toBe(false)
    expect(needsAttention([], claude("error"))).toBe(false)
  })
})

describe("uso del plan", () => {
  test("el porcentaje se acota a 0..100 y el tono sube a 70% y 90%", () => {
    expect(usagePercent(0.154)).toBe(15)
    expect(usagePercent(1.4)).toBe(100)
    expect(usagePercent(-1)).toBe(0)
    expect([69, 70, 89, 90].map(usageTone)).toEqual(["ok", "warn", "warn", "danger"])
  })

  test("falta hasta la renovación en horas:minutos, y nada si ya pasó o no se sabe", () => {
    expect(untilReset(NOW + 83 * 60_000, NOW)).toBe("1:23")
    expect(untilReset(NOW - 1, NOW)).toBeNull()
    expect(untilReset(undefined, NOW)).toBeNull()
  })
})

describe("codeCountdown", () => {
  test("minutos y segundos hasta que vence el código, sin bajar de 0:00", () => {
    const now = Date.UTC(2026, 10, 15, 12)
    expect(codeCountdown(now + 900_000, now)).toBe("15:00")
    expect(codeCountdown(now + 872_300, now)).toBe("14:33")
    expect(codeCountdown(now + 5_000, now)).toBe("0:05")
    expect(codeCountdown(now - 1_000, now)).toBe("0:00")
  })
})
