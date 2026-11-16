import type { Breaker, CachedIssue, CachedPr, ClankerProject, Decision, Lanes, QueueEntry, Run } from "@clanker/api"
import { Copy, Ellipsis, Pause, Play } from "lucide-react"
import { type ReactNode, useRef } from "react"
import { BreakerStrip } from "@/components/project/breaker-strip"
import { Ago, Hint, Pill, SectionTitle, StatBar } from "@/components/common"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ParkedList, QueueList } from "@/components/project/issue-lists"
import { LaneBoard } from "@/components/project/lanes"
import { LanesControl } from "@/components/project/lanes-control"
import { useRunCommands } from "@/components/project/run-commands"
import { RunStatusIcon, RunStatusPill, isLive } from "@/components/project/status"
import { Button } from "@/components/ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useNow } from "@/hooks/use-now"
import { useAppActions } from "@/lib/app-context"
import { copy } from "@/lib/clipboard"
import { costUsd, elapsed, tone } from "@/lib/format"
import { subjectLabeler, type SubjectLabel } from "@/lib/subject"
import { borrowers as borrowersOf, breakersOf, laneUsage, parkedRuns, projectPrs, spentToday } from "@/lib/project-ops"

const PROJECT_STATUS = {
  active: { label: "activo", tone: tone.green, hint: "Toma issues de su cola y lanza corridas." },
  paused: { label: "pausado", tone: tone.amber, hint: "No lanza corridas nuevas; las que ya están siguen." },
  archived: { label: "archivado", tone: tone.neutral, hint: "Fuera de la barra lateral. No lanza corridas." },
} as const

/** Las pestañas del proyecto, en el orden de ⇧⌘1, ⇧⌘2 y ⇧⌘3. */
export const PROJECT_TABS = ["operation", "summary", "settings"] as const
export type ProjectTab = (typeof PROJECT_TABS)[number]

/** Los paralelismos que ofrecen el menú y ⌘K. */
export const PARALLEL_OPTIONS = [1, 2, 3, 4, 5, 6] as const

interface Props {
  project: ClankerProject
  runs: Run[]
  issues: CachedIssue[]
  /** La cola que calcula el core (`projects.queue`). */
  queue: QueueEntry[]
  /** Por qué el core no pudo calcular la cola (p. ej. el tracker sin cuenta conectada); `queue` viene vacía. */
  queueError?: string
  /** Las decisiones del proyecto; las pendientes son las que estacionan una corrida o esperan respuesta. */
  decisions: Decision[]
  /** Los cupos de los carriles de la máquina. */
  lanes: Lanes
  /** Los circuit breakers abiertos de todo el core. */
  breakers: Breaker[]
  /** Los PRs que Watch conoce. */
  prs: CachedPr[]
}

/** Las issues de un proyecto por su id, para ponerle clave y título a cada corrida. */
export const issuesById = (issues: CachedIssue[]) => new Map<string, CachedIssue>(issues.map((i) => [i.id, i]))

// El proyecto: su encabezado, sus pestañas y, debajo, la vista de la pestaña elegida. Las pestañas cargan sus propios
// datos, así que una que no se puede leer (la cola de un proyecto importado sin su tracker conectado) no esconde a las otras.
export function ProjectFrame({ project, tab, onTab, children }: { project: ClankerProject; tab: ProjectTab; onTab: (tab: ProjectTab) => void; children: ReactNode }) {
  const status = PROJECT_STATUS[project.status]
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2.5">
          <h1 className="text-lg font-semibold">{project.name}</h1>
          <Pill className={status.tone} hint={status.hint}>
            {status.label}
          </Pill>
          <ProjectActions project={project} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill className={tone.neutral} hint="Flujo con que corre una issue si no se pide otro.">
            flujo: {project.defaultFlowId ?? "sin flujo"}
          </Pill>
          <Pill className={tone.neutral} hint="Perfil con que corren los pasos de agente.">
            perfil: {project.defaultProfileId ?? "sin perfil"}
          </Pill>
          <Pill className={tone.neutral} hint="De dónde salen las issues del proyecto.">
            {project.tracker === "local" ? "tracker local" : `${project.tracker} · ${project.trackerRef}`}
          </Pill>
        </div>
      </header>

      <Tabs value={tab} onValueChange={(value) => onTab(value as ProjectTab)} className="-mt-3 gap-0">
        <TabsList variant="line" aria-label="Vistas del proyecto" className="h-8 border-b">
          <Hint label="Qué corre, qué espera a una persona y qué viene" keys="⇧⌘1">
            <TabsTrigger value="operation">Operación</TabsTrigger>
          </Hint>
          <Hint label="Cuánto gastó el proyecto y cuántas vueltas dieron sus issues" keys="⇧⌘2">
            <TabsTrigger value="summary">Resumen</TabsTrigger>
          </Hint>
          <Hint label="Repos, filtros de la cola, convenciones, mapeo de estados y parámetros del flujo" keys="⇧⌘3">
            <TabsTrigger value="settings">Ajustes</TabsTrigger>
          </Hint>
        </TabsList>
      </Tabs>

      {children}
    </div>
  )
}

