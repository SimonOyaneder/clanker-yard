import type { Run, RunStatus, StepStatus } from "@clanker/api"
import { CheckCircle2, Circle, CircleDot, CircleOff, Clock, CircleAlert, Hand } from "lucide-react"
import type { ComponentType } from "react"
import { Pill } from "@/components/common"
import { tone } from "@/lib/format"
import { cn } from "@/lib/utils"

interface Look {
  label: string
  tone: string
  hint: string
  Icon: ComponentType<{ className?: string }>
  iconClass: string
  pulse?: boolean
}

const RUN: Record<RunStatus, Look> = {
  queued: { label: "en cola", tone: tone.neutral, hint: "Espera cupo en su carril.", Icon: Circle, iconClass: "text-muted-foreground" },
  running: { label: "corriendo", tone: tone.violet, hint: "Un paso se está ejecutando.", Icon: CircleDot, iconClass: "text-violet-600 dark:text-violet-400", pulse: true },
  waiting: { label: "esperando", tone: tone.sky, hint: "Espera que terminen sus ramas o un evento externo. No bloquea a las demás.", Icon: Clock, iconClass: "text-sky-600 dark:text-sky-400" },
  parked: { label: "estacionada", tone: tone.amber, hint: "Espera a una persona. No ocupa cupo de su carril.", Icon: Hand, iconClass: "text-amber-600 dark:text-amber-400" },
  paused: { label: "pausada", tone: tone.neutral, hint: "Detenida a mano: no toma pasos nuevos hasta que se reanude.", Icon: Circle, iconClass: "text-muted-foreground" },
  done: { label: "lista", tone: tone.green, hint: "Terminó el flujo.", Icon: CheckCircle2, iconClass: "text-emerald-600 dark:text-emerald-400" },
  failed: { label: "falló", tone: tone.red, hint: "Un paso falló y el flujo no tiene a dónde seguir.", Icon: CircleAlert, iconClass: "text-red-600 dark:text-red-400" },
  canceled: { label: "cancelada", tone: tone.neutral, hint: "Alguien la canceló antes de terminar.", Icon: CircleOff, iconClass: "text-muted-foreground" },
}

/** Con el flujo terminado, el outcome distingue una corrida lista de una bloqueada. */
function lookOf(run: Pick<Run, "status" | "outcome">): Look {
  if (run.status === "done" && run.outcome === "blocked") {
    return { ...RUN.done, label: "bloqueada", tone: tone.amber, hint: "El flujo terminó sin poder completar la issue.", iconClass: "text-amber-600 dark:text-amber-400" }
  }
  return RUN[run.status]
}

export const isLive = (status: RunStatus) => status === "queued" || status === "running" || status === "waiting" || status === "parked" || status === "paused"

export function RunStatusPill({ run }: { run: Pick<Run, "status" | "outcome"> }) {
  const look = lookOf(run)
  return (
    <Pill className={look.tone} hint={look.hint}>
      {look.label}
    </Pill>
  )
}

export function RunStatusIcon({ run, className }: { run: Pick<Run, "status" | "outcome">; className?: string }) {
  const look = lookOf(run)
  return <look.Icon aria-label={look.label} className={cn("size-3.5 flex-none", look.iconClass, look.pulse && "cc-blink", className)} />
}

const STEP: Record<StepStatus, Look> = {
  pending: { label: "pendiente", tone: tone.neutral, hint: "Todavía no parte.", Icon: Circle, iconClass: "text-muted-foreground" },
  leased: { label: "tomado", tone: tone.violet, hint: "Un worker lo tomó y está por ejecutarlo.", Icon: CircleDot, iconClass: "text-violet-600 dark:text-violet-400", pulse: true },
  running: { label: "corriendo", tone: tone.violet, hint: "Se está ejecutando.", Icon: CircleDot, iconClass: "text-violet-600 dark:text-violet-400", pulse: true },
  waiting: { label: "esperando", tone: tone.sky, hint: "Espera a sus ramas o a un evento externo.", Icon: Clock, iconClass: "text-sky-600 dark:text-sky-400" },
  done: { label: "listo", tone: tone.green, hint: "Terminó y dio su resultado.", Icon: CheckCircle2, iconClass: "text-emerald-600 dark:text-emerald-400" },
  failed: { label: "falló", tone: tone.red, hint: "Falló; el motivo está debajo.", Icon: CircleAlert, iconClass: "text-red-600 dark:text-red-400" },
  canceled: { label: "cancelado", tone: tone.neutral, hint: "Se canceló antes de terminar.", Icon: CircleOff, iconClass: "text-muted-foreground" },
}

export const stepLook = (status: StepStatus) => STEP[status]
