import type { PlanUsage } from "@/types"
import { absolute, ago } from "@/lib/format"
import { cn } from "@/lib/utils"
import { Hint } from "./common"

const STALE_MS = 15 * 60_000

function tone(pct: number): string {
  if (pct >= 90) return "bg-red-500"
  if (pct >= 70) return "bg-amber-500"
  return "bg-primary"
}

// "1:23" para la ventana de 5 h (como la status line) y "lun 16" para la semanal.
function untilReset(iso: string | null, short: boolean): string {
  if (!iso) return ""
  const ms = Date.parse(iso) - Date.now()
  if (ms <= 0) return "ya"
  if (short) {
    const m = Math.round(ms / 60_000)
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`
  }
  return new Date(iso).toLocaleDateString("es-CL", { weekday: "short", day: "numeric" }).replace(".", "")
}

function Row({ label, w, short }: { label: string; w: { pct: number; resetsAt: string | null }; short: boolean }) {
  const pct = Math.max(0, Math.min(100, w.pct))
  return (
    <Hint label={w.resetsAt ? `${label}: ${pct}% usado · se renueva ${absolute(w.resetsAt)}` : `${label}: ${pct}% usado`} side="top">
      <div
        role="meter"
        aria-label={`Uso del plan de Claude, ventana de ${label}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="grid grid-cols-[34px_minmax(0,1fr)_30px_38px] items-center gap-2 text-[11px] text-sidebar-foreground/70 tabular-nums"
      >
        <span>{label}</span>
        <span className="h-1.5 overflow-hidden rounded-full bg-sidebar-accent">
          <span className={cn("block h-full rounded-full", tone(pct))} style={{ width: `${pct}%` }} />
        </span>
        <span className={cn("text-right", pct >= 90 ? "text-red-600 dark:text-red-400" : pct >= 70 ? "text-amber-600 dark:text-amber-400" : "text-sidebar-foreground")}>
          {pct}%
        </span>
        <span className="text-right">{untilReset(w.resetsAt, short)}</span>
      </div>
    </Hint>
  )
}

export function PlanUsageBars({ usage }: { usage: PlanUsage | null }) {
  if (!usage || (!usage.fiveHour && !usage.sevenDay)) return null
  const stale = Date.now() - Date.parse(usage.updatedAt) > STALE_MS
  return (
    <section aria-label="Uso del plan de Claude" className="flex flex-col gap-1.5 px-1.5">
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="font-medium text-sidebar-foreground/80">Plan de Claude</span>
        <span title={absolute(usage.updatedAt)} className={cn("text-sidebar-foreground/50", stale && "text-amber-600 dark:text-amber-400")}>
          {stale ? `dato de ${ago(usage.updatedAt)}` : ago(usage.updatedAt)}
        </span>
      </div>
      {usage.fiveHour ? <Row label="5 h" w={usage.fiveHour} short /> : null}
      {usage.sevenDay ? <Row label="7 días" w={usage.sevenDay} short={false} /> : null}
    </section>
  )
}
