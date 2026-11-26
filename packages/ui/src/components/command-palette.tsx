import type { CachedIssue, ClankerProject, Decision, QueueEntry, Run, RunId } from "@clanker/api"
import { BarChart3, BookCheck, Bot, CalendarRange, Check, CornerDownLeft, ExternalLink, FileText, Filter, Gauge, GitMerge, GitPullRequest, GitPullRequestArrow, History, Inbox, Keyboard, Layers, ListTodo, ListTree, MessageSquare, Network, Octagon, PanelLeft, Pencil, Paperclip, Pause, PauseCircle, Play, Plug, Plus, RefreshCw, Reply, RotateCcw, RotateCw, Save, ScrollText, Settings2, Square, SquareCheck, SquareTerminal, Table2, Undo2, Unplug, Upload, X, Eye, Rows2, Columns2, ChevronLeft, ChevronRight, GitCommitHorizontal } from "lucide-react"
import { PR_VIEW_KEYS, type PrControls } from "@/components/prs/pr-view"
import { CHAT_KEYS } from "@/hooks/use-pr-chat"
import type { ProjectTab } from "@/components/project/project-view"
import type { OpenPr } from "@/lib/prs/prs"
import { branchOf, keyOf, repoNameOf, titleOf } from "@/lib/prs/prs"
import { whyNotMerge } from "@/lib/prs/pr-commands"
import { usePrCommands } from "@/components/prs/pr-commands"
import { PR_KEYS } from "@/components/prs/pr-menu"
import type { RunTab } from "@/components/run/run-view"
import type { StepTab } from "@/components/run/step-panel"
import { KindIcon } from "@/components/inbox/decision-parts"
import { LanesPage, ParallelPage, QueueCommands } from "@/components/project/project-palette"
import { useRunCommands } from "@/components/run/run-commands"
import { RunStatusIcon } from "@/components/project/status"
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
import type { SettingsControls } from "@/components/project-settings/settings-view"
import type { LearningsView } from "@/hooks/use-learnings-view"
import type { SummaryControls } from "@/hooks/use-summary-controls"
import { useAppActions } from "@/lib/app-context"
import { KIND_LABEL, optionLabel, optionsOf, takesText } from "@/lib/decisions"
import { issueKey } from "@/lib/format"
import { approveLabel, capsOf, rejectLabel, SOURCE_LABEL, SOURCES, STATUS_LABEL, STATUSES } from "@/lib/learnings"
import { DEFAULT_RANGE, ORIGIN_LABELS, ORIGINS, RANGE_LABELS, RANGE_PRESETS } from "@/lib/summary"
import { RUN_KEYS, type RunCaps } from "@/lib/project/run-commands"
import { barProjects } from "@/lib/projects"
import { cn } from "@/lib/utils"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: ClankerProject[]
  current: ClankerProject | null
  runs: Run[]
  contextIssue?: CachedIssue | undefined
  issues: CachedIssue[]
  /** La cola del proyecto que se ve; `null` si la vista actual no es la del proyecto. */
  queue: QueueEntry[] | null
  prs: OpenPr[]
  /** Solo en Stacks de PR: las acciones del PR enfocado son acciones de la paleta. */
  prsActive: boolean
  pr?: PrControls | null
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
export function CommandPalette({ open, onOpenChange, projects, current, runs, issues, contextIssue, queue, prs, prsActive, pr = null, learnings, pendingDecisions, onUndoDecision, onDecision, projectTab, settings, summary, onRunTab, runCaps, onStep }: Props) {
  const actions = useAppActions()
  const commands = useRunCommands()
  const prCommands = usePrCommands()
  const selectedPr = prsActive ? prCommands.selected : null
  const prCaps = selectedPr ? prCommands.caps(selectedPr) : null
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
  // Solo las que la cola lanzaría: una issue que espera a sus padres correría sobre la branch por defecto.
  const runnable = current?.status === "active" && queue ? queue.flatMap((e) => (e.state === "ready" ? [e.issue] : [])) : []
  const ordered = [...barProjects(projects), ...projects.filter((p) => p.status === "archived")]

  if (lanesPage) return <LanesPage open={open} onOpenChange={close} onBack={() => setLanesPage(false)} />
  if (parallelPage && current) return <ParallelPage open={open} onOpenChange={close} project={current} onBack={() => setParallelPage(false)} />

  return (
    <CommandDialog open={open} onOpenChange={close} title="Paleta de comandos" description="Busca un proyecto, una corrida o una acción">
      <CommandInput placeholder="Busca un proyecto, una corrida o una acción…" />
      <CommandList className="max-h-[420px]">
        <CommandEmpty>Sin resultados.</CommandEmpty>

        {contextIssue ? (
          <CommandGroup heading={issueKey(contextIssue)}>
            <CommandItem onSelect={run(() => actions.openIssue(contextIssue))}>
              <ListTodo /> Ver ficha de {issueKey(contextIssue)}
            </CommandItem>
            {contextIssue.ref.tracker !== "local" ? (
              <CommandItem onSelect={run(() => actions.openExternal(contextIssue.ref.url))}>
                <ExternalLink /> Abrir {issueKey(contextIssue)} en {contextIssue.ref.tracker === "linear" ? "Linear" : contextIssue.ref.tracker}
              </CommandItem>
            ) : null}
          </CommandGroup>
        ) : null}

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
          <CommandGroup heading={`Este PR · ${keyOf(selectedPr)}`}>
            {!selectedPr.local ? (
              <>
                <CommandItem value="pr abrir en github" onSelect={run(() => prCommands.openGithub(selectedPr))}>
                  <ExternalLink /> Abrir PR en GitHub
                  <CommandShortcut>{PR_KEYS.openGithub}</CommandShortcut>
                </CommandItem>
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
              </>
            ) : null}
            <CommandItem value="pr chatear sobre este pr pedir cambios" onSelect={run(() => prCommands.chat(selectedPr))}>
              <MessageSquare /> Chatear sobre este PR
              <CommandShortcut>{PR_KEYS.chat}</CommandShortcut>
            </CommandItem>
            <CommandItem value="pr ver descripción commits diff" onSelect={run(() => prCommands.view(selectedPr))}>
              <Eye /> Ver PR
              <CommandShortcut>{PR_KEYS.view}</CommandShortcut>
            </CommandItem>
            {selectedPr.local && prCaps.publishLocal ? (
              <CommandItem value="pr publicar ahora en github local" onSelect={run(() => prCommands.publishLocal(selectedPr))}>
                <Upload /> Publicar ahora
                <CommandShortcut>{PR_KEYS.publishLocal}</CommandShortcut>
              </CommandItem>
            ) : null}
            {prCaps.run ? (
              <CommandItem value="pr ver corrida" onSelect={run(() => prCommands.openRun(selectedPr))}>
                <ScrollText /> Ver la corrida que lo abrió
                <CommandShortcut>{PR_KEYS.run}</CommandShortcut>
              </CommandItem>
            ) : null}
          </CommandGroup>
        ) : null}

        {pr?.chat ? (
          <CommandGroup heading="Chat del PR">
            <CommandItem value="chat abrir plegar panel" onSelect={run(pr.chat.toggle)}>
              <MessageSquare /> {pr.chat.open ? "Plegar chat" : "Abrir chat"}
              <CommandShortcut>{CHAT_KEYS.toggle}</CommandShortcut>
            </CommandItem>
            {Object.entries(pr.chat.actions).map(([id, action]) => (
              <CommandItem key={id} value={`chat ${action.label}`} disabled={!!action.reason} onSelect={run(action.run)}>
                <MessageSquare /> {action.label}{action.reason ? `: ${action.reason}` : null}
                <CommandShortcut>{action.keys}</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}

        {pr ? (
          <CommandGroup heading="Diff del PR">
            <CommandItem value="diff lado a lado unificado modo" onSelect={run(pr.toggleMode)}>
              {pr.mode === "split" ? <Rows2 /> : <Columns2 />} {pr.mode === "split" ? "Ver el diff unificado" : "Ver el diff lado a lado"}
              <CommandShortcut>{PR_VIEW_KEYS.mode}</CommandShortcut>
            </CommandItem>
            {pr.prevCommit ? (
              <CommandItem value="commit anterior revisar" onSelect={run(pr.prevCommit)}>
                <ChevronLeft /> Commit anterior
                <CommandShortcut>{PR_VIEW_KEYS.prev}</CommandShortcut>
              </CommandItem>
            ) : null}
            {pr.nextCommit ? (
              <CommandItem value="commit siguiente revisar" onSelect={run(pr.nextCommit)}>
                <ChevronRight /> Commit siguiente
                <CommandShortcut>{PR_VIEW_KEYS.next}</CommandShortcut>
              </CommandItem>
            ) : null}
            {pr.allCommits ? (
              <CommandItem value="ver todos los commits diff completo" onSelect={run(pr.allCommits)}>
                <GitCommitHorizontal /> Ver todos los commits
                <CommandShortcut>{PR_VIEW_KEYS.all}</CommandShortcut>
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
              <CommandShortcut>{RUN_KEYS.graph}</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={run(() => onRunTab("timeline"))}>
              <ListTree /> Ver la línea de tiempo
              <CommandShortcut>{RUN_KEYS.timeline}</CommandShortcut>
            </CommandItem>
            {runCaps?.caps.failedStep ? (
              <CommandItem onSelect={run(() => commands.retry(runCaps.caps.failedStep!.id, runCaps.caps.failedStep!.nodeId))}>
                <RotateCcw /> Reintentar el paso fallido
                <CommandShortcut>{RUN_KEYS.retry}</CommandShortcut>
              </CommandItem>
            ) : null}
            {runCaps?.caps.pause ? (
              <CommandItem onSelect={run(() => commands.pause(runCaps.id))}>
                <Pause /> Pausar la corrida
                <CommandShortcut>{RUN_KEYS.pauseResume}</CommandShortcut>
              </CommandItem>
            ) : null}
            {runCaps?.caps.resume ? (
              <CommandItem onSelect={run(() => commands.resume(runCaps.id))}>
                <Play /> Retomar la corrida
                <CommandShortcut>{RUN_KEYS.pauseResume}</CommandShortcut>
              </CommandItem>
            ) : null}
            {runCaps?.caps.interrupt ? (
              <CommandItem onSelect={run(() => commands.interrupt(runCaps.id))}>
                <Square /> Interrumpir al agente en curso
                <CommandShortcut>{RUN_KEYS.interrupt}</CommandShortcut>
              </CommandItem>
            ) : null}
            {runCaps?.caps.cancel ? (
              <CommandItem onSelect={run(() => commands.cancel(runCaps.id))}>
                <Octagon /> Cancelar la corrida
                <CommandShortcut>{RUN_KEYS.cancel}</CommandShortcut>
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
              {current.status === "active" ? <Pause /> : <Play />} {current.status === "active" ? "Pausar desarrollo" : "Reanudar desarrollo"}
              <CommandShortcut>⇧⌘Y</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={run(() => void actions.toggleMaintenance(current))}>
              {current.maintenancePaused ? <Play /> : <Pause />} {current.maintenancePaused ? "Reanudar mantenimiento" : "Pausar mantenimiento"}
              <CommandShortcut>⇧⌘U</CommandShortcut>
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
          <CommandItem value="reintentar ahora lo que está en pausa breakers" onSelect={run(() => void actions.retryBreakers(current ?? null))}>
            <RotateCw /> {current ? "Reintentar ahora lo que pausa a este proyecto" : "Reintentar ahora lo que está en pausa"}
            <CommandShortcut>⇧⌘E</CommandShortcut>
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

        {current && issues.length ? (
          <CommandGroup heading={`Issues de ${current.name}`}>
            {issues.map((i) => (
              <CommandItem key={i.id} value={`ver issue ${issueKey(i)} ${i.title}`} onSelect={run(() => actions.openIssue(i))}>
                <ListTodo /><span className="font-mono text-xs">{issueKey(i)}</span><span className="truncate">{i.title}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}

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
                <CommandItem key={p.id} value={`pr ${p.id} ${repoNameOf(p)} ${keyOf(p)} ${titleOf(p)} ${branchOf(p)}`} onSelect={run(() => prCommands.view(p))}>
                  <GitPullRequest />
                  <span className="w-[92px] flex-none truncate font-mono text-[11.5px] text-muted-foreground">
                    {p.ref ? `${repoNameOf(p)}#${p.ref.number}` : p.local.branch}
                  </span>
                  <span className="truncate">{titleOf(p)}</span>
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
          <CommandItem onSelect={run(() => actions.goModule("reviews"))}>
            <MessageSquare /> Ir a Mis reviews <CommandShortcut>⇧⌘J</CommandShortcut>
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
          <CommandItem onSelect={run(() => void actions.testCodex())}>
            <SquareTerminal /> Conectar o probar Codex
            <CommandShortcut>⇧⌘X</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={run(actions.disconnectCodex)}>
            <Unplug /> Desconectar Codex
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
