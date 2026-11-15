import { AlertCircle, CheckCircle2, Circle, CircleDot, GitMerge, GitPullRequest } from "lucide-react"
import type { ReactNode } from "react"
import type { Member, Step } from "@/types"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ROLE_ABBR, absolute, ago, memberTone, usd } from "@/lib/format"
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
export function Ago({ iso, className }: { iso: string | null | undefined; className?: string }) {
  if (!iso) return null
  return (
    <time dateTime={iso} title={absolute(iso)} className={className}>
      {ago(iso)}
    </time>
  )
}

export type IssueState = "cola" | "curso" | "abierto" | "aprobado" | "mergeado" | "problema"

const STATE_ICON: Record<IssueState, { Icon: typeof Circle; className: string; label: string }> = {
  cola: { Icon: Circle, className: "text-muted-foreground", label: "En cola" },
  curso: { Icon: CircleDot, className: "text-violet-600 dark:text-violet-400", label: "En curso" },
  abierto: { Icon: GitPullRequest, className: "text-sky-600 dark:text-sky-400", label: "PR abierto" },
  aprobado: { Icon: CheckCircle2, className: "text-emerald-600 dark:text-emerald-400", label: "Aprobado" },
  mergeado: { Icon: GitMerge, className: "text-violet-600 dark:text-violet-400", label: "Mergeado" },
  problema: { Icon: AlertCircle, className: "text-red-600 dark:text-red-400", label: "Problema" },
}

export function StateIcon({ state, className }: { state: IssueState; className?: string }) {
  const s = STATE_ICON[state]
  return <s.Icon aria-label={s.label} className={cn("size-3.5 flex-none", s.className, className)} />
}

export function stateLabel(state: IssueState): string {
  return STATE_ICON[state].label
}

export function Stepper({ steps }: { steps: Step[] }) {
  return (
    <ol aria-label="Pasos del techlead" className="grid grid-cols-[repeat(auto-fit,minmax(72px,1fr))] gap-x-1 gap-y-2">
      {steps.map((s) => (
        <li key={s.key} className="flex flex-col gap-1.5" aria-current={s.status === "current" ? "step" : undefined}>
          <span
            className={cn(
              "h-1 rounded-full",
              s.status === "done" && "bg-emerald-500/80",
              s.status === "current" && "bg-primary",
              s.status === "todo" && "bg-muted",
            )}
          />
          <span className={cn("truncate text-[11px]", s.status === "current" ? "font-medium text-foreground" : "text-muted-foreground")}>
            {s.label}
          </span>
        </li>
      ))}
    </ol>
  )
}

const MEMBER_HINT: Record<Member["status"], string> = {
  trabajando: "Escribió en su transcript hace menos de 90 s.",
  esperando: "Sigue abierto pero lleva entre 90 s y 15 min sin escribir. El techlead queda así mientras su equipo trabaja.",
  listo: "Terminó su parte.",
  "en cola": "Todavía no lo lanzan en este slot.",
  "sin señal": "Lleva más de 15 min sin escribir: probablemente la sesión se cortó.",
}

export function MemberCard({ m, detailed = false }: { m: Member; detailed?: boolean }) {
  const t = memberTone[m.status]
  const action = m.lastAction ? `${m.lastAction.tool} ${m.lastAction.detail}` : m.status === "en cola" ? "todavía no parte" : ""
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5 rounded-md border bg-inset px-2.5 py-2", t.card)}>
      <div className="flex items-center gap-2">
        <span className={cn("grid size-6 flex-none place-items-center rounded-md text-[10px] font-semibold", t.chip, t.pulse && "cc-pulse")}>
          {ROLE_ABBR[m.role] ?? m.role.slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-medium">{m.role}</div>
          <div className="truncate font-mono text-[10.5px] text-muted-foreground">{m.model ? `${m.model}${m.effort ? ` · ${m.effort}` : ""}` : "—"}</div>
        </div>
        <Pill className={t.chip} hint={MEMBER_HINT[m.status]}>
          {m.status}
        </Pill>
      </div>
      <div title={action} className="truncate font-mono text-[11px] text-foreground/75">
        {action || " "}
      </div>
      <div className="flex justify-between gap-2 text-[11px] text-muted-foreground tabular-nums">
        <Ago iso={m.lastActivity} />
        {detailed ? (
          <span>
            {m.runs > 1 ? `${m.runs} corridas · ` : ""}
            {usd(m.usd)}
          </span>
        ) : null}
      </div>
    </div>
  )
}

// Fila de métricas en un solo bloque, en vez de cinco tarjetas sueltas.
export function StatBar({ items }: { items: { label: string; value: string; sub?: string; tone?: string }[] }) {
  return (
    <section aria-label="Métricas" className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] overflow-hidden rounded-lg border bg-card">
      {items.map((k, i) => (
        <div key={k.label} className={cn("flex min-w-0 flex-col gap-0.5 px-4 py-3", i > 0 && "border-l")}>
          <span className="truncate text-xs text-muted-foreground">{k.label}</span>
          <span className={cn("text-lg leading-tight font-semibold tabular-nums", k.tone)}>{k.value}</span>
          {k.sub ? <span className="truncate text-[11.5px] text-muted-foreground">{k.sub}</span> : null}
        </div>
      ))}
    </section>
  )
}
