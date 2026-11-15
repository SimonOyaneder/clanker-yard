import type { Breaker } from "@clanker/api"
import { OctagonPause } from "lucide-react"
import { Pill } from "@/components/common"
import { absolute, tone } from "@/lib/format"
import { BREAKER_CAUSE, pausedBy } from "@/lib/project-ops"

const clock = (at: number) => new Date(at).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", hour12: false })

/** "en 4 min" o "ya" si la prueba ya toca. */
function inHowLong(at: number, now: number): string {
  const minutes = Math.ceil((at - now) / 60_000)
  if (minutes <= 0) return "ya"
  if (minutes < 60) return `en ${minutes} min`
  return `en ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`
}

// Un breaker abierto pausa solo lo que depende de su causa: la franja dice qué, por qué y cuándo se vuelve a probar.
export function BreakerStrip({ breakers, now }: { breakers: readonly Breaker[]; now: number }) {
  if (!breakers.length) return null
  return (
    <section aria-label="Breakers abiertos" className="flex flex-col gap-2">
      {breakers.map((b) => (
        <div key={b.scope} role="status" className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
          <OctagonPause className="mt-0.5 size-4 flex-none text-amber-700 dark:text-amber-300" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-2 font-medium">
              En pausa: {b.label}
              <Pill className={tone.amber} hint={BREAKER_CAUSE[b.cause].hint}>
                {BREAKER_CAUSE[b.cause].label}
              </Pill>
            </span>
            <span className="text-muted-foreground">{b.reason}</span>
            <span className="text-muted-foreground">{pausedBy(b.scope)}</span>
          </div>
          <span title={absolute(b.nextProbeAt)} className="flex-none text-right text-xs text-muted-foreground tabular-nums">
            Próximo reintento
            <br />
            <span className="text-[13px] text-foreground">
              {clock(b.nextProbeAt)} · {inHowLong(b.nextProbeAt, now)}
            </span>
          </span>
        </div>
      ))}
    </section>
  )
}
