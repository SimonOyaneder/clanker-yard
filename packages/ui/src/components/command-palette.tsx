import type { CachedIssue, ClankerProject, Decision, QueueEntry, Run, RunId } from "@clanker/api"
import { BarChart3, BookCheck, Bot, CalendarRange, Check, CornerDownLeft, FileText, Filter, Gauge, GitMerge, GitPullRequest, GitPullRequestArrow, History, Inbox, Keyboard, Layers, ListTodo, ListTree, MessageSquare, Network, Octagon, PanelLeft, Pencil, Paperclip, Pause, PauseCircle, Play, Plug, Plus, RefreshCw, Reply, RotateCcw, Save, ScrollText, Settings2, Square, SquareCheck, Table2, Undo2, X } from "lucide-react"
import type { ProjectTab } from "@/components/project/project-view"
import type { OpenPr } from "@/lib/prs"
import { repoNameOf } from "@/lib/prs"
import { whyNotMerge } from "@/lib/pr-commands"
import { usePrCommands } from "@/components/prs/pr-commands"
import { PR_KEYS } from "@/components/prs/pr-menu"
import type { RunTab } from "@/components/project/run-view"
import type { StepTab } from "@/components/project/step-panel"
import { KindIcon } from "@/components/inbox/decision-parts"
import { LanesPage, ParallelPage, QueueCommands } from "@/components/project/project-palette"
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
import type { SettingsControls } from "@/components/project/settings-view"
import type { LearningsView } from "@/hooks/use-learnings-view"
import type { SummaryControls } from "@/hooks/use-summary-controls"
import { useHost } from "@/host"
import { useAppActions } from "@/lib/app-context"
import { KIND_LABEL, optionLabel, optionsOf, takesText } from "@/lib/decisions"
import { issueKey } from "@/lib/format"
import { approveLabel, capsOf, rejectLabel, SOURCE_LABEL, SOURCES, STATUS_LABEL, STATUSES } from "@/lib/learnings"
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
  prs: OpenPr[]
  /** Solo en Stacks de PR: las acciones del PR enfocado son acciones de la paleta. */
  prsActive: boolean
  /** Solo en Learnings: lo que se puede hacer con lo marcado o con el learning a la vista, y deshacer si hay algo que deshacer. */
  learnings: { view: LearningsView; onUndo: (() => void) | null } | null
  /** Las decisiones pendientes: ⏎ en una la abre en la bandeja. */
  pendingDecisions: Decision[]
  /** Solo si hay una respuesta que todavía se puede deshacer. */
  onUndoDecision: (() => void) | null
  /** Solo en la bandeja, con una decisión pendiente a la vista: sus opciones son acciones de la paleta. */
  onDecision: { decision: Decision; onResolve: (decision: Decision, option: string) => void; onRespond: () => void } | null
  /** Con un proyecto a la vista: la pestaña actual y cómo cambiarla. */
  projectTab: { tab: ProjectTab; onTab: (tab: ProjectTab) => void } | null
  /** Solo con Ajustes a la vista: guardar o descartar lo editado. */
  settings: SettingsControls | null
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
export function CommandPalette({ open, onOpenChange, projects, current, runs, issues, queue, prs, prsActive, learnings, pendingDecisions, onUndoDecision, onDecision, projectTab, settings, summary, onRunTab, runCaps, onStep }: Props) {
  const actions = useAppActions()
  const commands = useRunCommands()
  const prCommands = usePrCommands()
  const selectedPr = prsActive ? prCommands.selected : null
  const prCaps = selectedPr ? prCommands.caps(selectedPr) : null
  const host = useHost()
  // Una acción con parámetro abre una sub-página dentro de la paleta (patrón de páginas de cmdk).
  const [parallelPage, setParallelPage] = useState(false)
  const [lanesPage, setLanesPage] = useState(false)
  const close = (next: boolean) => {
    if (!next) {
      setParallelPage(false)
      setLanesPage(false)
    }
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

  if (lanesPage) return <LanesPage open={open} onOpenChange={close} onBack={() => setLanesPage(false)} />
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

        {selectedPr && prCaps ? (
          <CommandGroup heading={`Este PR · ${selectedPr.state.key}`}>
            {prCaps.merge ? (
              <CommandItem value="pr mergear según la estrategia" onSelect={run(() => prCommands.merge(selectedPr))}>
                <GitMerge /> {prCaps.merge === "button" ? "Mergear en GitHub" : "Mergear…"}
                <CommandShortcut>{PR_KEYS.merge}</CommandShortcut>
              </CommandItem>
            ) : (
              <CommandItem value="pr mergear no disponible" disabled>
                <GitMerge /> Mergear: {whyNotMerge(selectedPr)}
              </CommandItem>
            )}
            {prCaps.requestReview ? (
              <CommandItem value="pr pedir review del bot" onSelect={run(() => prCommands.requestReview(selectedPr))}>
                <Bot /> Pedir review del bot
                <CommandShortcut>{PR_KEYS.requestReview}</CommandShortcut>
              </CommandItem>
            ) : null}
            {prCaps.rebase ? (
              <CommandItem value="pr rebasear" onSelect={run(() => prCommands.rebase(selectedPr))}>
                <GitPullRequestArrow /> Rebasear
                <CommandShortcut>{PR_KEYS.rebase}</CommandShortcut>
              </CommandItem>
            ) : null}
            <CommandItem value="pr hold no mergear nunca" onSelect={run(() => prCommands.toggleHold(selectedPr))}>
              <PauseCircle /> {selectedPr.state.hold ? "Quitar hold" : "Marcar hold (no mergear nunca)"}
              <CommandShortcut>{PR_KEYS.hold}</CommandShortcut>
            </CommandItem>
            {prCaps.run ? (
              <CommandItem value="pr ver corrida" onSelect={run(() => prCommands.openRun(selectedPr))}>
                <ScrollText /> Ver la corrida que lo abrió
                <CommandShortcut>{PR_KEYS.run}</CommandShortcut>
              </CommandItem>
            ) : null}
          </CommandGroup>
        ) : null}

        {learnings ? <LearningsCommands {...learnings} run={run} /> : null}

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
            <CommandItem value="ir a ajustes del proyecto repos filtros convenciones parámetros" onSelect={run(() => projectTab.onTab("settings"))}>
              <Settings2 /> Ajustes de {current.name}
              <CommandShortcut>⇧⌘3</CommandShortcut>
            </CommandItem>
            <CommandItem value="editar filtros de la cola del proyecto" onSelect={run(actions.editQueueFilters)}>
              <Filter /> Filtros de la cola de {current.name}
            </CommandItem>
            {current.tracker === "linear" ? (
              <CommandItem value="elegir proyecto de linear del tracker" onSelect={run(actions.editTrackerProject)}>
                <ListTodo /> Proyecto de Linear de {current.name}
              </CommandItem>
            ) : null}
          </CommandGroup>
        ) : null}

        {settings?.dirty ? (
          <CommandGroup heading="Ajustes del proyecto">
            <CommandItem value="guardar ajustes del proyecto cambios" disabled={settings.blocked} onSelect={run(settings.save)}>
              <Save /> {settings.blocked ? "Guardar los ajustes (corrige antes los campos marcados)" : "Guardar los ajustes"}
              <CommandShortcut>⌘S</CommandShortcut>
            </CommandItem>
            <CommandItem value="descartar cambios de los ajustes del proyecto" onSelect={run(settings.discard)}>
              <Undo2 /> Descartar los cambios sin guardar
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

        <CommandGroup heading="Máquina">
          <CommandItem value="cambiar capacidad de carriles" onSelect={() => setLanesPage(true)}>
            <Gauge /> Cambiar capacidad de carriles
            <CommandShortcut>›</CommandShortcut>
          </CommandItem>
        </CommandGroup>

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
                <CommandItem key={d.id} value={`decisión ${KIND_LABEL[d.kind]} ${d.title} ${d.id}`} onSelect={run(() => actions.openDecision(d.id))}>
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
                <CommandItem key={p.id} value={`pr ${repoNameOf(p)} ${p.ref.number} ${p.state.title} ${p.state.headRef}`} onSelect={run(() => host.openExternal(p.state.url))}>
                  <GitPullRequest />
                  <span className="w-[92px] flex-none truncate font-mono text-[11.5px] text-muted-foreground">
                    {repoNameOf(p)}#{p.ref.number}
                  </span>
                  <span className="truncate">{p.state.title}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        <CommandSeparator />
        <CommandGroup heading="App">
          <CommandItem onSelect={run(() => actions.goModule("inbox"))}>
            <Inbox /> Ir a la Bandeja
            <CommandShortcut>⇧⌘I</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={run(() => actions.goModule("learnings"))}>
            <BookCheck /> Ir a Learnings
            <CommandShortcut>⇧⌘A</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={run(() => actions.goModule("prs"))}>
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
          <CommandItem onSelect={run(actions.toggleSidebar)}>
            <PanelLeft /> Mostrar u ocultar barra lateral
            <CommandShortcut>⌘B</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={run(actions.openShortcuts)}>
            <Keyboard /> Atajos de teclado
            <CommandShortcut>⌘/</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}

// Las acciones de la vista de Learnings: actúan sobre lo marcado o, si no hay nada marcado, sobre el que está a la vista.
function LearningsCommands({ view, onUndo, run }: { view: LearningsView; onUndo: (() => void) | null; run: (fn: () => void) => () => void }) {
  const { targets, current, selected } = view
  const approvable = targets.filter((l) => capsOf(l).approve)
  const rejectable = targets.filter((l) => capsOf(l).reject)
  const count = (n: number) => (selected.length > 0 ? ` ${n}` : "")
  return (
    <CommandGroup heading={selected.length ? `${selected.length} learnings marcados` : "Este learning"}>
      {approvable.length ? (
        <CommandItem value="learning aprobar entra a los briefs" onSelect={run(() => view.act("approve"))}>
          <Check /> {approveLabel(approvable[0]!)}
          {count(approvable.length)}
          <CommandShortcut>A</CommandShortcut>
        </CommandItem>
      ) : null}
      {rejectable.length ? (
        <CommandItem value="learning rechazar retirar descartar" onSelect={run(() => view.act("reject"))}>
          <X /> {rejectLabel(rejectable[0]!)}
          {count(rejectable.length)}
          <CommandShortcut>R</CommandShortcut>
        </CommandItem>
      ) : null}
      {current ? (
        <CommandItem value="learning editar texto roles tags" onSelect={run(() => view.setEditing(true))}>
          <Pencil /> Editar el texto y los roles
          <CommandShortcut>E</CommandShortcut>
        </CommandItem>
      ) : null}
      {view.items.length > selected.length ? (
        <CommandItem value="learning marcar todos los que se ven selección en lote" onSelect={run(view.selectAll)}>
          <SquareCheck /> Marcar los {view.items.length} que se ven
          <CommandShortcut>⌘A</CommandShortcut>
        </CommandItem>
      ) : null}
      {selected.length ? (
        <CommandItem value="learning quitar la selección desmarcar" onSelect={run(view.clearSelection)}>
          <X /> Quitar la selección
          <CommandShortcut>⎋</CommandShortcut>
        </CommandItem>
      ) : null}
      {onUndo ? (
        <CommandItem value="learning deshacer la última decisión" onSelect={run(onUndo)}>
          <Undo2 /> Deshacer la última decisión
          <CommandShortcut>Z</CommandShortcut>
        </CommandItem>
      ) : null}
      {STATUSES.filter((status) => status !== view.tab).map((status) => (
        <CommandItem key={status} value={`learnings ver ${STATUS_LABEL[status]}`} onSelect={run(() => view.setTab(status))}>
          <BookCheck /> Ver {STATUS_LABEL[status].toLowerCase()}
          <CommandShortcut>{view.counts[status]}</CommandShortcut>
        </CommandItem>
      ))}
      {SOURCES.map((source) => (
        <CommandItem key={source} value={`learnings filtrar origen ${SOURCE_LABEL[source]}`} onSelect={run(() => view.setFilters({ source }))}>
          <Filter /> Origen: {SOURCE_LABEL[source].toLowerCase()}
          {view.filters.source === source ? <CommandShortcut>actual</CommandShortcut> : null}
        </CommandItem>
      ))}
      {view.filtered ? (
        <CommandItem value="learnings quitar filtros" onSelect={run(view.clearFilters)}>
          <Filter /> Quitar los filtros
        </CommandItem>
      ) : null}
    </CommandGroup>
  )
}
