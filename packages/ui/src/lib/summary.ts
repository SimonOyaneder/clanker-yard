import type { CachedIssue, IssueMetrics, ProjectSummary, StepMetrics } from "@clanker/api"
import type { MetricsRange } from "@/app-data"
import { compactCount, costUsd } from "@/lib/format"

/** De cuándo a cuándo se cuentan las corridas, por el día en que cerraron. */
export const RANGE_PRESETS = ["all", "7d", "30d", "custom"] as const
export type RangePreset = (typeof RANGE_PRESETS)[number]
export interface SummaryRange {
  preset: RangePreset
  /** `YYYY-MM-DD`, ambos días incluidos; solo con `custom`. Vacío es sin límite por ese lado. */
  from: string
  to: string
}
export const DEFAULT_RANGE: SummaryRange = { preset: "all", from: "", to: "" }

export const ORIGINS = ["all", "imported", "yard"] as const
export type Origin = (typeof ORIGINS)[number]

export const RANGE_LABELS: Record<RangePreset, string> = { all: "Todo el historial", "7d": "Últimos 7 días", "30d": "Últimos 30 días", custom: "Personalizado" }
export const ORIGIN_LABELS: Record<Origin, string> = { all: "Todas", imported: "Importadas", yard: "Yard" }

const DAY_MS = 86_400_000

const localDay = (iso: string, plusDays = 0): number | undefined => {
  const [y, m, d] = iso.split("-").map(Number)
  return y && m && d ? new Date(y, m - 1, d + plusDays).getTime() : undefined
}

/** El filtro que entiende el core: los días son de la zona de la máquina y `to` es exclusivo. */
export function metricsRange(range: SummaryRange, origin: Origin, now: number): MetricsRange {
  const today = new Date(now)
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const bounds: MetricsRange = {}
  if (range.preset === "7d") bounds.from = startOfToday - 6 * DAY_MS
  else if (range.preset === "30d") bounds.from = startOfToday - 29 * DAY_MS
  else if (range.preset === "custom") {
    const from = localDay(range.from)
    const to = localDay(range.to, 1)
    if (from !== undefined) bounds.from = from
    if (to !== undefined) bounds.to = to
  }
  if (origin !== "all") bounds.imported = origin === "imported"
  return bounds
}

/** Un valor estable por rango y origen, para la clave de la consulta. */
export const rangeKey = (range: SummaryRange, origin: Origin) => `${range.preset}:${range.preset === "custom" ? `${range.from}..${range.to}` : ""}:${origin}`

/** Cada rol tiene su color por su lugar entre todos los roles del proyecto, no por cuánto gastó: filtrar no lo repinta. */
export const ROLE_COLORS = ["bg-viz-1", "bg-viz-2", "bg-viz-3", "bg-viz-4", "bg-viz-5", "bg-viz-6", "bg-viz-7", "bg-viz-8"] as const
export const roleColor = (roles: readonly string[], role: string): string => ROLE_COLORS[roles.indexOf(role)] ?? "bg-viz-other"

/** El tope bonito de un eje: 1, 2, 5 o 10 por una potencia de diez. */
export function niceMax(x: number): number {
  if (x <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(x))
  const n = x / p
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p
}

/** Dólares de un eje, sin ceros que sobran: "$5", "$0.5". */
export const axisUsd = (micros: number) => costUsd(micros).replace(/\.00$/, "")

const addDay = (day: string): string => {
  const [y, m, d] = day.split("-").map(Number)
  return new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10)
}

/** Los días entre el primero y el último con ceros en los que no cerró nada: un eje de tiempo no se salta días. */
export function fillDays<T extends { day: string }>(days: readonly T[], empty: (day: string) => T): T[] {
  const byDay = new Map(days.map((d) => [d.day, d]))
  const first = days[0]?.day
  const last = days[days.length - 1]?.day
  if (!first || !last) return []
  const filled: T[] = []
  for (let day = first; day <= last; day = addDay(day)) filled.push(byDay.get(day) ?? empty(day))
  return filled
}

export const dayLabel = (day: string): string => {
  const [y, m, d] = day.split("-").map(Number)
  return new Date(y!, m! - 1, d!).toLocaleDateString("es-CL", { day: "numeric", month: "short" })
}

export function hours(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  return m ? `${h} h ${m} min` : `${h} h`
}

export const decimal = (n: number) => n.toFixed(1).replace(".", ",")

const RESULT_LABELS: Record<string, string> = { done: "listas", failed: "fallidas", blocked: "bloqueadas", canceled: "canceladas" }
export const resultLabel = (result: string) => RESULT_LABELS[result] ?? result

/** Las tarjetas de arriba: todo sale de `projects.summary`, así que cuadran con él por construcción. */
export function summaryTiles(summary: ProjectSummary): { label: string; value: string; sub: string }[] {
  const tokens = summary.byRole.reduce((sum, r) => sum + r.tokens, 0)
  return [
    { label: "Gasto total", value: costUsd(summary.costMicros), sub: `${compactCount(tokens)} tokens` },
    {
      label: "Corridas cerradas",
      value: String(summary.runs),
      sub: summary.results.map((r) => `${r.count} ${resultLabel(r.result)}`).join(" · ") || "ninguna",
    },
    { label: "Costo por corrida", value: summary.avgCostMicros === null ? "—" : costUsd(Math.round(summary.avgCostMicros)), sub: summary.avgMinutes === null ? "" : `${Math.round(summary.avgMinutes)} min en promedio` },
    { label: "Tiempo de corridas", value: hours(summary.minutes), sub: "desde que parten hasta que cierran" },
  ]
}

/** Cada nodo con su flujo solo si hay más de un flujo: con uno, repetirlo es ruido. */
export function stepRows(steps: readonly StepMetrics[]): { key: string; label: string; costMicros: number; steps: number }[] {
  const several = new Set(steps.map((s) => s.flow)).size > 1
  return steps.map((s) => ({ key: `${s.flow}/${s.node}`, label: several ? `${s.flow} · ${s.node}` : s.node, costMicros: s.costMicros, steps: s.steps }))
}

export interface IssueRoundsRow {
  issueId: string
  /** La issue del caché; `null` si ya no está. */
  issue: CachedIssue | null
  runs: number
  costMicros: number
  rounds: Record<string, number>
  totalRounds: number
}

/** Las issues con más vueltas primero, y a igual número la más cara: lo que cuesta dar vueltas. */
export function issueRoundsRows(byIssue: readonly IssueMetrics[], issues: readonly CachedIssue[]): IssueRoundsRow[] {
  const known = new Map(issues.map((i) => [i.id, i]))
  return byIssue
    .map((m) => ({ ...m, issue: known.get(m.issueId) ?? null, totalRounds: Object.values(m.rounds).reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.totalRounds - a.totalRounds || b.costMicros - a.costMicros || a.issueId.localeCompare(b.issueId))
}
