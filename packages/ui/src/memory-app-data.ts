import type { AppData } from "@/app-data"
import { issueIdOf } from "@/lib/format"
import { buildSeed } from "@/seed"
import type { CheckpointLine, IssueDetail, Loop, LoopSummary, Member, Result, Step, ToolCall } from "@/types"

const ok = <T>(data: T): Result<T> => ({ ok: true, data })
const fail = (error: string): Result<never> => ({ ok: false, error })

const CHECKPOINT: CheckpointLine[] = [
  { step: "paso 1", text: "contexto leído: issue, AGENTS.md y lore del área" },
  { step: "paso 2", text: "worktree creado desde origin/main" },
  { step: "paso 3 plan", text: "plan aprobado por el techlead" },
  { step: "paso 3", text: "dev terminó con los tests del área en verde" },
  { step: "paso 4 ronda 1", text: "4 reviewers, 3 hallazgos aplicados" },
  { step: "paso 5", text: "PR draft abierto" },
  { step: "paso 6", text: "/review sin hallazgos y CI verde" },
  { step: "paso 7", text: "listo para merge" },
]

const TAIL_TOOLS: Omit<ToolCall, "ts">[] = [
  { tool: "Read", detail: "AGENTS.md" },
  { tool: "Grep", detail: "PostEntry" },
  { tool: "Read", detail: "engines/ledger/app/services/post_entry.rb" },
  { tool: "Edit", detail: "engines/ledger/lib/ledger/engine.rb" },
  { tool: "Bash", detail: "bundle exec rspec engines/ledger" },
  { tool: "Bash", detail: "git diff origin/main...HEAD --stat" },
]

function tailOf(m: Member, now: number): ToolCall[] {
  const last = m.lastActivity ? Date.parse(m.lastActivity) : now
  return TAIL_TOOLS.map((t, i) => ({ ...t, ts: new Date(last - (TAIL_TOOLS.length - i) * 20_000).toISOString() }))
}

function finishedTeam(m: Member): Member {
  return { ...m, status: "listo" }
}

function issueDetailOf(loop: Loop, issueId: string, now: number): Result<IssueDetail> {
  const slot = loop.slots.find((s) => s.issueId === issueId) ?? null
  const history = loop.history.find((h) => issueIdOf(h.issueId) === issueId) ?? null
  const queued = loop.queueItems?.find((q) => q.id === issueId) ?? null
  if (!slot && !history && !queued) return fail(`${issueId} no está en ${loop.title}`)

  const title = slot?.title ?? history?.title ?? queued?.title ?? null
  if (!slot && !history) {
    const todo: Step[] = ["Contexto", "Worktree", "Plan", "Dev", "Review", "PR draft", "Bot + CI", "Cierre"].map((label) => ({
      key: label.toLowerCase(),
      label,
      status: "todo",
    }))
    return ok({ project: loop.slug, issueId, title, slot: null, history: null, checkpoint: [], steps: todo, team: [], tails: {}, usd: 0, tokens: 0, minutes: null, decisions: [] })
  }

  const team = slot ? slot.team : (loop.slots[0]?.team ?? []).map((m) => ({ ...finishedTeam(m), usd: (history?.usd ?? 0) / 8, tokens: m.tokens || 60_000 }))
  const steps: Step[] = slot ? slot.steps : (loop.slots[0]?.steps ?? []).map((s) => ({ ...s, status: "done" as const }))
  const checkpoint = slot ? CHECKPOINT.slice(0, steps.filter((s) => s.status === "done").length) : CHECKPOINT
  return ok({
    project: loop.slug,
    issueId,
    title,
    slot,
    history,
    checkpoint,
    steps,
    team,
    tails: Object.fromEntries(team.filter((m) => m.runs > 0).map((m) => [m.role, tailOf(m, now)])),
    usd: slot?.usd ?? history?.usd ?? 0,
    tokens: team.reduce((a, m) => a + m.tokens, 0),
    minutes: slot?.minutes ?? history?.minutes ?? null,
    decisions: loop.decisions.filter((d) => d.issueId === issueId),
  })
}

const ROLE_SHARE: [string, number][] = [
  ["dev", 0.42],
  ["techlead", 0.2],
  ["review-bugs", 0.1],
  ["review-tests", 0.08],
  ["review-patterns", 0.07],
  ["review-lore", 0.05],
  ["committer", 0.04],
  ["bot-reviewer", 0.04],
]

