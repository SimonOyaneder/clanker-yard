import type { Breaker, CachedIssue, ClankerProject, Decision, DecisionId, DecisionKind } from "@clanker/api"
import { Copy, Inbox as InboxIcon } from "lucide-react"
import { useEffect, useEffectEvent, useMemo } from "react"
import { useAppData } from "@/app-data"
import { Ago, Pill } from "@/components/common"
import { type DecisionScope, KindIcon } from "@/components/inbox/decision-parts"
import { DecisionItem } from "@/components/inbox/decision-item"
import { RETRY_BREAKERS_KEYS } from "@/components/project/breaker-strip"
import { Button } from "@/components/ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from "@/components/ui/context-menu"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useLiveQuery } from "@/hooks/use-live"
import type { Inbox } from "@/hooks/use-inbox"
import { useAppActions } from "@/lib/app-context"
import { copy } from "@/lib/clipboard"
import { ACTIONABLE_KINDS, KIND_LABEL, optionLabel, optionsOf, parksRun, resolutionText, resolvedToday, takesText } from "@/lib/decisions"
import { tone } from "@/lib/format"
import { cn } from "@/lib/utils"
import { isTypingTarget, overlayOpen } from "@/lib/keys"

const ALL = "all"

interface Props {
  inbox: Inbox
  /** Todas las decisiones que lee el core, resueltas incluidas: de ahí sale cuántas se resolvieron hoy. */
  decisions: Decision[]
  projects: ClankerProject[]
  onSelect: (id: DecisionId) => void
  onResolve: (decision: Decision, option: string) => void
}


