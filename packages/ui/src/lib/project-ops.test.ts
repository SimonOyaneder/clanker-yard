import type { Breaker, CachedPr, ClankerProject, Decision, Lanes, Run } from "@clanker/api"
import { expect, test } from "vitest"
import { borrowers, breakersOf, decisionOf, holdsLane, laneUsage, parkedRuns, projectPrs, spentToday } from "@/lib/project-ops"

const id = (prefix: string, n: number) => `${prefix}_${String(n).padStart(26, "0")}`

function run(n: number, extra: Partial<Run> = {}): Run {
  return {
    id: id("run", n) as Run["id"],
    projectId: id("prj", 1) as Run["projectId"],
    parentRunId: null,
    borrowedFromRunId: null,
    flow: { slug: "techlead-clasico", version: 1 },
    subject: { type: "issue", id: id("iss", n) },
    lane: "dev",
    status: "running",
    parkReason: null,
    outcome: null,
    params: {},
    rounds: {},
    costMicros: 1_000_000,
    startedAt: Date.parse("2026-11-15T10:00:00"),
    endedAt: null,
    ...extra,
  }
}

const LANES: Lanes = { dev: { active: 3, capacity: 4 }, maintenance: { active: 1, capacity: 2 } }
const project = { parallel: 1, repos: [{ repoId: id("repo", 1), labels: [] }] } as unknown as ClankerProject

test("una corrida ocupa cupo corriendo, esperando o pausada; estacionada, en cola o hija de un subflujo no", () => {
  const statuses = (["queued", "running", "waiting", "parked", "paused", "done"] as const).map((status) => holdsLane(run(1, { status })))
  expect(statuses).toEqual([false, true, true, false, true, false])
  expect(holdsLane(run(1, { parentRunId: id("run", 9) as Run["id"] }))).toBe(false)
})

test("los cupos: dev contra el paralelismo del proyecto y mantenimiento contra el tope de la máquina", () => {
  const runs = [run(1), run(2, { status: "parked" }), run(3, { lane: "maintenance" }), run(4, { lane: "maintenance", status: "queued" })]

  expect(laneUsage(project, runs, LANES)).toEqual({
    dev: { active: 1, capacity: 1, machine: LANES.dev },
    maintenance: { active: 1, capacity: 2, machine: LANES.maintenance },
  })
})

test("un rebase de mantenimiento cuenta aunque dev esté lleno", () => {
  const usage = laneUsage(project, [run(1), run(3, { lane: "maintenance" })], LANES)

  expect(usage.dev.active).toBe(usage.dev.capacity)
  expect(usage.maintenance.active).toBe(1)
})

test("las estacionadas y su decisión pendiente; las hijas no cuentan", () => {
  const parked = run(1, { status: "parked", parkReason: "needs_human" })
  const decisions = [
    { id: id("dec", 1), runId: parked.id, status: "accepted" },
    { id: id("dec", 2), runId: parked.id, status: "pending" },
  ] as unknown as Decision[]

  expect(parkedRuns([parked, run(2), run(3, { status: "parked", parentRunId: id("run", 1) as Run["id"] })])).toEqual([parked])
  expect(decisionOf(parked, decisions)?.id).toBe(id("dec", 2))
  expect(decisionOf(run(2), decisions)).toBeUndefined()
})

test("quién tiene prestado el sujeto de una corrida estacionada, solo mientras el préstamo vive", () => {
  const lender = run(1, { status: "parked" })
  const loan = run(2, { lane: "maintenance", borrowedFromRunId: lender.id })
  const returned = run(3, { lane: "maintenance", status: "done", endedAt: 1, borrowedFromRunId: id("run", 8) as Run["id"] })

  expect([...borrowers([lender, loan, returned])]).toEqual([[lender.id, loan]])
})

test("de los breakers abiertos le afectan GitHub, los runtimes y los repos del proyecto", () => {
  const breaker = (scope: string) => ({ scope }) as Breaker

  const scopes = ["github", "runtime:claude-sdk", `repo:${id("repo", 1)}`, `repo:${id("repo", 2)}`].map(breaker)

  expect(breakersOf(project, scopes).map((b) => b.scope)).toEqual(["github", "runtime:claude-sdk", `repo:${id("repo", 1)}`])
})

test("los PRs abiertos del proyecto son los que abrió alguna de sus corridas", () => {
  const mine = run(1)
  const pr = (runId: string | null, owned = true) => ({ owned, runId }) as CachedPr

  expect(projectPrs([pr(mine.id), pr(id("run", 9)), pr(null), pr(mine.id, false)], [mine])).toHaveLength(1)
})

test("el gasto de hoy suma las corridas que arrancaron desde las 00:00", () => {
  const now = Date.parse("2026-11-15T12:00:00")
  const runs = [run(1), run(2, { costMicros: 2_500_000 }), run(3, { startedAt: Date.parse("2026-11-14T23:59:00"), costMicros: 9_000_000 })]

  expect(spentToday(runs, now)).toBe(3_500_000)
})