function summaryOf(loop: Loop, now: number): LoopSummary {
  const spent = [...loop.history.map((h) => h.usd ?? 0), ...loop.slots.map((s) => s.usd)]
  const teamsUsd = spent.reduce((a, b) => a + b, 0)
  const emUsd = teamsUsd * 0.18
  const totalUsd = teamsUsd + emUsd
  const prs = { abierto: 0, aprobado: 0, mergeado: 0, problema: 0 }
  for (const h of loop.history) prs[h.column]++
  const minutes = loop.history.map((h) => h.minutes ?? 0)
  const day = (d: number) => new Date(now - d * 86_400_000).toISOString().slice(0, 10)
  return {
    slug: loop.slug,
    title: loop.title,
    totalUsd,
    emUsd,
    teamsUsd,
    issuesRecorded: loop.history.length,
    results: [
      { result: "listo", count: loop.history.length - prs.problema },
      ...(prs.problema ? [{ result: "bloqueada", count: prs.problema }] : []),
    ],
    prs,
    agentMinutes: minutes.reduce((a, b) => a + b, 0),
    avgMinutes: minutes.length ? Math.round(minutes.reduce((a, b) => a + b, 0) / minutes.length) : null,
    avgUsd: loop.history.length ? teamsUsd / loop.history.length : null,
    rounds: { review: 1.6, bot: 1.2, botValid: 5, botFp: 3, ciFails: prs.problema },
    byRole: ROLE_SHARE.map(([role, share]) => ({ role, usd: teamsUsd * share, tokens: Math.round(teamsUsd * share * 150_000) })),
    byModel: [
      { model: "sonnet", usd: teamsUsd * 0.7 },
      { model: "opus", usd: teamsUsd * 0.3 + emUsd },
    ],
    byDay: [3, 2, 1, 0].map((d, i) => ({ day: day(d), usd: totalUsd * [0.15, 0.25, 0.2, 0.4][i]!, issues: Math.max(1, Math.round(loop.history.length * [0.2, 0.3, 0.2, 0.3][i]!)) })),
    topIssues: [...loop.history]
      .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))
      .slice(0, 5)
      .map((h) => ({ issueId: issueIdOf(h.issueId), title: h.title, usd: h.usd ?? 0, minutes: h.minutes, result: h.column === "problema" ? "bloqueada" : "listo", pr: h.pr.split(" ")[0] ?? null })),
    firstTs: new Date(now - 3 * 86_400_000).toISOString(),
    lastTs: loop.lastActivity,
    decisions: { total: loop.decisions.length, pending: loop.decisions.filter((d) => d.pending).length },
    omitted: 0,
  }
}

// Datos de ejemplo en memoria. `setArchived` es lo único que cambia el estado; lanzar o detener
// un EM solo responde que salió bien.
export function createMemoryAppData(now = Date.now()): AppData {
  const seed = buildSeed(now)
  const loops = seed.snapshot.loops
  const loopOf = (slug: string) => loops.find((l) => l.slug === slug)
  const launched = (name: string) => ok({ id: "bg-demo", name })

  return {
    snapshot: async () => ok({ ...seed.snapshot, generatedAt: new Date().toISOString(), loops: loops.map((l) => ({ ...l })) }),
    issue: async (slug, issueId) => {
      const loop = loopOf(slug)
      return loop ? issueDetailOf(loop, issueId, now) : fail(`No existe el loop ${slug}`)
    },
    summary: async (slug) => {
      const loop = loopOf(slug)
      return loop ? ok(summaryOf(loop, now)) : fail(`No existe el loop ${slug}`)
    },
    config: async () => ok(seed.config),
    prs: async () => ok(seed.prs),
    setArchived: async (slug, archived) => {
      const loop = loopOf(slug)
      if (!loop) return fail(`No existe el loop ${slug}`)
      loop.archived = archived
      return ok(null)
    },
    newLoop: async (input) => launched(`clanker · ${input.project}`),
    runLoop: async (slug) => launched(`clanker · ${slug}`),
    resume: async (slug) => launched(`clanker · ${slug}`),
    stop: async () => ok(null),
  }
}