// La bandeja de decisiones (`docs/design.html#d-ui`): lista a la izquierda, la decisión a la derecha. Ninguna
// decisión detiene el loop; las que estacionan una corrida van primero.
export function InboxView({ inbox, decisions, projects, onSelect, onResolve }: Props) {
  const appData = useAppData()
  const actions = useAppActions()
  const { items, current, tab } = inbox

  // Las issues de los proyectos con decisiones, para nombrar la corrida de cada una.
  const projectIds = [...new Set(decisions.flatMap((d) => (d.projectId ? [d.projectId] : [])))].sort()
  const issueData = useLiveQuery(`inbox-issues:${projectIds.join(",")}`, async () => (await Promise.all(projectIds.map((id) => appData.issues(id)))).flat())
  const issues = useMemo(() => new Map<string, CachedIssue>((issueData.data ?? []).map((i) => [i.id, i])), [issueData.data])
  const scopeOf = (d: Decision): DecisionScope => ({
    project: projects.find((p) => p.id === d.projectId),
    issue: d.subject?.type === "issue" ? issues.get(d.subject.id) : undefined,
  })
  // Las alertas que deja un breaker se pueden reintentar mientras siga abierto.
  const breakers = useLiveQuery("inbox-breakers", () => appData.breakers())
  const breakerOf = (d: Decision): Breaker | undefined => (d.kind === "alert" && d.status === "pending" ? breakers.data?.find((b) => b.decisionId === d.id) : undefined)
  const openRunOf = (d: Decision) => {
    const slug = projects.find((p) => p.id === d.projectId)?.slug
    return slug && d.runId ? () => actions.openRun(slug, d.runId!) : null
  }

  // J y K, 1 a 9, R y ⏎. Z (deshacer) vive en la app: el aviso sigue ahí aunque cambies de vista.
  const onKey = useEffectEvent((e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat || isTypingTarget(e.target)) return
      if (overlayOpen()) return
      const at = current ? items.findIndex((d) => d.id === current.id) : -1
      const key = e.key.toLowerCase()
      if (key === "j" || key === "k") {
        const next = items[key === "j" ? Math.min(at + 1, items.length - 1) : Math.max(at - 1, 0)]
        if (next) onSelect(next.id)
      } else if (current?.status === "pending" && /^[1-9]$/.test(key)) {
        const option = optionsOf(current)[Number(key) - 1]
        if (option !== undefined) onResolve(current, option)
      } else if (current && takesText(current) && key === "r") {
        e.preventDefault()
        inbox.setResponding(true)
      } else if (key === "enter" && current) {
        // ⏎ sobre un botón (una opción, una pestaña) hace su trabajo; sobre la lista o la página abre la corrida.
        const onButton = (e.target as HTMLElement | null)?.closest("button, a") && !(e.target as HTMLElement).closest("[data-inbox-list]")
        const open = openRunOf(current)
        if (!onButton && open) {
          e.preventDefault()
          open()
        }
      }
  })
  useEffect(() => {
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // La decisión a la vista se mantiene visible al moverse con J y K.
  useEffect(() => {
    document.querySelector(`[data-decision="${current?.id}"]`)?.scrollIntoView?.({ block: "nearest" })
  }, [current?.id])

  const pendingCount = inbox.pending.length
  const resolved = resolvedToday(decisions, Date.now())

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-none flex-wrap items-center gap-3 border-b px-4 py-2">
        <Tabs value={tab} onValueChange={(v) => inbox.setTab(v === "resolved" ? "resolved" : "pending")} className="gap-0">
          <TabsList>
            <TabsTrigger value="pending">
              Pendientes <span className="text-xs tabular-nums opacity-70">{pendingCount}</span>
            </TabsTrigger>
            <TabsTrigger value="resolved">Resueltas</TabsTrigger>
          </TabsList>
        </Tabs>
        <Select value={inbox.projectId ?? ALL} onValueChange={(v) => inbox.setProjectId(v === ALL ? null : (v as ClankerProject["id"]))}>
          <SelectTrigger size="sm" aria-label="Filtrar por proyecto">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todos los proyectos</SelectItem>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={inbox.kind ?? ALL} onValueChange={(v) => inbox.setKind(v === ALL ? null : (v as DecisionKind))}>
          <SelectTrigger size="sm" aria-label="Filtrar por tipo">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todos los tipos</SelectItem>
            {ACTIONABLE_KINDS.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {KIND_LABEL[kind]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {inbox.filtered ? (
          <Button size="sm" variant="ghost" onClick={inbox.clearFilters}>
            Quitar filtros
          </Button>
        ) : null}
      </div>

      {items.length === 0 ? (
        <Empty inbox={inbox} resolvedToday={resolved} />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,380px)_minmax(0,1fr)]">
          <ul aria-label={tab === "pending" ? "Decisiones pendientes" : "Decisiones resueltas"} data-inbox-list className="min-h-0 divide-y overflow-y-auto border-r">
            {items.map((d) => (
              <Row key={d.id} decision={d} scope={scopeOf(d)} selected={d.id === current?.id} onSelect={() => onSelect(d.id)} onResolve={(option) => onResolve(d, option)} onOpenRun={openRunOf(d)} breaker={breakerOf(d)} onRespond={() => {
                  onSelect(d.id)
                  inbox.setResponding(true, d.id)
                }} />
            ))}
          </ul>
          <section aria-label="Decisión" className="min-h-0 overflow-y-auto px-6 py-5">
            {current ? (
              <DecisionItem
                key={current.id}
                decision={current}
                scope={scopeOf(current)}
                responding={inbox.responding}
                onRespondingChange={inbox.setResponding}
                onResolve={(option) => onResolve(current, option)}
                onOpenRun={openRunOf(current)}
                onGoConnections={actions.goConnections}
                breaker={breakerOf(current)}
              />
            ) : null}
          </section>
        </div>
      )}
    </div>
  )
}