// Operación: qué corre en cada carril, qué espera a una persona, qué viene y por qué no corre.
export function ProjectView({ project, runs, issues, queue, queueError, decisions, lanes, breakers, prs }: Props) {
  const roots = runs.filter((r) => r.parentRunId === null)
  const live = roots.filter((r) => isLive(r.status))
  const parked = parkedRuns(roots)
  const finished = roots.filter((r) => !isLive(r.status))
  const stopped = breakersOf(project, breakers)
  const now = useNow(live.length > 0 || stopped.length > 0)
  const subjectOf = subjectLabeler(issues, prs)
  const usage = laneUsage(project, roots, lanes)
  const pending = decisions.filter((d) => d.status === "pending")
  const queued = queue.filter((e) => e.state !== "blocked")
  const blocked = queue.filter((e) => e.state === "blocked")
  const spent = spentToday(runs, now)

  return (
    <>
      <StatBar
        items={[
          { label: "Carril dev", value: `${usage.dev.active}/${usage.dev.capacity}`, sub: `máquina ${usage.dev.machine.active}/${usage.dev.machine.capacity}`, action: <LanesControl lanes={lanes} /> },
          {
            label: "Carril mantenimiento",
            value: `${usage.maintenance.active}/${usage.maintenance.capacity}`,
            sub: `máquina ${usage.maintenance.machine.active}/${usage.maintenance.machine.capacity}`,
            action: <LanesControl lanes={lanes} />,
          },
          { label: "PRs abiertos", value: String(projectPrs(prs, runs).length), sub: "que abrió el proyecto" },
          {
            label: "Decisiones pendientes",
            value: String(pending.length),
            sub: parked.length ? `${parked.length} ${parked.length === 1 ? "corrida estacionada" : "corridas estacionadas"}` : "ninguna estaciona",
            tone: pending.length ? "text-amber-700 dark:text-amber-300" : undefined,
          },
          { label: "Gasto de hoy", value: costUsd(spent), sub: project.maxCostUsd === null ? "sin tope" : `tope por corrida $${project.maxCostUsd}` },
        ]}
      />

      <BreakerStrip breakers={stopped} now={now} />

      {roots.length === 0 && queue.length === 0 ? (
        <EmptyProject />
      ) : (
        <LaneBoard project={project} runs={roots} usage={usage} subjectOf={subjectOf} now={now} />
      )}

      <ParkedList runs={parked} decisions={decisions} subjectOf={subjectOf} borrowers={borrowersOf(roots)} project={project} />
      {roots.length || queue.length || queueError ? (
        <QueueList title="En cola" entries={queued} project={project} empty={queueError ? `No se pudo calcular la cola. ${queueError}` : emptyQueue(project)} />
      ) : null}
      <QueueList title="Bloqueadas" entries={blocked} project={project} />
      <RunGroup title="Terminadas" runs={finished} subjectOf={subjectOf} now={now} project={project} />
    </>
  )
}

/** Dice qué filtro dejó la cola vacía, para saber qué cambiar. */
function emptyQueue(project: ClankerProject): string {
  const status = project.queueFilter.status?.join(" o ") ?? "todo"
  const labels = project.queueFilter.labels?.length ? ` con el label ${project.queueFilter.labels.join(" o ")}` : ""
  const excluded = project.queueFilter.excludeLabels ?? ["no-clanker"]
  return `0 issues en ${status}${labels} sin el label ${excluded.join(" ni ")}. Crea o mueve una issue a ${status} en ${project.tracker === "local" ? "el tracker local" : project.tracker}, o ajusta los filtros de la cola del proyecto.`
}

