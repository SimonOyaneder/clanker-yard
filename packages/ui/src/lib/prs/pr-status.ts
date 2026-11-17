import { type ReviewStatus, reviewStatusOf } from "@clanker/api"
import { tone } from "../format"
import type { OpenPr } from "./prs"
import { isDraft } from "./prs"

export type { ReviewStatus }
export const reviewStatus = (pr: OpenPr): ReviewStatus => reviewStatusOf(pr.state)

export const reviewTone: Record<ReviewStatus, { label: string; pill: string; ring: string; dot: string }> = {
  changes: { label: "Necesita acción", pill: tone.red, ring: "ring-red-500/60", dot: "bg-red-500" },
  pending: { label: "Esperando review", pill: tone.amber, ring: "ring-amber-500/60", dot: "bg-amber-500" },
  approved: { label: "Aprobado", pill: tone.green, ring: "ring-emerald-500/60", dot: "bg-emerald-500" },
  none: { label: "Sin review", pill: tone.neutral, ring: "ring-border", dot: "bg-neutral-400" },
}

export const draftTone = { label: "Draft", pill: tone.neutral }

/**
 * Lo que dice la estrategia de merge de un PR: `failed` (se pidió y falló en la cola), `queued` (se pidió y
 * corre), `hold` (el usuario dijo "no mergear nunca") o `ready`. Sin nada de eso, `null`.
 */
export type MergeMark = "failed" | "queued" | "hold" | "ready"

export function mergeMark({ state }: OpenPr): MergeMark | null {
  if (state.merge.queue === "failed") return "failed"
  if (state.merge.queue === "queued") return "queued"
  if (state.hold) return "hold"
  return state.merge.ready ? "ready" : null
}

// Color del nodo en el minimapa: el estado de review manda; si no hay, el del PR.
export function accentHex(pr: OpenPr): string {
  const r = reviewStatus(pr)
  if (r === "changes") return "#ef4444"
  if (r === "pending") return "#f59e0b"
  if (r === "approved") return "#10b981"
  return isDraft(pr) ? "#a1a1aa" : "#8b5cf6"
}
