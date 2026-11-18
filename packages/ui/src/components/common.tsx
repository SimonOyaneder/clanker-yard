import type { ReactNode } from "react"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { absolute, ago } from "@/lib/format"
import { cn } from "@/lib/utils"

export function SectionTitle({ children, aside, count }: { children: ReactNode; aside?: ReactNode; count?: number }) {
  return (
    <div className="flex min-h-6 items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-[13px] font-medium">
        {children}
        {count !== undefined ? <span className="text-xs font-normal text-muted-foreground tabular-nums">{count}</span> : null}
      </h2>
      {aside ? <div className="truncate text-xs text-muted-foreground">{aside}</div> : null}
    </div>
  )
}

// `hint` explica qué significa el tag: va en el tooltip de la app, no en el `title` nativo.
export function Pill({ children, className, hint }: { children: ReactNode; className?: string; hint?: ReactNode }) {
  const pill = <span className={cn("inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] font-medium whitespace-nowrap", className)}>{children}</span>
  return hint ? <Hint label={hint}>{pill}</Hint> : pill
}

// Atajo de teclado: "⌘K", "⇧⌘2". Cada carácter en su tecla, como en macOS.
export function Shortcut({ keys, className }: { keys: string; className?: string }) {
  return (
    <KbdGroup className={className}>
      {[...keys].map((k, i) => (
        <Kbd key={`${k}-${i}`}>{k}</Kbd>
      ))}
    </KbdGroup>
  )
}

// Tooltip con atajo opcional, el patrón de Linear.
export function Hint({ label, keys, children, side }: { label: ReactNode; keys?: string; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className="flex max-w-[300px] items-center gap-2 text-pretty">
        {label}
        {keys ? <Shortcut keys={keys} /> : null}
      </TooltipContent>
    </Tooltip>
  )
}

// Hora relativa con la absoluta al pasar el mouse.
export function Ago({ at, className }: { at: number | string | null | undefined; className?: string }) {
  if (at === null || at === undefined) return null
  return (
    <time dateTime={new Date(at).toISOString()} title={absolute(at)} className={className}>
      {ago(at)}
    </time>
  )
}

// Fila de métricas en un solo bloque, en vez de cinco tarjetas sueltas.
export function StatBar({ items }: { items: { label: string; value: ReactNode; sub?: string; tone?: string; /** Un control en la esquina de la celda. */ action?: ReactNode }[] }) {
  return (
    <section aria-label="Métricas" className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] overflow-hidden rounded-lg border bg-card">
      {items.map((k, i) => (
        <div key={k.label} className={cn("relative flex min-w-0 flex-col gap-0.5 px-4 py-3", i > 0 && "border-l")}>
          {k.action}
          <span className="truncate text-xs text-muted-foreground">{k.label}</span>
          <span className={cn("text-lg leading-tight font-semibold tabular-nums", k.tone)}>{k.value}</span>
          {k.sub ? <span className="truncate text-[11.5px] text-muted-foreground">{k.sub}</span> : null}
        </div>
      ))}
    </section>
  )
}