function Row({
  decision,
  scope,
  selected,
  onSelect,
  onResolve,
  onOpenRun,
  onRespond,
  breaker,
}: {
  decision: Decision
  scope: DecisionScope
  selected: boolean
  onSelect: () => void
  onResolve: (option: string) => void
  onOpenRun: (() => void) | null
  onRespond: () => void
  breaker?: Breaker
}) {
  const actions = useAppActions()
  const pending = decision.status === "pending"
  const answer = pending ? null : resolutionText(decision)
  return (
    <li data-decision={decision.id}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            aria-current={selected ? "true" : undefined}
            onClick={onSelect}
            className={cn("flex w-full flex-col gap-1 px-4 py-2.5 text-left outline-none hover:bg-muted/50 focus-visible:bg-muted/50", selected && "bg-muted/60")}
          >
            <span className="flex items-center gap-2">
              <KindIcon kind={decision.kind} className={cn(pending && "opacity-100", !pending && "opacity-50")} />
              <span className={cn("min-w-0 flex-1 truncate text-[13px]", pending ? "font-medium" : "text-muted-foreground")}>{decision.title}</span>
            </span>
            <span className="flex items-center gap-1.5 pl-[22px] text-xs text-muted-foreground">
              {parksRun(decision) ? (
                <Pill className={tone.amber} hint="Esta decisión tiene estacionada su corrida: no ocupa cupo y nada más espera.">
                  estaciona
                </Pill>
              ) : null}
              <span className="min-w-0 truncate">{answer ?? scope.project?.name ?? "Sin proyecto"}</span>
              <span>·</span>
              <Ago at={decision.resolvedAt ?? decision.createdAt} className="flex-none" />
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-60">
          {pending
            ? optionsOf(decision)
                .slice(0, 9)
                .map((option, i) => (
                  <ContextMenuItem key={option} onSelect={() => onResolve(option)}>
                    {optionLabel(decision, option)}
                    <ContextMenuShortcut>{i + 1}</ContextMenuShortcut>
                  </ContextMenuItem>
                ))
            : null}
          {takesText(decision) ? (
            <ContextMenuItem onSelect={onRespond}>
              Responder…
              <ContextMenuShortcut>R</ContextMenuShortcut>
            </ContextMenuItem>
          ) : null}
          {breaker ? (
            <ContextMenuItem onSelect={() => void actions.retryBreakers(null, breaker.scope)}>
              Reintentar ahora
              <ContextMenuShortcut>{RETRY_BREAKERS_KEYS}</ContextMenuShortcut>
            </ContextMenuItem>
          ) : null}
          {pending && (optionsOf(decision).length > 0 || takesText(decision) || breaker) ? <ContextMenuSeparator /> : null}
          {onOpenRun ? (
            <ContextMenuItem onSelect={onOpenRun}>
              Abrir corrida
              <ContextMenuShortcut>⏎</ContextMenuShortcut>
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem onSelect={() => copy(decision.id, "el ID de la decisión")}>
            <Copy /> Copiar ID
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  )
}

// Un estado vacío que dice qué hacer, no solo que no hay nada.
function Empty({ inbox, resolvedToday: resolved }: { inbox: Inbox; resolvedToday: number }) {
  if (inbox.filtered) {
    return (
      <EmptyBlock title="Ninguna decisión coincide con los filtros">
        <Button size="sm" variant="secondary" onClick={inbox.clearFilters}>
          Quitar filtros
        </Button>
      </EmptyBlock>
    )
  }
  if (inbox.tab === "resolved") {
    return <EmptyBlock title="Todavía no resolviste ninguna decisión">Las que respondas aparecen aquí, con lo que elegiste.</EmptyBlock>
  }
  return (
    <EmptyBlock title="No hay nada esperando tu decisión.">
      {resolved ? `Hoy resolviste ${resolved} decisión${resolved === 1 ? "" : "es"}. ` : ""}
      Las notas de los agentes están en cada corrida y en su PR.
      <Button size="sm" variant="secondary" className="mt-1" onClick={() => inbox.setTab("resolved")}>
        Ver las resueltas
      </Button>
    </EmptyBlock>
  )
}

function EmptyBlock({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mx-auto mt-24 flex max-w-sm flex-col items-center gap-2 px-4 text-center">
      <InboxIcon className="size-6 text-muted-foreground" />
      <h2 className="text-base font-semibold">{title}</h2>
      {children ? <div className="flex flex-col items-center gap-2 text-muted-foreground">{children}</div> : null}
    </div>
  )
}
