import type { IssueId, ProjectSummary } from "@clanker/api"
import type { MetricsRange, ProjectMetrics } from "@/app-data"

// Corridas cerradas de ejemplo para el Resumen sin core. `aggregate` suma como lo hace `createMetrics` del core:
// los costos de todas las corridas, los conteos de las raíz, los días del cierre en la zona de la máquina.

type Spend = [role: string, model: string, tokens: number, usd: number]
interface Closed {
  daysAgo: number
  issue: IssueId
  imported: boolean
  result: "done" | "failed"
  minutes: number
  rounds: Record<string, number>
  roles: Spend[]
  /** Solo las corridas de Yard tienen pasos. */
  steps: [node: string, usd: number][]
}

const micros = (usd: number) => Math.round(usd * 1_000_000)

export function seedClosedRuns(issues: readonly IssueId[]): Closed[] {
  const [a, b, c, d] = issues as [IssueId, IssueId, IssueId, IssueId]
  const dev = (usd: number): Spend => ["dev", "opus", Math.round(usd * 380_000), usd]
  const techlead = (usd: number): Spend => ["techlead", "opus", Math.round(usd * 300_000), usd]
  const review = (usd: number): Spend => ["review-bugs", "sonnet", Math.round(usd * 700_000), usd]
  return [
    { daysAgo: 19, issue: a, imported: true, result: "done", minutes: 20, rounds: { review: 2, bot: 1 }, roles: [dev(1.5), techlead(1.0), review(1.0)], steps: [] },
    { daysAgo: 18, issue: b, imported: true, result: "done", minutes: 30, rounds: { review: 1, bot: 2, ci: 1 }, roles: [dev(2.5), techlead(1.25), review(1.25)], steps: [] },
    { daysAgo: 17, issue: c, imported: true, result: "failed", minutes: 5, rounds: { review: 1 }, roles: [dev(0.4), techlead(0.25)], steps: [] },
    { daysAgo: 12, issue: d, imported: true, result: "done", minutes: 45, rounds: { review: 3, bot: 3, ci: 2 }, roles: [dev(4.0), techlead(2.5), review(2.5)], steps: [] },
    { daysAgo: 6, issue: a, imported: false, result: "done", minutes: 38, rounds: { review: 1 }, roles: [dev(2.1), review(0.5)], steps: [["plan", 0.4], ["implement", 1.7], ["reviews", 0.5]] },
    { daysAgo: 4, issue: b, imported: false, result: "done", minutes: 52, rounds: { review: 2, external: 1 }, roles: [dev(3.2), review(0.9)], steps: [["plan", 0.5], ["implement", 2.1], ["fix", 1.1], ["reviews", 0.4]] },
    { daysAgo: 1, issue: c, imported: false, result: "done", minutes: 27, rounds: {}, roles: [dev(1.2), review(0.3)], steps: [["plan", 0.3], ["implement", 0.9], ["reviews", 0.3]] },
  ]
}

export function aggregate(runs: readonly Closed[], range: MetricsRange, now: number): ProjectMetrics {
  const offsetMs = -new Date(now).getTimezoneOffset() * 60_000
  const closedAt = (r: Closed) => now - r.daysAgo * 86_400_000
  const scoped = runs.filter((r) => (range.from === undefined || closedAt(r) >= range.from) && (range.to === undefined || closedAt(r) < range.to) && (range.imported === undefined || r.imported === range.imported))

  const sum = (rows: Spend[]) => rows.reduce((n, [, , , usd]) => n + micros(usd), 0)
  const group = <K extends string>(keyOf: (s: Spend) => K) => {
    const by = new Map<K, { tokens: number; costMicros: number; runs: number }>()
    for (const r of scoped)
      for (const s of r.roles) {
        const acc = by.get(keyOf(s)) ?? { tokens: 0, costMicros: 0, runs: 0 }
        by.set(keyOf(s), { tokens: acc.tokens + s[2], costMicros: acc.costMicros + micros(s[3]), runs: acc.runs + 1 })
      }
    return [...by].sort((x, y) => y[1].costMicros - x[1].costMicros)
  }
  const byRole = group((s) => s[0]).map(([role, v]) => ({ role, ...v }))
  const byModel = group((s) => s[1]).map(([model, v]) => ({ model, tokens: v.tokens, costMicros: v.costMicros }))

  const days = new Map<string, { runs: number; costMicros: number }>()
  for (const r of scoped) {
    const day = new Date(closedAt(r) + offsetMs).toISOString().slice(0, 10)
    const acc = days.get(day) ?? { runs: 0, costMicros: 0 }
    days.set(day, { runs: acc.runs + 1, costMicros: acc.costMicros + sum(r.roles) })
  }

  const steps = new Map<string, { steps: number; costMicros: number }>()
  for (const r of scoped)
    for (const [node, usd] of r.steps) {
      const acc = steps.get(node) ?? { steps: 0, costMicros: 0 }
      steps.set(node, { steps: acc.steps + 1, costMicros: acc.costMicros + micros(usd) })
    }

  const issues = new Map<IssueId, { runs: number; costMicros: number; rounds: Record<string, number> }>()
  for (const r of scoped) {
    const acc = issues.get(r.issue) ?? { runs: 0, costMicros: 0, rounds: {} }
    for (const [counter, n] of Object.entries(r.rounds)) acc.rounds[counter] = (acc.rounds[counter] ?? 0) + n
    issues.set(r.issue, { runs: acc.runs + 1, costMicros: acc.costMicros + sum(r.roles), rounds: acc.rounds })
  }

  const counters = [...new Set(scoped.flatMap((r) => Object.keys(r.rounds)))].sort()
  const results = new Map<string, number>()
  for (const r of scoped) results.set(r.result, (results.get(r.result) ?? 0) + 1)
  const costMicros = byRole.reduce((n, r) => n + r.costMicros, 0)
  const minutes = scoped.reduce((n, r) => n + r.minutes, 0)
  const summary: ProjectSummary = {
    runs: scoped.length,
    results: [...results].sort((x, y) => y[1] - x[1]).map(([result, count]) => ({ result, count })),
    costMicros,
    avgCostMicros: scoped.length ? costMicros / scoped.length : null,
    minutes,
    avgMinutes: scoped.length ? minutes / scoped.length : null,
    rounds: counters.map((counter) => {
      const total = scoped.reduce((n, r) => n + (r.rounds[counter] ?? 0), 0)
      return { counter, total, perRun: total / scoped.length }
    }),
    byRole,
    firstAt: scoped.length ? Math.min(...scoped.map(closedAt)) : null,
    lastAt: scoped.length ? Math.max(...scoped.map(closedAt)) : null,
  }
  return {
    summary,
    byDay: [...days].sort(([x], [y]) => x.localeCompare(y)).map(([day, v]) => ({ day, ...v })),
    byModel,
    byStep: [...steps].sort((x, y) => y[1].costMicros - x[1].costMicros).map(([node, v]) => ({ flow: "de-issue-a-pr", node, ...v })),
    byIssue: [...issues].sort((x, y) => y[1].costMicros - x[1].costMicros).map(([issueId, v]) => ({ issueId, ...v })),
    roles: [...new Set(runs.flatMap((r) => r.roles.map((s) => s[0])))].sort(),
  }
}
