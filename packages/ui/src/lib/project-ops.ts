import type { Breaker, BreakerCause, CachedPr, ClankerProject, Decision, Lane, Lanes, ParkReason, Run } from "@clanker/api"

// Lo que la vista de Operación de un proyecto saca de los datos del core: cupos por carril, corridas
// estacionadas con su decisión, préstamos de sujeto, breakers que le afectan y gasto de hoy.

/** Una corrida raíz ocupa un cupo de su carril mientras corre, espera o está pausada; `queued` y `parked` no. */
export const holdsLane = (run: Pick<Run, "status" | "parentRunId">) =>
  run.parentRunId === null && (run.status === "running" || run.status === "waiting" || run.status === "paused")

export interface LaneUsage {
  /** Corridas de este proyecto que ocupan cupo en el carril. */
  active: number
  /** Dev: el `parallel` del proyecto. Mantenimiento: el de la máquina, que no tiene tope por proyecto. */
  capacity: number
  /** Lo que toda la máquina tiene en uso en el carril, con su tope. */
  machine: { active: number; capacity: number }
}

export function laneUsage(project: Pick<ClankerProject, "parallel">, runs: readonly Run[], lanes: Lanes): Record<Lane, LaneUsage> {
  const active = (lane: Lane) => runs.filter((r) => r.lane === lane && holdsLane(r)).length
  return {
    dev: { active: active("dev"), capacity: project.parallel, machine: lanes.dev },
    maintenance: { active: active("maintenance"), capacity: lanes.maintenance.capacity, machine: lanes.maintenance },
  }
}

/** Corridas raíz estacionadas: esperan a una persona y no ocupan cupo. */
export const parkedRuns = (runs: readonly Run[]) => runs.filter((r) => r.parentRunId === null && r.status === "parked")

/** La decisión pendiente que tiene estacionada a la corrida, si hay. */
export const decisionOf = (run: Pick<Run, "id">, decisions: readonly Decision[]) => decisions.find((d) => d.runId === run.id && d.status === "pending")

/** Para cada corrida de dev estacionada que prestó su sujeto, la corrida de mantenimiento que lo tiene. */
export function borrowers(runs: readonly Run[]): Map<string, Run> {
  return new Map(runs.flatMap((r) => (r.borrowedFromRunId !== null && r.endedAt === null ? [[r.borrowedFromRunId, r] as const] : [])))
}

/** Los breakers abiertos que frenan a este proyecto: el de GitHub, los de runtime y los de sus repos. */
export const breakersOf = (project: Pick<ClankerProject, "repos">, breakers: readonly Breaker[]) =>
  breakers.filter((b) => b.scope === "github" || b.scope.startsWith("runtime:") || project.repos.some((r) => b.scope === `repo:${r.repoId}`))

export const BREAKER_CAUSE: Record<BreakerCause, { label: string; hint: string }> = {
  quota_exhausted: { label: "cuota agotada", hint: "La cuota del plan se agotó. Se reanuda sola cuando se reinicia." },
  login_expired: { label: "login vencido", hint: "Claude necesita que vuelvas a iniciar sesión. Se reanuda al reconectar." },
  connection_lost: { label: "conexión caída", hint: "Una cuenta conectada venció o fue revocada. Se reanuda al reconectarla." },
  rate_limited: { label: "límite de GitHub", hint: "GitHub cortó las requests por cuota. Se reanuda cuando se reinicia." },
  environment: { label: "entorno caído", hint: "Falló algo del entorno del repo (una base de datos, un servicio). Se reanuda cuando vuelve." },
}

/** Qué deja de correr mientras el breaker del ámbito está abierto; lo demás sigue. */
export function pausedBy(scope: string): string {
  if (scope === "github") return "No se publica a GitHub. Los agentes y los checks siguen."
  if (scope.startsWith("runtime:")) return "No arrancan pasos de agente ni issues nuevas. Los checks y Watch siguen."
  return "No se lanzan issues de ese repo ni corren sus checks. Los demás repos siguen."
}

const PARK_REASON: Record<ParkReason, { label: string; hint: string }> = {
  gate: { label: "aprobación", hint: "Un gate del flujo espera tu decisión. Solo se estaciona esta corrida." },
  needs_human: { label: "necesita a una persona", hint: "Un paso falló tras su reintento. Solo se estaciona esta corrida." },
  limit: { label: "tope de gasto", hint: "La corrida llegó a su tope de gasto. Solo se estaciona esta corrida." },
}
export const parkReasonOf = (reason: ParkReason | null) => (reason ? PARK_REASON[reason] : { label: "decisión", hint: "Espera tu decisión. Solo se estaciona esta corrida." })

/** PRs abiertos que abrió alguna de las corridas del proyecto. */
export const projectPrs = (prs: readonly CachedPr[], runs: readonly Run[]) => {
  const ids = new Set(runs.map((r) => r.id))
  return prs.filter((p) => p.owned && p.runId !== null && ids.has(p.runId))
}

/** Lo que gastaron las corridas que arrancaron desde las 00:00 de hoy (una que cruzó la medianoche cuenta el día en que empezó). */
export function spentToday(runs: readonly Run[], now: number): number {
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  return runs.filter((r) => r.startedAt >= midnight).reduce((sum, r) => sum + r.costMicros, 0)
}
