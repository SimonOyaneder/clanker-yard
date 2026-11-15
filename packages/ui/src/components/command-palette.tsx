import type { CachedIssue, ClankerProject, Decision, DecisionId, QueueEntry, Run, RunId } from "@clanker/api"
import { BarChart3, Bot, CalendarRange, Check, CornerDownLeft, FileText, Filter, Gauge, GitPullRequest, History, Inbox, Keyboard, Layers, ListTree, MessageSquare, Network, Octagon, PanelLeft, Paperclip, Pause, Play, Plug, Plus, RefreshCw, Reply, RotateCcw, ScrollText, Square, Table2, Undo2, X } from "lucide-react"
import type { PullRequest } from "@/types"
import type { ProjectTab } from "@/components/project/project-view"
import type { RunTab } from "@/components/project/run-view"
import type { StepTab } from "@/components/project/step-panel"
import { KindIcon } from "@/components/inbox/decision-parts"
import { ParallelPage, QueueCommands } from "@/components/project/project-palette"
import { useRunCommands } from "@/components/project/run-commands"
import { RunStatusIcon, isLive } from "@/components/project/status"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command"
import { useState } from "react"
import type { SummaryControls } from "@/hooks/use-summary-controls"
import { useHost } from "@/host"
import { useAppActions } from "@/lib/app-context"
import { KIND_LABEL, optionLabel, optionsOf, takesText } from "@/lib/decisions"
import { issueKey } from "@/lib/format"
import { DEFAULT_RANGE, ORIGIN_LABELS, ORIGINS, RANGE_LABELS, RANGE_PRESETS } from "@/lib/summary"
import type { RunCaps } from "@/lib/run-commands"
import { barProjects } from "@/lib/projects"
import { cn } from "@/lib/utils"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: ClankerProject[]
  current: ClankerProject | null
  runs: Run[]
  issues: CachedIssue[]
  /** La cola del proyecto que se ve; `null` si la vista actual no es la del proyecto. */
  queue: QueueEntry[] | null
  onToggleSidebar: () => void
  onOpenShortcuts: () => void
  prs: PullRequest[]
  onGoPrs: () => void
  onGoInbox: () => void
  /** Las decisiones pendientes: ⏎ en una la abre en la bandeja. */
  pendingDecisions: Decision[]
  onOpenDecision: (id: DecisionId) => void
  /** Solo si hay una respuesta que todavía se puede deshacer. */
  onUndoDecision: (() => void) | null
  /** Solo en la bandeja, con una decisión pendiente a la vista: sus opciones son acciones de la paleta. */
  onDecision: { decision: Decision; onResolve: (decision: Decision, option: string) => void; onRespond: () => void } | null
  /** Con un proyecto a la vista: la pestaña actual y cómo cambiarla. */
  projectTab: { tab: ProjectTab; onTab: (tab: ProjectTab) => void } | null
  /** Solo con el Resumen a la vista: sus filtros y su vista son acciones de la paleta. */
  summary: SummaryControls | null
  /** Solo con una corrida abierta: cambia entre su grafo y su línea de tiempo. */
  onRunTab: ((tab: RunTab) => void) | null
  /** Solo con una corrida abierta: qué se le puede pedir en su estado. */
  runCaps: { id: RunId; caps: RunCaps } | null
  /** Solo con el panel de un paso abierto. */
  onStep: { onTab: (tab: StepTab) => void; onClose: () => void } | null
}

