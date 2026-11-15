import type { Decision, DecisionKind, ProjectId } from "@clanker/api"

/** Un `gate` y un `needs_human` estacionan su corrida; el resto no detiene nada (`docs/design.html#d-ui`, Bandeja de decisiones). */
export const isBlocking = (d: Pick<Decision, "kind">) => d.kind === "gate" || d.kind === "needs_human"

/** Pendiente y bloqueante: hay una corrida estacionada que espera a una persona. */
export const parksRun = (d: Pick<Decision, "kind" | "status">) => d.status === "pending" && isBlocking(d)

/** La opción con la que se marca vista una decisión que no bloquea y no trae opciones propias. */
export const SEEN = "seen"

export const KIND_LABEL: Record<DecisionKind, string> = {
  gate: "Aprobación",
  needs_human: "Necesita ayuda",
  review_note: "Nota de revisión",
  note: "Nota",
  question: "Pregunta",
  alert: "Alerta",
}

export const KIND_HINT: Record<DecisionKind, string> = {
  gate: "Un gate del flujo: la corrida espera tu respuesta, estacionada, y sigue por la opción que elijas.",
  needs_human: "Un paso no pudo seguir o la corrida llegó a su tope de gasto: espera estacionada a que decidas qué hacer.",
  review_note: "Algo que dejó la revisión (un hallazgo sin resolver, un CI rojo ajeno). La corrida siguió sin esperarla.",
  note: "Un aviso o una propuesta del sistema. No detiene nada.",
  question: "Una pregunta de un agente que no bloquea su corrida.",
  alert: "Algo del entorno que pide tu atención (una credencial vencida, un breaker abierto). Lo demás sigue corriendo.",
}

const FORCE = "force:"

/** Cómo se lee una opción de `decision.options`. En un gate el cuerpo trae una línea `id: etiqueta` por opción. */
export function optionLabel(decision: Pick<Decision, "kind" | "body">, option: string): string {
  if (decision.kind === "gate") {
    const line = decision.body.split("\n").find((l) => l.startsWith(`${option}: `))
    return line ? line.slice(option.length + 2) : option
  }
  if (decision.kind === "needs_human") {
    if (option === "retry") return "Reintentar el paso"
    if (option === "cancel") return "Cancelar la corrida"
    if (option === "continue") return "Continuar"
    if (option.startsWith(FORCE)) return `Seguir como "${option.slice(FORCE.length)}"`
  }
  return option === SEEN ? "Marcar como vista" : option
}

/** Una opción que termina la corrida: se pinta aparte y su atajo es el mismo, pero se puede deshacer. */
export const isDestructive = (option: string) => option === "cancel"

/**
 * Lo que se puede elegir con 1 a 9: las opciones de la decisión o, si no hay ninguna que elegir, marcarla vista.
 * Una alerta sin opciones (la de un breaker) no se resuelve a mano: el core la cierra cuando la causa se va.
 */
export function optionsOf(decision: Pick<Decision, "kind" | "options">): string[] {
  if (decision.options.length) return decision.options
  return isBlocking(decision) || decision.kind === "alert" ? [] : [SEEN]
}

/** "Responder…" con texto libre: lo que no bloquea y no se cierra solo. */
export const takesText = (decision: Pick<Decision, "kind" | "status">) => decision.status === "pending" && !isBlocking(decision) && decision.kind !== "alert"

/** Lo que se eligió o respondió, para leerlo en las resueltas. */
export function resolutionText(decision: Decision): string | null {
  const option = (decision.resolution as { option?: unknown } | null)?.option
  return typeof option === "string" ? optionLabel(decision, option) : null
}

export type InboxTab = "pending" | "resolved"

export interface InboxFilter {
  tab: InboxTab
  projectId: ProjectId | null
  kind: DecisionKind | null
}

/**
 * Lo que muestra la lista. Las pendientes van con las que estacionan una corrida primero (esas esperan
 * a alguien), cada grupo de la más reciente a la más antigua; las resueltas, por cuándo se cerraron.
 */
export function visibleDecisions(decisions: Decision[], filter: InboxFilter): Decision[] {
  const matching = decisions.filter(
    (d) => (filter.tab === "pending") === (d.status === "pending") && (!filter.projectId || d.projectId === filter.projectId) && (!filter.kind || d.kind === filter.kind),
  )
  if (filter.tab === "resolved") return matching.sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))
  return matching.sort((a, b) => Number(parksRun(b)) - Number(parksRun(a)) || b.createdAt - a.createdAt)
}

/** Cuántas decisiones se resolvieron desde las 00:00 de hoy. */
export function resolvedToday(decisions: Decision[], now: number): number {
  const start = new Date(now).setHours(0, 0, 0, 0)
  return decisions.filter((d) => d.status !== "pending" && d.resolvedAt !== null && d.resolvedAt >= start).length
}

export const RESOLVED_LABEL: Record<Decision["status"], string> = {
  pending: "pendiente",
  accepted: "aceptada",
  rejected: "rechazada",
  answered: "respondida",
  expired: "venció",
  superseded: "ya no aplica",
}

export const RESOLVED_HINT: Record<Decision["status"], string> = {
  pending: "Espera a una persona.",
  accepted: "Alguien la aceptó.",
  rejected: "Alguien la rechazó.",
  answered: "Alguien eligió una opción o respondió.",
  expired: "Nadie respondió a tiempo: el flujo siguió solo por su opción por defecto.",
  superseded: "Ya no había nada que decidir: la corrida se canceló antes de que alguien respondiera.",
}
