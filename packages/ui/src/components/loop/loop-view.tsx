import { ArchiveRestore } from "lucide-react"
import type { Loop } from "@/types"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { isRunning, useAppActions } from "@/lib/app-context"
import { loopTone, usd } from "@/lib/format"
import { cn } from "@/lib/utils"
import { Ago, Hint, Pill, SectionTitle, StatBar } from "../common"
import { AgentControls, agentLabel } from "./agent-controls"
import { Attention } from "./attention"
import { Feed } from "./feed"
import { IssueList } from "./issue-list"
import { SlotCard } from "./slot-card"
import { SummaryView } from "./summary-view"

export type LoopTab = "operacion" | "resumen"

interface Props {
  loop: Loop
  tab: LoopTab
  onTabChange: (tab: LoopTab) => void
  onOpenIssue: (issueId: string) => void
}

function Banner({ tone, children, action }: { tone: "amber" | "neutral"; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div
      role="status"
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5 text-[12.5px]",
        tone === "amber" ? "border-amber-500/30 bg-amber-500/8 text-amber-900 dark:text-amber-200" : "bg-muted/50",
      )}
    >
      <span>{children}</span>
      {action}
    </div>
  )
}

export function LoopView({ loop, tab, onTabChange, onOpenIssue }: Props) {
  const actions = useAppActions()
  const running = isRunning(loop)
  const team = loop.slots.flatMap((s) => s.team)
  const working = team.filter((m) => m.status === "trabajando").length
  const waiting = team.filter((m) => m.status === "esperando").length
  const open = loop.history.filter((h) => h.column === "abierto" || h.column === "aprobado").length
  const pending = loop.decisions.filter((d) => d.pending).length
  const stale = loop.slots.some((s) => s.team.some((m) => m.status === "sin señal"))
  const label = agentLabel(loop)
  const blocked = loop.agent?.kind === "background" && loop.agent.state === "blocked"

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className={cn("size-2 rounded-full", loopTone[loop.status].dot)} />
              <span>{loopTone[loop.status].label}</span>
              {label ? (
                <Pill className={label.tone} hint={label.hint}>
                  {label.text}
                </Pill>
              ) : null}
              {loop.permissionMode === "bypassPermissions" ? (
                <Pill className="ring-1 ring-border" hint="El EM corre con --dangerously-skip-permissions: no te pide permisos para usar herramientas. Los hooks de clanker-loop igual bloquean lo prohibido">
                  sin permisos
                </Pill>
              ) : null}
              {loop.lastActivity ? (
                <span>
                  · última actividad <Ago iso={loop.lastActivity} />
                </span>
              ) : null}
            </div>
            <h1 className="mt-1 truncate text-xl font-semibold tracking-tight">{loop.title}</h1>
            {loop.repos ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{loop.repos}</p> : null}
          </div>
          <AgentControls loop={loop} />
        </div>
        <Tabs value={tab} onValueChange={(v) => onTabChange(v as LoopTab)}>
          <TabsList variant="line" className="h-8">
            <Hint label="Operación" keys="⇧⌘1">
              <TabsTrigger value="operacion" className="px-2.5 text-[13px]">
                Operación
              </TabsTrigger>
            </Hint>
            <Hint label="Resumen" keys="⇧⌘2">
              <TabsTrigger value="resumen" className="px-2.5 text-[13px]">
                Resumen
              </TabsTrigger>
            </Hint>
          </TabsList>
        </Tabs>
      </header>

      {loop.archived ? (
        <Banner
          tone="neutral"
          action={
            <Button size="sm" variant="outline" onClick={() => actions.setArchived(loop, false)}>
              <ArchiveRestore /> Desarchivar
            </Button>
          }
        >
          Archivado: no aparece en la barra lateral{running ? " (ahora sí, porque está corriendo)" : ""}. El state y las sesiones siguen intactos.
        </Banner>
      ) : null}

      {blocked ? <Banner tone="amber">El EM está detenido esperando tu respuesta, quizás una pregunta o un permiso.</Banner> : null}

      {stale && !running ? <Banner tone="amber">Hay slots en curso pero nadie escribe hace rato: la sesión se cortó. "Reanudar" los retoma.</Banner> : null}

      {tab === "resumen" ? (
        <SummaryView slug={loop.slug} onOpenIssue={onOpenIssue} />
      ) : (
        <>
          <StatBar
            items={[
              { label: "Agentes trabajando", value: String(working), sub: `${waiting} esperando`, tone: working ? "text-violet-600 dark:text-violet-400" : "" },
              { label: "Slots en curso", value: String(loop.slots.length), sub: loop.queueItems?.[0] ? `siguiente: ${loop.queueItems[0].id}` : "cola sin datos" },
              { label: "PRs abiertos", value: String(open), sub: `${loop.history.filter((h) => h.column === "aprobado").length} aprobados` },
              { label: "Decisiones a revisar", value: String(loop.decisions.length), sub: `${pending} pendientes`, tone: pending ? "text-amber-600 dark:text-amber-400" : "" },
              { label: "Gasto de hoy", value: usd(loop.todayUsd), sub: `${loop.todayIssues} issues cerradas hoy` },
            ]}
          />

          <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
            <div className="flex min-w-0 flex-col gap-5">
              <section className="flex flex-col gap-2">
                <SectionTitle count={loop.slots.length} aside="un techlead por slot, con su equipo">
                  Slots en curso
                </SectionTitle>
                {loop.slots.length ? (
                  loop.slots.map((s) => <SlotCard key={s.issueId} slot={s} onOpen={() => onOpenIssue(s.issueId)} />)
                ) : (
                  <p className="rounded-lg border border-dashed px-3.5 py-3 text-[12.5px] text-muted-foreground">
                    Ningún techlead corriendo.{loop.queue ? ` Última cola: ${loop.queue.text}` : ""}
                  </p>
                )}
              </section>
              <IssueList loop={loop} onOpenIssue={onOpenIssue} />
            </div>
            <aside className="flex min-w-0 flex-col gap-5">
              <Attention loop={loop} onOpenIssue={onOpenIssue} />
              <Feed feed={loop.feed} />
            </aside>
          </div>
        </>
      )}
    </div>
  )
}
