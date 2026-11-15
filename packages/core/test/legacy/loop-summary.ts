// Copia literal del cálculo de `LoopSummary` de Clanker Control: `readMetrics` y `getLoopSummary` de
// `~/Documents/apps-personales/clanker-control/src/main/lib/loops.ts` y el tipo de `types.ts` (2026-11-15).
//
// Lo que cambia: `?? null` tras el `split` (el tsconfig de Yard tipa el índice), las filas llegan como argumento (en vez de leerse de `CL_HOME`) y solo queda lo que sale de
// `metrics.jsonl`. No están, porque salen del estado vivo del loop y de los transcripts de `~/.claude`: el costo del
// EM (`emUsd`, el rol `EM` de `byRole`, su modelo en `byModel`), las issues en vuelo (`liveUsd`), `prs`, `decisions`
// y `omitted`. Tampoco `byDay` (depende de la zona horaria de la máquina; Yard lo agrupa con `utcOffsetMinutes`) ni
// `topIssues` (Yard junta las corridas de una issue en `byIssue`).
// Si Control cambia el cálculo, se vuelve a copiar.

export interface MetricRow {
  issue?: string
  project?: string
  ts?: string
  usd?: number | null
  minutes?: number | null
}

export interface LoopSummary {
  slug: string
  teamsUsd: number
  issuesRecorded: number
  results: { result: string; count: number }[]
  agentMinutes: number
  avgMinutes: number | null
  avgUsd: number | null
  rounds: { review: number | null; bot: number | null; botValid: number; botFp: number; ciFails: number }
  byRole: { role: string; usd: number; tokens: number }[]
  byModel: { model: string; usd: number }[]
  firstTs: string | null
  lastTs: string | null
}

export function readMetrics(text: string): MetricRow[] {
  const rows: MetricRow[] = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      // línea corrupta
    }
  }
  return rows
}

interface FullMetricRow extends MetricRow {
  mode?: string
  result?: string
  pr?: string
  "review-rounds"?: number
  "bot-rounds"?: number
  "bot-valid"?: number
  "bot-fp"?: number
  "ci-fails"?: number
  por_rol?: Record<string, { modelo?: string; tokens?: number; usd?: number }> | null
}

export function getLoopSummary(slug: string, metrics: MetricRow[]): LoopSummary {
  let firstTs: string | null = null
  let lastTs: string | null = null
  const rows = (metrics as FullMetricRow[]).filter((r) => r.project === slug && (r.mode ?? "real") === "real")

  const teamsUsd = rows.reduce((a, r) => a + (r.usd ?? 0), 0)

  const results = new Map<string, number>()
  for (const r of rows) results.set(r.result ?? "?", (results.get(r.result ?? "?") ?? 0) + 1)

  const minutes = rows.map((r) => r.minutes).filter((m): m is number => typeof m === "number")
  const usds = rows.map((r) => r.usd).filter((u): u is number => typeof u === "number")
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
  const num = (v: unknown) => (typeof v === "number" ? v : 0)

  const byRole = new Map<string, { usd: number; tokens: number }>()
  const byModel = new Map<string, number>()
  const addRole = (role: string, usd: number, tokens: number, model: string | null) => {
    const cur = byRole.get(role) ?? { usd: 0, tokens: 0 }
    byRole.set(role, { usd: cur.usd + usd, tokens: cur.tokens + tokens })
    if (model) byModel.set(model, (byModel.get(model) ?? 0) + usd)
  }
  for (const r of rows) {
    for (const [role, v] of Object.entries(r.por_rol ?? {})) addRole(role, v.usd ?? 0, v.tokens ?? 0, (v.modelo ?? "?").split("+")[0] ?? null)
  }

  for (const r of rows) {
    if (r.ts && (!firstTs || r.ts < firstTs)) firstTs = r.ts
    if (r.ts && (!lastTs || r.ts > lastTs)) lastTs = r.ts
  }

  return {
    slug,
    teamsUsd,
    issuesRecorded: rows.length,
    results: [...results.entries()].map(([result, count]) => ({ result, count })).sort((a, b) => b.count - a.count),
    agentMinutes: minutes.reduce((a, b) => a + b, 0),
    avgMinutes: avg(minutes),
    avgUsd: avg(usds),
    rounds: {
      review: avg(rows.map((r) => num(r["review-rounds"]))),
      bot: avg(rows.map((r) => num(r["bot-rounds"]))),
      botValid: rows.reduce((a, r) => a + num(r["bot-valid"]), 0),
      botFp: rows.reduce((a, r) => a + num(r["bot-fp"]), 0),
      ciFails: rows.reduce((a, r) => a + num(r["ci-fails"]), 0),
    },
    byRole: [...byRole.entries()].map(([role, v]) => ({ role, ...v })).sort((a, b) => b.usd - a.usd),
    byModel: [...byModel.entries()].map(([model, usd]) => ({ model, usd })).sort((a, b) => b.usd - a.usd),
    firstTs,
    lastTs,
  }
}