// ⌘K: ir a cualquier proyecto o corrida y correr cualquier acción sin tocar el mouse.
export function CommandPalette({ open, onOpenChange, projects, current, runs, issues, queue, onToggleSidebar, onOpenShortcuts, prs, onGoPrs, onGoInbox, pendingDecisions, onOpenDecision, onUndoDecision, onDecision, projectTab, summary, onRunTab, runCaps, onStep }: Props) {
  const actions = useAppActions()
  const commands = useRunCommands()
  const host = useHost()
  // Una acción con parámetro abre una sub-página dentro de la paleta (patrón de páginas de cmdk).
  const [parallelPage, setParallelPage] = useState(false)
  const close = (next: boolean) => {
    if (!next) setParallelPage(false)
    onOpenChange(next)
  }
  const run = (fn: () => void) => () => {
    close(false)
    fn()
  }

  const byId = new Map<string, CachedIssue>(issues.map((i) => [i.id, i]))
  const live = new Set(runs.filter((r) => isLive(r.status)).map((r) => r.subject.id))
  const runnable = current?.status === "active" ? issues.filter((i) => i.status === "todo" && !live.has(i.id)) : []
  const ordered = [...barProjects(projects), ...projects.filter((p) => p.status === "archived")]

  if (parallelPage && current) return <ParallelPage open={open} onOpenChange={close} project={current} onBack={() => setParallelPage(false)} />

  return (
    <CommandDialog open={open} onOpenChange={close} title="Paleta de comandos" description="Busca un proyecto, una corrida o una acción">
      <CommandInput placeholder="Busca un proyecto, una corrida o una acción…" />
      <CommandList className="max-h-[420px]">
        <CommandEmpty>Sin resultados.</CommandEmpty>

        {onDecision ? (
          <CommandGroup heading="Esta decisión">
            {optionsOf(onDecision.decision)
              .slice(0, 9)
              .map((option, i) => (
                <CommandItem key={option} value={`decisión opción ${optionLabel(onDecision.decision, option)}`} onSelect={run(() => onDecision.onResolve(onDecision.decision, option))}>
                  <Check /> {optionLabel(onDecision.decision, option)}
                  <CommandShortcut>{i + 1}</CommandShortcut>
                </CommandItem>
              ))}
            {takesText(onDecision.decision) ? (
              <CommandItem value="decisión responder con texto libre" onSelect={run(onDecision.onRespond)}>
                <Reply /> Responder…
                <CommandShortcut>R</CommandShortcut>
              </CommandItem>
            ) : null}
          </CommandGroup>
        ) : null}

        {onUndoDecision ? (
          <CommandGroup heading="Bandeja">
            <CommandItem value="deshacer la última respuesta de la bandeja" onSelect={run(onUndoDecision)}>
              <Undo2 /> Deshacer la última respuesta
              <CommandShortcut>Z</CommandShortcut>
            </CommandItem>
          </CommandGroup>
        ) : null}

        {onRunTab ? (
          <CommandGroup heading="Esta corrida">
            <CommandItem onSelect={run(() => onRunTab("graph"))}>
              <Network /> Ver el grafo del flujo
              <CommandShortcut>G</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={run(() => onRunTab("timeline"))}>
              <ListTree /> Ver la línea de tiempo
              <CommandShortcut>L</CommandShortcut>
            </CommandItem>
            {runCaps?.caps.failedStep ? (
              <CommandItem onSelect={run(() => commands.retry(runCaps.caps.failedStep!.id, runCaps.caps.failedStep!.nodeId))}>
                <RotateCcw /> Reintentar el paso fallido
                <CommandShortcut>⇧⌘R</CommandShortcut>
              </CommandItem>
            ) : null}
            {runCaps?.caps.pause ? (
              <CommandItem onSelect={run(() => commands.pause(runCaps.id))}>
                <Pause /> Pausar la corrida
                <CommandShortcut>⇧⌘.</CommandShortcut>
              </CommandItem>
            ) : null}
            {runCaps?.caps.resume ? (
              <CommandItem onSelect={run(() => commands.resume(runCaps.id))}>
                <Play /> Retomar la corrida
                <CommandShortcut>⇧⌘.</CommandShortcut>
              </CommandItem>
            ) : null}
            {runCaps?.caps.interrupt ? (
              <CommandItem onSelect={run(() => commands.interrupt(runCaps.id))}>
                <Square /> Interrumpir al agente en curso
                <CommandShortcut>⌘.</CommandShortcut>
              </CommandItem>
            ) : null}
            {runCaps?.caps.cancel ? (
              <CommandItem onSelect={run(() => commands.cancel(runCaps.id))}>
                <Octagon /> Cancelar la corrida
                <CommandShortcut>⇧⌘⌫</CommandShortcut>
              </CommandItem>
            ) : null}
          </CommandGroup>
        ) : null}

        {projectTab && current ? (
          <CommandGroup heading="Ir a">
            <CommandItem value="ir a operación del proyecto" onSelect={run(() => projectTab.onTab("operation"))}>
              <Layers /> Operación de {current.name}
              <CommandShortcut>⇧⌘1</CommandShortcut>
            </CommandItem>
            <CommandItem value="ir a resumen del proyecto gasto" onSelect={run(() => projectTab.onTab("summary"))}>
              <BarChart3 /> Resumen de {current.name}
              <CommandShortcut>⇧⌘2</CommandShortcut>
            </CommandItem>
          </CommandGroup>
        ) : null}

        {summary ? (
          <CommandGroup heading="Resumen del proyecto">
            {RANGE_PRESETS.filter((p) => p !== "custom").map((p) => (
              <CommandItem key={p} value={`resumen rango ${RANGE_LABELS[p]}`} onSelect={run(() => summary.setRange({ ...DEFAULT_RANGE, preset: p }))}>
                <CalendarRange /> Rango: {RANGE_LABELS[p].toLowerCase()}
                {p === summary.range.preset ? <CommandShortcut>actual</CommandShortcut> : null}
              </CommandItem>
            ))}
            {ORIGINS.map((o) => (
              <CommandItem key={o} value={`resumen origen ${ORIGIN_LABELS[o]}`} onSelect={run(() => summary.setOrigin(o))}>
                <Filter /> Origen: {ORIGIN_LABELS[o].toLowerCase()}
                {o === summary.origin ? <CommandShortcut>actual</CommandShortcut> : null}
              </CommandItem>
            ))}
            <CommandItem value="resumen ver tablas gráficos" onSelect={run(summary.toggleTables)}>
              <Table2 /> {summary.asTables ? "Ver los gráficos" : "Ver los datos como tablas"}
              <CommandShortcut>T</CommandShortcut>
            </CommandItem>
          </CommandGroup>
        ) : null}

        {current && !onRunTab && current.status !== "archived" ? (
          <CommandGroup heading="Este proyecto">
            <CommandItem onSelect={run(() => (current.status === "active" ? commands.pauseProject(current) : commands.resumeProject(current)))}>
              {current.status === "active" ? <Pause /> : <Play />} {current.status === "active" ? "Pausar el proyecto" : "Reanudar el proyecto"}
              <CommandShortcut>⇧⌘Y</CommandShortcut>
            </CommandItem>
            {queue ? (
              <CommandItem value="cambiar paralelismo" onSelect={() => setParallelPage(true)}>
                <Gauge /> Cambiar paralelismo
                <CommandShortcut>›</CommandShortcut>
              </CommandItem>
            ) : null}
          </CommandGroup>
        ) : null}

        {current && queue ? <QueueCommands project={current} queue={queue} run={run} /> : null}

        {onStep ? (
          <CommandGroup heading="Panel del paso">
            <CommandItem onSelect={run(() => onStep.onTab("transcript"))}>
              <MessageSquare /> Ver el transcript o el comando
              <CommandShortcut>T</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={run(() => onStep.onTab("brief"))}>
              <ScrollText /> Ver el brief que recibió
              <CommandShortcut>B</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={run(() => onStep.onTab("report"))}>
              <FileText /> Ver el reporte
              <CommandShortcut>R</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={run(() => onStep.onTab("artifacts"))}>
              <Paperclip /> Ver los artefactos
              <CommandShortcut>A</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={run(() => onStep.onTab("attempts"))}>
              <History /> Ver los intentos
              <CommandShortcut>I</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={run(onStep.onClose)}>
              <X /> Cerrar el panel del paso
              <CommandShortcut>⎋</CommandShortcut>
            </CommandItem>
          </CommandGroup>
        ) : null}

        {current && runnable.length ? (
          <CommandGroup heading={`Correr en ${current.name}`}>
            {runnable.map((i) => (
              <CommandItem key={i.id} value={`correr ${issueKey(i)} ${i.title}`} onSelect={run(() => void actions.startRun(current, i))}>
                <Play />
                <span className="w-[68px] flex-none truncate font-mono text-[11.5px] text-muted-foreground">{issueKey(i)}</span>
                <span className="truncate">{i.title}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}

        <CommandSeparator />
        <CommandGroup heading="Proyectos">
          {ordered.map((p, i) => (
            <CommandItem key={p.id} value={`proyecto ${p.name} ${p.slug}`} onSelect={run(() => actions.selectProject(p.slug))}>
              <span className={cn("ml-0.5 size-2 rounded-full", p.status === "active" ? "bg-emerald-500" : "bg-muted-foreground/50")} />
              <span className="truncate">{p.name}</span>
              <span className="text-xs text-muted-foreground">{p.status === "active" ? "" : p.status === "paused" ? "pausado" : "archivado"}</span>
              {i < 9 && p.status !== "archived" ? <CommandShortcut>⌘{i + 1}</CommandShortcut> : null}
            </CommandItem>
          ))}
        </CommandGroup>

        {runs.length && current ? (
          <>
            <CommandSeparator />
            <CommandGroup heading={`Corridas de ${current.name}`}>
              {runs.map((r) => {
                const issue = byId.get(r.subject.id)
                return (
                  <CommandItem key={r.id} value={`corrida ${issue ? issueKey(issue) : ""} ${issue?.title ?? ""} ${r.id}`} onSelect={run(() => actions.openRun(current.slug, r.id))}>
                    <RunStatusIcon run={r} />
                    <span className="w-[68px] flex-none truncate font-mono text-[11.5px] text-muted-foreground">{issue ? issueKey(issue) : r.subject.id}</span>
                    <span className="truncate">{issue?.title ?? "issue fuera del caché"}</span>
                    <span className="ml-auto flex-none font-mono text-[11px] text-muted-foreground">
                      {r.flow.slug} v{r.flow.version}
                    </span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </>
        ) : null}

        {pendingDecisions.length ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Decisiones">
              {pendingDecisions.map((d) => (
                <CommandItem key={d.id} value={`decisión ${KIND_LABEL[d.kind]} ${d.title} ${d.id}`} onSelect={run(() => onOpenDecision(d.id))}>
                  <KindIcon kind={d.kind} />
                  <span className="truncate">{d.title}</span>
                  <CommandShortcut>
                    <CornerDownLeft className="size-3" />
                  </CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        {prs.length ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="PRs abiertos">
              {prs.map((p) => (
                <CommandItem key={p.id} value={`pr ${p.repoName} ${p.number} ${p.title} ${p.headRef}`} onSelect={run(() => host.openExternal(p.url))}>
                  <GitPullRequest />
                  <span className="w-[92px] flex-none truncate font-mono text-[11.5px] text-muted-foreground">
                    {p.repoName}#{p.number}
                  </span>
                  <span className="truncate">{p.title}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        <CommandSeparator />
        <CommandGroup heading="App">
          <CommandItem onSelect={run(onGoInbox)}>
            <Inbox /> Ir a la Bandeja
            <CommandShortcut>⇧⌘I</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={run(onGoPrs)}>
            <GitPullRequest /> Ir a Stacks de PR
            <CommandShortcut>⇧⌘P</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={run(actions.goConnections)}>
            <Plug /> Ir a Conexiones
            <CommandShortcut>G C</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={run(actions.connectLinear)}>
            <Layers /> Conectar con Linear
            <CommandShortcut>⇧⌘L</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={run(() => void actions.testClaude())}>
            <Bot /> Probar Claude
            <CommandShortcut>⇧⌘T</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={run(actions.openNewProject)}>
            <Plus /> Nuevo proyecto
            <CommandShortcut>⌘N</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={run(actions.refresh)}>
            <RefreshCw /> Actualizar
            <CommandShortcut>⌘R</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={run(onToggleSidebar)}>
            <PanelLeft /> Mostrar u ocultar barra lateral
            <CommandShortcut>⌘B</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={run(onOpenShortcuts)}>
            <Keyboard /> Atajos de teclado
            <CommandShortcut>⌘/</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
