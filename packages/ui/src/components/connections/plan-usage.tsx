import type { CodexStatus } from "@clanker/api"
import { RefreshCw } from "lucide-react"
import { Hint } from "@/components/common"
import { UsageBar } from "@/components/connections/usage-bar"
import type { ClaudePlan } from "@/hooks/use-claude-plan"
import { PLAN_REFRESH_MS } from "@/hooks/use-claude-plan"
import { CODEX_REFRESH_MS, type CodexPlan } from "@/hooks/use-codex-plan"
import { windowLabel } from "@/lib/connections"
import { absolute, ago } from "@/lib/format"
import { cn } from "@/lib/utils"

// El uso del plan de Claude en el pie de la barra lateral: lo que leyó la última prueba (`connections.testClaude`),
// con un dato que se marca viejo si el refresco espaciado no pudo renovarlo.
export function PlanUsage({ plan }: { plan: ClaudePlan }) {
  const usage = plan.status?.usage
  if (!plan.status || plan.at === null || (!usage?.fiveHour && !usage?.sevenDay)) return null
  const stale = Date.now() - plan.at > 2 * PLAN_REFRESH_MS
  const exhausted = plan.status.state === "quota_exhausted"
  return (
    <section aria-label="Uso del plan de Claude" className="flex flex-col gap-1.5 px-1.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="font-medium text-sidebar-foreground/80">Plan de Claude</span>
        <span className="flex items-center gap-1">
          <span title={absolute(plan.at)} className={cn("text-sidebar-foreground/50", stale && "text-amber-600 dark:text-amber-400")}>
            {stale ? `dato de ${ago(plan.at)}` : ago(plan.at)}
          </span>
          <Hint label="Actualizar el uso con una llamada mínima a Claude" keys="⇧⌘T" side="top">
            <button type="button" onClick={() => void plan.test()} disabled={plan.testing} aria-label="Actualizar el uso del plan" className="grid size-5 place-items-center rounded text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground disabled:opacity-50">
              <RefreshCw className={cn("size-3", plan.testing && "animate-spin")} />
            </button>
          </Hint>
        </span>
      </div>
      {usage.fiveHour ? <UsageBar label="5 h" window={usage.fiveHour} short /> : null}
      {usage.sevenDay ? <UsageBar label="7 días" window={usage.sevenDay} short={false} /> : null}
      {exhausted ? (
        <span className="text-[11px] text-red-600 dark:text-red-400">
          Cuota agotada{plan.status.resetsAt ? ` · se renueva a las ${new Date(plan.status.resetsAt).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", hour12: false })}` : ""}
        </span>
      ) : null}
    </section>
  )
}

/** "14:05" si es hoy; "lun 23, 14:05" si es otro día (una ventana de Codex puede durar una semana). */
export function renewal(ms: number, now = Date.now()): string {
  const at = new Date(ms)
  const time = at.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", hour12: false })
  if (at.toDateString() === new Date(now).toDateString()) return `a las ${time}`
  return `el ${at.toLocaleDateString("es-CL", { weekday: "short", day: "numeric" }).replace(".", "")}, ${time}`
}

/** Las ventanas de uso de Codex como barras, cada una rotulada por su duración. */
export function CodexUsageBars({ status, className }: { status: CodexStatus; className?: string }) {
  const windows = status.usage?.windows ?? []
  if (windows.length === 0) return null
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {windows.map((w) => (
        <UsageBar key={w.id} label={windowLabel(w)} product="Codex" window={{ utilization: w.usedPercent / 100, ...(w.resetsAt !== undefined && { resetsAt: w.resetsAt }) }} short={w.windowMins !== null && w.windowMins < 1440} />
      ))}
    </div>
  )
}

// El uso del plan de Codex en el pie de la barra lateral, debajo del de Claude: lo último que sabe el core (la prueba
// espaciada o lo que trajo una corrida), con un dato que se marca viejo si el refresco no pudo renovarlo.
export function CodexPlanUsage({ plan }: { plan: CodexPlan }) {
  const { status } = plan
  const exhausted = status?.state === "quota_exhausted"
  if (!status || (!status.usage?.windows.length && !exhausted)) return null
  const stale = plan.at === null || Date.now() - plan.at > 2 * CODEX_REFRESH_MS
  return (
    <section aria-label="Uso del plan de Codex" className="flex flex-col gap-1.5 px-1.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="font-medium text-sidebar-foreground/80">Plan de Codex</span>
        <span className="flex items-center gap-1">
          <span title={plan.at === null ? "Lo que el core guardaba de la última prueba" : absolute(plan.at)} className={cn("text-sidebar-foreground/50", stale && "text-amber-600 dark:text-amber-400")}>
            {plan.at === null ? "dato guardado" : stale ? `dato de ${ago(plan.at)}` : ago(plan.at)}
          </span>
          <Hint label="Actualizar el uso de Codex (no gasta cuota)" keys="⇧⌘X" side="top">
            <button type="button" onClick={() => void plan.test()} disabled={plan.testing} aria-label="Actualizar el uso del plan de Codex" className="grid size-5 place-items-center rounded text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground disabled:opacity-50">
              <RefreshCw className={cn("size-3", plan.testing && "animate-spin")} />
            </button>
          </Hint>
        </span>
      </div>
      <CodexUsageBars status={status} />
      {exhausted ? <span className="text-[11px] text-red-600 dark:text-red-400">Cuota agotada{status.resetsAt ? ` · se renueva ${renewal(status.resetsAt)}` : ""}</span> : null}
    </section>
  )
}
