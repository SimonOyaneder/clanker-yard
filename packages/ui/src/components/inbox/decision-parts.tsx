import type { CachedIssue, ClankerProject, Decision, DecisionKind } from "@clanker/api"
import { BellRing, CircleAlert, CircleHelp, Hand, Lightbulb, MessageSquare } from "lucide-react"
import type { ComponentType } from "react"
import { Pill } from "@/components/common"
import { KIND_HINT, KIND_LABEL, parksRun } from "@/lib/decisions"
import { issueKey, tone } from "@/lib/format"
import { cn } from "@/lib/utils"

const KIND: Record<DecisionKind, { tone: string; iconClass: string; Icon: ComponentType<{ className?: string }> }> = {
  gate: { tone: tone.amber, iconClass: "text-amber-600 dark:text-amber-400", Icon: Hand },
  needs_human: { tone: tone.amber, iconClass: "text-amber-600 dark:text-amber-400", Icon: CircleAlert },
  review_note: { tone: tone.sky, iconClass: "text-sky-600 dark:text-sky-400", Icon: MessageSquare },
  note: { tone: tone.neutral, iconClass: "text-muted-foreground", Icon: Lightbulb },
  question: { tone: tone.violet, iconClass: "text-violet-600 dark:text-violet-400", Icon: CircleHelp },
  alert: { tone: tone.red, iconClass: "text-red-600 dark:text-red-400", Icon: BellRing },
}

export function KindIcon({ kind, className }: { kind: DecisionKind; className?: string }) {
  const look = KIND[kind]
  return <look.Icon aria-hidden className={cn("size-3.5 flex-none", look.iconClass, className)} />
}

export function KindPill({ kind }: { kind: DecisionKind }) {
  return (
    <Pill className={KIND[kind].tone} hint={KIND_HINT[kind]}>
      {KIND_LABEL[kind]}
    </Pill>
  )
}

/** Dónde ocurrió una decisión: su proyecto y, si la tiene, la issue de su corrida. */
export interface DecisionScope {
  project: ClankerProject | undefined
  issue: CachedIssue | undefined
}

/** El chip de la corrida o el PR que estaciona la decisión (o de la que salió, si no bloquea). */
export function RunChip({ decision, scope, onOpen }: { decision: Decision; scope: DecisionScope; onOpen?: () => void }) {
  if (!decision.runId) return null
  const target = scope.issue ? issueKey(scope.issue) : decision.subject?.type === "pr" ? "un PR" : "su corrida"
  const parks = parksRun(decision)
  const chip = (
    <Pill
      className={cn(parks ? tone.amber : tone.neutral, onOpen && "cursor-pointer")}
      hint={
        parks
          ? `Esta decisión tiene estacionada la corrida de ${target}. No ocupa cupo en su carril y nada más espera: al resolverla vuelve a la cola.`
          : `La corrida de ${target} siguió sin esperar esta decisión.`
      }
    >
      {parks ? `Estaciona ${target}` : target}
    </Pill>
  )
  if (!onOpen) return chip
  return (
    <button type="button" onClick={onOpen} aria-label={`Abrir la corrida de ${target}`} className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {chip}
    </button>
  )
}
