import type { ClaudeUsageWindow } from "@clanker/api"
import { Hint } from "@/components/common"
import { Progress } from "@/components/ui/progress"
import { untilReset, usagePercent, usageTone } from "@/lib/connections"
import { absolute } from "@/lib/format"
import { cn } from "@/lib/utils"

const INDICATOR = {
  ok: "[&>[data-slot=progress-indicator]]:bg-primary",
  warn: "[&>[data-slot=progress-indicator]]:bg-amber-500",
  danger: "[&>[data-slot=progress-indicator]]:bg-red-500",
} as const

const TEXT = {
  ok: "text-foreground",
  warn: "text-amber-700 dark:text-amber-400",
  danger: "text-red-700 dark:text-red-400",
} as const

/** "1:23" para una ventana corta (la de 5 h) y "lun 16" para una larga (la semanal). */
function resetLabel(window: ClaudeUsageWindow, short: boolean): string {
  if (short) return untilReset(window.resetsAt) ?? ""
  if (window.resetsAt === undefined) return ""
  return new Date(window.resetsAt).toLocaleDateString("es-CL", { weekday: "short", day: "numeric" }).replace(".", "")
}

// Una barra de la cuota del plan de Claude o de Codex: una ventana corta (`short`, la de 5 h) o una larga (la de 7 días).
export function UsageBar({ label, window, short, product = "Claude", className }: { label: string; window: ClaudeUsageWindow; short: boolean; product?: string; className?: string }) {
  const percent = usagePercent(window.utilization)
  const level = usageTone(percent)
  return (
    <Hint label={window.resetsAt ? `${label}: ${percent}% usado · se renueva ${absolute(window.resetsAt)}` : `${label}: ${percent}% usado`} side="top">
      <div role="meter" aria-label={`Uso del plan de ${product}, ventana de ${label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className={cn("grid grid-cols-[40px_minmax(0,1fr)_34px_40px] items-center gap-2 text-[11px] tabular-nums", className)}>
        <span className="text-muted-foreground">{label}</span>
        <Progress value={percent} className={cn("h-1.5 bg-muted", INDICATOR[level])} />
        <span className={cn("text-right", TEXT[level])}>{percent}%</span>
        <span className="text-right whitespace-nowrap text-muted-foreground">{resetLabel(window, short)}</span>
      </div>
    </Hint>
  )
}
