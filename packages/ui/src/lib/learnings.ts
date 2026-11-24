import type { Learning, LearningId, LearningSource, LearningStatus, ProjectId, RepoId } from "@clanker/api"

/** Lo que `LearningStatus` significa para quien revisa: el nombre de su pestaña, y qué le pasa al learning en un brief. */
export const STATUS_LABEL: Record<LearningStatus, string> = {
  proposed: "Por revisar",
  approved: "Aprobados",
  rejected: "Rechazados",
  archived: "Retirados",
}

export const STATUS_HINT: Record<LearningStatus, string> = {
  proposed: "Propuesto por un agente, por una persona o por la importación del clanker-loop. Todavía no entra a ningún brief.",
  approved: "Entra al brief de las corridas de su alcance y de sus roles.",
  rejected: "Descartado sin haber entrado nunca a un brief. Proponer el mismo texto otra vez no lo revive.",
  archived: "Estaba aprobado y se retiró, o «Filtrar con el criterio» lo archivó: ya no entra a los briefs. Se puede volver a aprobar.",
}

export const STATUSES = Object.keys(STATUS_LABEL) as LearningStatus[]

export const SOURCE_LABEL: Record<LearningSource, string> = {
  import: "Importado",
  agent: "De un agente",
  human: "A mano",
}

export const SOURCE_HINT: Record<LearningSource, string> = {
  import: "Viene de las viñetas de «Decisiones y aprendizajes» del clanker-loop. Muchos hablan del loop viejo: léelos antes de aprobar.",
  agent: "Lo propuso un agente en el reporte de un paso. Mira la corrida de donde salió.",
  human: "Lo escribió una persona con `learnings.propose`.",
}

export const SOURCES = Object.keys(SOURCE_LABEL) as LearningSource[]

/** Una decisión que todavía se puede deshacer: se manda al core recién al pasar `UNDO_MS`. */
export type TriageAction = "approve" | "reject"

/** El estado al que lleva cada acción desde `from` (el mismo que calcula el core). */
export function statusAfter(action: TriageAction, from: LearningStatus): LearningStatus {
  if (action === "approve") return "approved"
  return from === "approved" ? "archived" : from === "proposed" ? "rejected" : from
}

/** Los learnings como se verán cuando el core aplique lo que está esperando su plazo de deshacer. */
export function withPending(learnings: Learning[], pending: ReadonlyMap<LearningId, TriageAction>): Learning[] {
  if (pending.size === 0) return learnings
  return learnings.map((l) => {
    const action = pending.get(l.id)
    return action ? { ...l, status: statusAfter(action, l.status) } : l
  })
}

/** El alcance elegido en el filtro: un proyecto o un repo. */
export type ScopeFilter = { kind: "project"; id: ProjectId } | { kind: "repo"; id: RepoId }

export interface LearningFilters {
  scope: ScopeFilter | null
  /** `null`: cualquiera; `""`: los que valen para todos los roles; un slug: los que nombran ese rol. */
  role: string | null
  source: LearningSource | null
  query: string
}

export const NO_FILTERS: LearningFilters = { scope: null, role: null, source: null, query: "" }

export const isFiltered = (f: LearningFilters) => f.scope !== null || f.role !== null || f.source !== null || f.query.trim() !== ""

/** Todo menos el estado: de ahí salen los contadores de cada pestaña. */
export function matches(l: Learning, f: LearningFilters): boolean {
  if (f.scope && (f.scope.kind === "project" ? l.projectId !== f.scope.id : l.repoId !== f.scope.id)) return false
  if (f.role !== null && (f.role === "" ? l.roles.length > 0 : !l.roles.includes(f.role))) return false
  if (f.source && l.source !== f.source) return false
  const q = f.query.trim().toLowerCase()
  return !q || l.text.toLowerCase().includes(q) || l.tags.some((t) => t.toLowerCase().includes(q))
}

/** Cuántos hay en cada estado, entre los que pasan los filtros. */
export function countByStatus(learnings: Learning[], f: LearningFilters): Record<LearningStatus, number> {
  const counts: Record<LearningStatus, number> = { proposed: 0, approved: 0, rejected: 0, archived: 0 }
  for (const l of learnings) if (matches(l, f)) counts[l.status]++
  return counts
}

/** Los de una pestaña, de más reciente a más antiguo (los ids del core ordenan por creación). */
export function visibleLearnings(learnings: Learning[], status: LearningStatus, f: LearningFilters): Learning[] {
  return learnings.filter((l) => l.status === status && matches(l, f)).sort((a, b) => (a.id < b.id ? 1 : -1))
}

/** Los slugs de rol que nombra algún learning, ordenados: el filtro de rol sale de los datos, no de una lista escrita aquí. */
export function rolesOf(learnings: Learning[]): string[] {
  return [...new Set(learnings.flatMap((l) => l.roles))].sort()
}

/** El `Select` de alcance guarda el filtro como texto: `p:<id>` o `r:<id>`. */
export const scopeKey = (s: ScopeFilter | null) => (s ? `${s.kind === "project" ? "p" : "r"}:${s.id}` : "all")

export function scopeFromKey(key: string): ScopeFilter | null {
  if (key.startsWith("p:")) return { kind: "project", id: key.slice(2) as ProjectId }
  if (key.startsWith("r:")) return { kind: "repo", id: key.slice(2) as RepoId }
  return null
}

/** Los proyectos y repos con learnings, para el filtro de alcance. */
export function scopesOf(learnings: Learning[]): { projects: ProjectId[]; repos: RepoId[] } {
  return {
    projects: [...new Set(learnings.flatMap((l) => (l.projectId ? [l.projectId] : [])))],
    repos: [...new Set(learnings.flatMap((l) => (l.repoId ? [l.repoId] : [])))],
  }
}

/** Sobre quién actúan A, R y los botones: la selección si hay, y si no el learning a la vista. */
export function targetsOf(selected: Learning[], current: Learning | null): Learning[] {
  return selected.length > 0 ? selected : current ? [current] : []
}

/** Lo que dice un aviso de deshacer: "Aprobaste 3 learnings", "Rechazaste «texto…»". */
export function triageMessage(action: TriageAction, targets: Learning[]): string {
  const retire = action === "reject" && targets.every((l) => l.status === "approved")
  const verb = action === "approve" ? "Aprobaste" : retire ? "Retiraste" : "Rechazaste"
  if (targets.length === 1) return `${verb} «${clip(targets[0]!.text, 56)}»`
  return `${verb} ${targets.length} learnings`
}

export function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** Qué acciones admite un learning según su estado. */
export function capsOf(l: Pick<Learning, "status">): { approve: boolean; reject: boolean } {
  return { approve: l.status !== "approved", reject: l.status === "proposed" || l.status === "approved" }
}

/** El nombre de la acción de rechazar según el estado: un aprobado no se rechaza, se retira. */
export const rejectLabel = (l: Pick<Learning, "status">) => (l.status === "approved" ? "Retirar" : "Rechazar")
export const approveLabel = (l: Pick<Learning, "status">) => (l.status === "proposed" ? "Aprobar" : "Volver a aprobar")
