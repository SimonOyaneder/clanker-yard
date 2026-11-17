import type { Breaker } from "@clanker/api"
import { Loader2, OctagonPause, RotateCw } from "lucide-react"
import { useState } from "react"
import { Hint, Pill } from "@/components/common"
import { Button } from "@/components/ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuShortcut, ContextMenuTrigger } from "@/components/ui/context-menu"
import { useAppActions } from "@/lib/app-context"
import { absolute, tone } from "@/lib/format"
import { BREAKER_CAUSE, pausedBy } from "@/lib/project/project-ops"

/** El atajo que reintenta ya los breakers abiertos (los del proyecto a la vista, o todos). */
export const RETRY_BREAKERS_KEYS = "⇧⌘E"

const clock = (at: number) => new Date(at).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", hour12: false })

/** "en 4 min" o "ya" si la prueba ya toca. */
function inHowLong(at: number, now: number): string {
  const minutes = Math.ceil((at - now) / 60_000)
  if (minutes <= 0) return "ya"
  if (minutes < 60) return `en ${minutes} min`
  return `en ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`
}

/** "19:58 · en 4 min": cuándo el core vuelve a probar solo. */
export const nextRetry = (at: number, now: number) => `${clock(at)} · ${inHowLong(at, now)}`

/** Reintentar ya un breaker, con el botón ocupado mientras el core prueba (una receta puede tardar unos segundos). */
export function useRetryBreaker(scope: string | undefined): { retrying: boolean; retry: () => void } {
  const actions = useAppActions()
  const [retrying, setRetrying] = useState(false)
  const retry = () => {
    if (retrying || scope === undefined) return
    setRetrying(true)
    void actions.retryBreakers(null, scope).finally(() => setRetrying(false))
  }
  return { retrying, retry }
}

export function RetryBreakerButton({ retrying, onRetry, variant = "outline" }: { retrying: boolean; onRetry: () => void; variant?: "outline" | "default" }) {
  return (
    <Hint label="Probar ya si la causa se fue, sin esperar al próximo reintento" keys={RETRY_BREAKERS_KEYS}>
      <Button variant={variant} size="sm" disabled={retrying} onClick={onRetry}>
        {retrying ? <Loader2 className="animate-spin" /> : <RotateCw />} {retrying ? "Probando…" : "Reintentar ahora"}
      </Button>
    </Hint>
  )
}

// Un breaker abierto pausa solo lo que depende de su causa: la franja dice qué, por qué y cuándo se vuelve a probar,
// y deja probar ya cuando la causa se arregló a mano.
export function BreakerStrip({ breakers, now }: { breakers: readonly Breaker[]; now: number }) {
  if (!breakers.length) return null
  return (
    <section aria-label="Breakers abiertos" className="flex flex-col gap-2">
      {breakers.map((b) => (
        <BreakerRow key={b.scope} breaker={b} now={now} />
      ))}
    </section>
  )
}

function BreakerRow({ breaker: b, now }: { breaker: Breaker; now: number }) {
  const { retrying, retry } = useRetryBreaker(b.scope)
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div role="status" className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
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
          <div className="flex flex-none flex-col items-end gap-1.5">
            <span title={absolute(b.nextProbeAt)} className="text-right text-xs text-muted-foreground tabular-nums">
              Próximo reintento
              <br />
              <span className="text-[13px] text-foreground">{nextRetry(b.nextProbeAt, now)}</span>
            </span>
            <RetryBreakerButton retrying={retrying} onRetry={retry} />
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-60">
        <ContextMenuItem disabled={retrying} onSelect={retry}>
          <RotateCw /> Reintentar ahora
          <ContextMenuShortcut>{RETRY_BREAKERS_KEYS}</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
