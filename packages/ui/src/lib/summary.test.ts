import type { ProjectSummary } from "@clanker/api"
import { expect, test } from "vitest"
import { fillDays, issueRoundsRows, metricsRange, roleColor, stepRows, summaryTiles } from "@/lib/summary"

// Mediodía local del 15 de noviembre: los límites son del día local, no de UTC.
const NOW = new Date(2026, 10, 15, 12).getTime()
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime()

test("los rangos son días locales: 7 días incluye hoy, el personalizado cierra al día siguiente y el origen es `imported`", () => {
  expect(metricsRange({ preset: "all", from: "", to: "" }, "all", NOW)).toEqual({})
  expect(metricsRange({ preset: "7d", from: "", to: "" }, "yard", NOW)).toEqual({ from: day(2026, 11, 9), imported: false })
  expect(metricsRange({ preset: "30d", from: "", to: "" }, "imported", NOW)).toEqual({ from: day(2026, 10, 17), imported: true })
  expect(metricsRange({ preset: "custom", from: "2026-11-01", to: "2026-11-03" }, "all", NOW)).toEqual({ from: day(2026, 11, 1), to: day(2026, 11, 4) })
  expect(metricsRange({ preset: "custom", from: "", to: "2026-11-03" }, "all", NOW)).toEqual({ to: day(2026, 11, 4) })
})

test("el color de un rol depende de su lugar entre todos los roles del proyecto, no de cuánto gastó", () => {
  const roles = ["dev", "review-bugs", "techlead"]
  expect(roleColor(roles, "dev")).toBe("bg-viz-1")
  expect(roleColor(roles, "techlead")).toBe("bg-viz-3")
  expect(roleColor(roles, "otro")).toBe("bg-viz-other")
  expect(roleColor(Array.from({ length: 9 }, (_, i) => `r${i}`), "r8")).toBe("bg-viz-other")
})

test("fillDays rellena con ceros los días sin cierres entre el primero y el último, también cruzando de mes", () => {
  const days = [{ day: "2026-10-30", n: 2 }, { day: "2026-11-02", n: 1 }]
  expect(fillDays(days, (d) => ({ day: d, n: 0 }))).toEqual([
    { day: "2026-10-30", n: 2 },
    { day: "2026-10-31", n: 0 },
    { day: "2026-11-01", n: 0 },
    { day: "2026-11-02", n: 1 },
  ])
  expect(fillDays([], (d) => ({ day: d }))).toEqual([])
})

test("las tarjetas de arriba son lo que dice projects.summary", () => {
  const summary: ProjectSummary = {
    runs: 5,
    results: [{ result: "done", count: 4 }, { result: "failed", count: 1 }],
    costMicros: 22_150_000,
    avgCostMicros: 4_430_000,
    minutes: 130,
    avgMinutes: 26,
    rounds: [],
    byRole: [{ role: "dev", runs: 5, tokens: 6_000_000, costMicros: 22_150_000 }],
    firstAt: 1,
    lastAt: 2,
  }

  expect(summaryTiles(summary)).toEqual([
    { label: "Gasto total", value: "$22.15", sub: "6 M tokens" },
    { label: "Corridas cerradas", value: "5", sub: "4 listas · 1 fallidas" },
    { label: "Costo por corrida", value: "$4.43", sub: "26 min en promedio" },
    { label: "Tiempo de corridas", value: "2 h 10 min", sub: "desde que parten hasta que cierran" },
  ])
  expect(summaryTiles({ ...summary, runs: 0, results: [], costMicros: 0, avgCostMicros: null, avgMinutes: null, minutes: 0, byRole: [] }).map((t) => t.value)).toEqual(["$0", "0", "—", "0 min"])
})

test("los pasos llevan su flujo solo si hay más de un flujo", () => {
  const one = [{ flow: "de-issue-a-pr", node: "implement", steps: 2, costMicros: 5 }]
  expect(stepRows(one).map((r) => r.label)).toEqual(["implement"])
  expect(stepRows([...one, { flow: "rebase", node: "resolve", steps: 1, costMicros: 3 }]).map((r) => r.label)).toEqual(["de-issue-a-pr · implement", "rebase · resolve"])
})

test("las issues con más rondas van primero, y a igual número la más cara", () => {
  const id = (n: number) => `iss_${String(n).padStart(26, "0")}` as `iss_${string}`
  const rows = issueRoundsRows(
    [
      { issueId: id(1), runs: 1, costMicros: 100, rounds: { review: 1 } },
      { issueId: id(2), runs: 1, costMicros: 50, rounds: { review: 2, bot: 1 } },
      { issueId: id(3), runs: 1, costMicros: 300, rounds: { review: 1 } },
    ],
    [],
  )
  expect(rows.map((r) => [r.issueId, r.totalRounds, r.issue])).toEqual([[id(2), 3, null], [id(3), 1, null], [id(1), 1, null]])
})