// El botón principal del proyecto (Pausar o Reanudar) y, en "…", el resto de lo que se hace con él.
function ProjectActions({ project }: { project: ClankerProject }) {
  const actions = useAppActions()
  const commands = useRunCommands()
  // Una acción que lleva a otra vista deja el foco allá: el menú no se lo devuelve a su botón al cerrarse.
  const leaving = useRef(false)
  if (project.status === "archived") return null
  const pausing = project.status === "active"
  return (
    <div className="ml-auto flex items-center gap-1.5">
      <Hint label={pausing ? "El Scheduler deja de lanzar issues de este proyecto. Lo que ya corre, y los demás proyectos, siguen" : "El Scheduler vuelve a lanzar las issues de la cola"} keys="⇧⌘Y">
        <Button size="sm" variant={pausing ? "outline" : "default"} onClick={() => (pausing ? commands.pauseProject(project) : commands.resumeProject(project))}>
          {pausing ? <Pause /> : <Play />}
          {pausing ? "Pausar" : "Reanudar"}
        </Button>
      </Hint>
      <DropdownMenu>
        <Hint label="Más acciones del proyecto">
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label="Más acciones del proyecto">
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
        </Hint>
        <DropdownMenuContent align="end" className="w-56" onCloseAutoFocus={(e) => {
            if (!leaving.current) return
            leaving.current = false
            e.preventDefault()
          }}
        >
          <DropdownMenuItem
            onSelect={() => {
              leaving.current = true
              actions.editQueueFilters()
            }}
          >
            Filtros de la cola
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Cambiar paralelismo</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup value={String(project.parallel)} onValueChange={(value) => void actions.setParallel(project, Number(value))}>
                {PARALLEL_OPTIONS.map((n) => (
                  <DropdownMenuRadioItem key={n} value={String(n)}>
                    {n} {n === 1 ? "corrida" : "corridas"} a la vez
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function EmptyProject() {
  const actions = useAppActions()
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-2 py-10 text-center">
      <h2 className="text-base font-semibold">Todavía no hay corridas</h2>
      <p className="text-muted-foreground">
        Una corrida lanza el flujo del proyecto sobre una issue. Con tracker local crea una issue (<code className="font-mono">issues.createLocal</code>) y córrela desde acá; con
        otro tracker, las issues llegan al sincronizar.
      </p>
      <Button variant="outline" size="sm" onClick={actions.refresh}>
        Actualizar
      </Button>
    </div>
  )
}

function RunGroup({ title, runs, subjectOf, now, project }: { title: string; runs: Run[]; subjectOf: (run: Run) => SubjectLabel; now: number; project: ClankerProject }) {
  if (!runs.length) return null
  return (
    <section className="flex flex-col gap-2">
      <SectionTitle count={runs.length}>{title}</SectionTitle>
      <ul className="overflow-hidden rounded-lg border bg-card">
        {runs.map((run) => (
          <RunRow key={run.id} run={run} subject={subjectOf(run)} now={now} project={project} />
        ))}
      </ul>
    </section>
  )
}

function RunRow({ run, subject, now, project }: { run: Run; subject: SubjectLabel; now: number; project: ClankerProject }) {
  const actions = useAppActions()
  const open = () => actions.openRun(project.slug, run.id)
  const duration = (run.endedAt ?? now) - run.startedAt
  return (
    <li className="border-b last:border-b-0">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button type="button" onClick={open} className="flex h-9 w-full items-center gap-3 px-3 text-left hover:bg-accent/60">
            <RunStatusIcon run={run} />
            <span className="w-20 flex-none truncate font-mono text-xs text-muted-foreground">{subject.key}</span>
            <span className="min-w-0 flex-1 truncate">{subject.title}</span>
            <Pill className={tone.neutral} hint={`Flujo ${run.flow.slug}, versión ${run.flow.version}. La corrida sigue con esa versión aunque el flujo cambie.`}>
              {run.flow.slug} v{run.flow.version}
            </Pill>
            <RunStatusPill run={run} />
            <span className="w-20 flex-none text-right text-xs text-muted-foreground tabular-nums">{elapsed(duration)}</span>
            <span className="w-16 flex-none text-right text-xs tabular-nums">{costUsd(run.costMicros)}</span>
            <Ago at={run.startedAt} className="w-20 flex-none text-right text-xs text-muted-foreground" />
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuItem onSelect={open}>Ver corrida</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => copy(run.id, "el ID de la corrida")}>
            <Copy /> Copiar ID de la corrida
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  )
}
