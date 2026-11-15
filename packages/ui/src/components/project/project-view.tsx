import type { CachedIssue, ClankerProject, Run } from "@clanker/api"
import { Copy, Play } from "lucide-react"
import { Ago, Hint, Pill, SectionTitle, StatBar } from "@/components/common"
import { RunStatusIcon, RunStatusPill, isLive } from "@/components/project/status"
import { Button } from "@/components/ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"
import { useNow } from "@/hooks/use-now"
import { useAppActions } from "@/lib/app-context"
import { copy } from "@/lib/clipboard"
import { costUsd, elapsed, issueKey, tone } from "@/lib/format"
import { cn } from "@/lib/utils"

const PROJECT_STATUS = {
  active: { label: "activo", tone: tone.green, hint: "Toma issues de su cola y lanza corridas." },
  paused: { label: "pausado", tone: tone.amber, hint: "No lanza corridas nuevas; las que ya están siguen." },
  archived: { label: "archivado", tone: tone.neutral, hint: "Fuera de la barra lateral. No lanza corridas." },
} as const

interface Props {
  project: ClankerProject
  runs: Run[]
  issues: CachedIssue[]
}

/** Las issues de un proyecto por su id, para ponerle clave y título a cada corrida. */
export const issuesById = (issues: CachedIssue[]) => new Map<string, CachedIssue>(issues.map((i) => [i.id, i]))

// Operación del proyecto: qué corre, qué espera a una persona y qué viene.
export function ProjectView({ project, runs, issues }: Props) {
  const live = runs.filter((r) => isLive(r.status))
  const inProgress = live.filter((r) => r.status !== "parked")
  const parked = live.filter((r) => r.status === "parked")
  const finished = runs.filter((r) => !isLive(r.status))
  const devBusy = live.filter((r) => r.lane === "dev" && (r.status === "running" || r.status === "waiting")).length
  const now = useNow(inProgress.length > 0)
  const byId = issuesById(issues)
  const status = PROJECT_STATUS[project.status]
  const liveSubjects = new Set(live.map((r) => r.subject.id))
  const queue = issues.filter((i) => i.status === "todo" && !liveSubjects.has(i.id))

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2.5">
          <h1 className="text-lg font-semibold">{project.name}</h1>
          <Pill className={status.tone} hint={status.hint}>
            {status.label}
          </Pill>
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
          <Pill className={tone.neutral} hint="Cuántas corridas del carril dev puede tener en curso a la vez.">
            carril dev: {devBusy}/{project.parallel}
          </Pill>
        </div>
      </header>

      <StatBar
        items={[
          { label: "En curso", value: String(inProgress.length), sub: `carril dev ${devBusy}/${project.parallel}` },
          { label: "Estacionadas", value: String(parked.length), sub: parked.length ? "te esperan" : "ninguna", tone: parked.length ? "text-amber-700 dark:text-amber-300" : undefined },
          { label: "Terminadas", value: String(finished.length), sub: `${finished.filter((r) => r.status === "failed").length} fallaron` },
          { label: "Gasto", value: costUsd(runs.reduce((sum, r) => sum + r.costMicros, 0)), sub: `${runs.length} ${runs.length === 1 ? "corrida" : "corridas"}` },
        ]}
      />

      {runs.length === 0 && queue.length === 0 ? <EmptyProject /> : null}

      <RunGroup title="En curso" runs={inProgress} byId={byId} now={now} project={project} />
      <RunGroup title="Estacionadas" runs={parked} byId={byId} now={now} project={project} />

      {queue.length ? (
        <section className="flex flex-col gap-2">
          <SectionTitle count={queue.length}>En cola</SectionTitle>
          <ul className="overflow-hidden rounded-lg border bg-card">
            {queue.map((issue) => (
              <QueueRow key={issue.id} issue={issue} project={project} />
            ))}
          </ul>
        </section>
      ) : null}

      <RunGroup title="Terminadas" runs={finished} byId={byId} now={now} project={project} />
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

function RunGroup({ title, runs, byId, now, project }: { title: string; runs: Run[]; byId: Map<string, CachedIssue>; now: number; project: ClankerProject }) {
  if (!runs.length) return null
  return (
    <section className="flex flex-col gap-2">
      <SectionTitle count={runs.length}>{title}</SectionTitle>
      <ul className="overflow-hidden rounded-lg border bg-card">
        {runs.map((run) => (
          <RunRow key={run.id} run={run} issue={byId.get(run.subject.id)} now={now} project={project} />
        ))}
      </ul>
    </section>
  )
}

function RunRow({ run, issue, now, project }: { run: Run; issue: CachedIssue | undefined; now: number; project: ClankerProject }) {
  const actions = useAppActions()
  const open = () => actions.openRun(project.slug, run.id)
  const duration = (run.endedAt ?? now) - run.startedAt
  return (
    <li className="border-b last:border-b-0">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button type="button" onClick={open} className="flex h-9 w-full items-center gap-3 px-3 text-left hover:bg-accent/60">
            <RunStatusIcon run={run} />
            <span className="w-20 flex-none truncate font-mono text-xs text-muted-foreground">{issue ? issueKey(issue) : run.subject.id}</span>
            <span className="min-w-0 flex-1 truncate">{issue?.title ?? "issue fuera del caché"}</span>
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

function QueueRow({ issue, project }: { issue: CachedIssue; project: ClankerProject }) {
  const actions = useAppActions()
  const runnable = project.status === "active"
  const run = () => void actions.startRun(project, issue)
  return (
    <li className="border-b last:border-b-0">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex h-9 items-center gap-3 px-3">
            <span className="size-3.5 flex-none rounded-full border border-muted-foreground/50" />
            <span className="w-20 flex-none truncate font-mono text-xs text-muted-foreground">{issueKey(issue)}</span>
            <span className="min-w-0 flex-1 truncate">{issue.title}</span>
            <Hint label={runnable ? "Lanza el flujo del proyecto sobre esta issue (también en ⌘K)" : "El proyecto no está activo: reanúdalo para lanzar corridas"}>
              <span>
                <Button size="xs" variant="outline" disabled={!runnable} onClick={run} className={cn(!runnable && "pointer-events-none")}>
                  <Play /> Correr
                </Button>
              </span>
            </Hint>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuItem disabled={!runnable} onSelect={run}>
            <Play /> Correr ahora
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => copy(issueKey(issue), "la clave de la issue")}>
            <Copy /> Copiar clave
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  )
}
