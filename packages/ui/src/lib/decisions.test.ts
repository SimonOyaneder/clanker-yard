import { APPROVE_LOCAL_PUBLISH, DECLINE_LOCAL_PUBLISH, type Decision } from "@clanker/api"
import { expect, test } from "vitest"
import { isDestructive, optionLabel, optionsOf, parksRun, resolutionText, resolvedToday, SEEN, takesText, visibleDecisions } from "@/lib/decisions"

const NOW = Date.parse("2026-11-15T12:00:00Z")

const decision = (n: number, d: Partial<Decision> = {}): Decision => ({
  id: `dec_${String(n).padStart(26, "0")}` as Decision["id"],
  projectId: null,
  runId: null,
  stepRunId: null,
  subject: null,
  kind: "review_note",
  title: `decisión ${n}`,
  body: "",
  options: [],
  status: "pending",
  resolution: null,
  resolvedBy: null,
  createdAt: NOW - n * 60_000,
  resolvedAt: null,
  ...d,
})

test("las opciones de un gate se leen con la etiqueta de su cuerpo y las de un needs_human con su significado", () => {
  const gate = decision(1, { kind: "gate", body: "go: Seguir con el PR\nstop: Parar", options: ["go", "stop"] })
  expect(optionLabel(gate, "go")).toBe("Seguir con el PR")
  expect(optionLabel(gate, "otra")).toBe("otra")

  const stuck = decision(2, { kind: "needs_human", options: ["retry", "force:ok", "cancel"] })
  expect(["retry", "force:ok", "cancel"].map((o) => optionLabel(stuck, o))).toEqual(["Reintentar el paso", 'Seguir como "ok"', "Cancelar la corrida"])
  expect(["retry:latest-profile", "continue:latest-profile"].map((o) => optionLabel(stuck, o))).toEqual(["Reintentar con el perfil vigente", "Continuar con el perfil vigente"])
})

test("una nota sin opciones se marca vista; un gate sin opciones no ofrece nada", () => {
  expect(optionsOf(decision(1))).toEqual([SEEN])
  expect(optionsOf(decision(2, { options: ["Aprobar", "Descartar"] }))).toEqual(["Aprobar", "Descartar"])
  expect(optionsOf(decision(3, { kind: "gate" }))).toEqual([])
})

test("una alerta sin opciones, como la de un breaker, no se resuelve a mano ni admite texto libre", () => {
  const alert = decision(1, { kind: "alert" })
  expect(optionsOf(alert)).toEqual([])
  expect(takesText(alert)).toBe(false)
  expect(takesText(decision(2))).toBe(true)
  expect(takesText(decision(3, { kind: "gate" }))).toBe(false)
})

test("solo un gate o needs_human pendiente estaciona su corrida", () => {
  expect(parksRun(decision(1, { kind: "gate" }))).toBe(true)
  expect(parksRun(decision(2, { kind: "needs_human", status: "answered" }))).toBe(false)
  expect(parksRun(decision(3, { kind: "alert" }))).toBe(false)
})

test("una publicación de PR local ofrece dos opciones y no admite texto libre", () => {
  const request = decision(1, { kind: "question", options: [APPROVE_LOCAL_PUBLISH, DECLINE_LOCAL_PUBLISH] })
  expect(optionsOf(request)).toEqual([APPROVE_LOCAL_PUBLISH, DECLINE_LOCAL_PUBLISH])
  expect(takesText(request)).toBe(false)
  expect(isDestructive(APPROVE_LOCAL_PUBLISH)).toBe(true)
})

test("las pendientes ponen primero las que estacionan una corrida, y las resueltas por cuándo se cerraron", () => {
  const all = [
    decision(1, { kind: "alert" }),
    decision(5, { kind: "gate" }),
    decision(3, { kind: "needs_human" }),
    decision(2, { status: "answered", resolvedAt: NOW - 10 }),
    decision(4, { status: "expired", resolvedAt: NOW - 5 }),
  ]

  expect(visibleDecisions(all, { tab: "pending", projectId: null, kind: null }).map((d) => d.title)).toEqual(["decisión 3", "decisión 5", "decisión 1"])
  expect(visibleDecisions(all, { tab: "resolved", projectId: null, kind: null }).map((d) => d.title)).toEqual(["decisión 4", "decisión 2"])
})

test("los filtros de proyecto y tipo se combinan", () => {
  const p1 = "prj_00000000000000000000000001" as Decision["projectId"]
  const p2 = "prj_00000000000000000000000002" as Decision["projectId"]
  const all = [decision(1, { projectId: p1, kind: "alert" }), decision(2, { projectId: p1 }), decision(3, { projectId: p2, kind: "alert" })]

  expect(visibleDecisions(all, { tab: "pending", projectId: p1, kind: "alert" }).map((d) => d.title)).toEqual(["decisión 1"])
  expect(visibleDecisions(all, { tab: "pending", projectId: null, kind: "alert" })).toHaveLength(2)
})

test("lo resuelto hoy cuenta desde las 00:00 y no las pendientes", () => {
  const startOfDay = new Date(NOW).setHours(0, 0, 0, 0)
  const all = [decision(1, { status: "answered", resolvedAt: startOfDay + 1 }), decision(2, { status: "answered", resolvedAt: startOfDay - 1 }), decision(3)]
  expect(resolvedToday(all, NOW)).toBe(1)
})

test("lo que se respondió se lee con la etiqueta de la opción o como el texto libre", () => {
  const gate = decision(1, { kind: "gate", body: "go: Seguir", options: ["go"], status: "answered", resolution: { option: "go" } })
  expect(resolutionText(gate)).toBe("Seguir")
  expect(resolutionText(decision(2, { status: "answered", resolution: { option: "no es mío" } }))).toBe("no es mío")
  expect(resolutionText(decision(3, { status: "superseded" }))).toBeNull()
})
