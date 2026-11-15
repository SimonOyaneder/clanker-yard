import type { PullRequest } from "@/types"
import { tone } from "./format"

export type ReviewStatus = "changes" | "pending" | "approved" | "none"

// Portado de stack-pr: lo que importa para decidir qué PR mirar primero.
export function reviewStatus(pr: PullRequest): ReviewStatus {
  if (pr.state !== "open" && pr.state !== "draft") return "none"
  if (pr.reviewDecision === "changes_requested") return "changes"
  const kinds = new Set(pr.reviewerStates.map((r) => r.state))
  if (kinds.has("changes_requested")) return "changes"
  if (pr.reviewDecision === "approved" && kinds.has("approved")) return "approved"
  if (kinds.has("pending")) return "pending"
  if (kinds.has("commented") || pr.unresolvedThreads > 0) return "changes"
  if (kinds.has("approved")) return "approved"
  if (pr.reviewDecision === "review_required" && !pr.isDraft) return "pending"
  return "none"
}

export const reviewTone: Record<ReviewStatus, { label: string; pill: string; ring: string; dot: string }> = {
  changes: { label: "Necesita acción", pill: tone.red, ring: "ring-red-500/60", dot: "bg-red-500" },
  pending: { label: "Esperando review", pill: tone.amber, ring: "ring-amber-500/60", dot: "bg-amber-500" },
  approved: { label: "Aprobado", pill: tone.green, ring: "ring-emerald-500/60", dot: "bg-emerald-500" },
  none: { label: "Sin review", pill: tone.neutral, ring: "ring-border", dot: "bg-neutral-400" },
}

export const prStateTone: Record<PullRequest["state"], { label: string; pill: string }> = {
  open: { label: "Abierto", pill: tone.green },
  draft: { label: "Draft", pill: tone.neutral },
  merged: { label: "Mergeado", pill: tone.violet },
  closed: { label: "Cerrado", pill: tone.red },
}

// Color del nodo en el minimapa: el estado de review manda; si no hay, el del PR.
export function accentHex(pr: PullRequest): string {
  const r = reviewStatus(pr)
  if (r === "changes") return "#ef4444"
  if (r === "pending") return "#f59e0b"
  if (r === "approved") return "#10b981"
  return pr.isDraft ? "#a1a1aa" : "#8b5cf6"
}
