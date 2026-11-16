import type { ClankerProject, Decision, QueueEntry, Run } from "@clanker/api"
import { ArrowUpToLine, Ban, Copy, ExternalLink, Play, Undo2 } from "lucide-react"
import { Hint, Pill, SectionTitle } from "@/components/common"
import { RunStatusIcon, RunStatusPill } from "@/components/project/status"
import { Button } from "@/components/ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from "@/components/ui/context-menu"
import { useAppActions } from "@/lib/app-context"
import { copy } from "@/lib/clipboard"
import { issueKey, tone } from "@/lib/format"
import { decisionOf, parkReasonOf } from "@/lib/project-ops"
import type { SubjectLabel } from "@/lib/subject"
import { cn } from "@/lib/utils"

const QUEUE_STATE = {
  ready: { label: "lista", tone: tone.green, hint: "Se puede lanzar ya." },
  waiting: { label: "esperando", tone: tone.sky, hint: "Espera a una issue bloqueante en curso; se reevalúa sola." },
  blocked: { label: "bloqueada", tone: tone.amber, hint: "Necesita que alguien haga algo con lo que la bloquea." },
} as const

interface QueueProps {
  title: string
  /** Lo que dice la sección cuando no hay nada, con qué hacer; con él ofrece editar los filtros de la cola. */
  empty?: string
  /** El botón del vacío cuando lo que falta no son los filtros (la cola no se pudo calcular). */
  emptyAction?: { label: string; onClick: () => void }
  entries: readonly QueueEntry[]
  project: ClankerProject
}

// Issues de la cola, cada una con su motivo a la vista. La cola ya viene ordenada por el core.
export function QueueList({ title, empty, emptyAction, entries, project }: QueueProps) {
  const actions = useAppActions()
  if (!entries.length && !empty) return null
  return (
    <section className="flex flex-col gap-2">
      <SectionTitle count={entries.length}>{title}</SectionTitle>
      {entries.length ? (
        <ul className="overflow-hidden rounded-lg border bg-card">
          {entries.map((entry) => (
            <QueueRow key={entry.issue.id} entry={entry} project={project} />
          ))}
        </ul>
      ) : (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed px-3 py-4">
          <p className="text-muted-foreground">{empty}</p>
          <Button size="sm" variant="outline" onClick={emptyAction?.onClick ?? actions.editQueueFilters}>
            {emptyAction?.label ?? "Editar filtros"}
          </Button>
        </div>
      )}
    </section>
  )
}

function QueueRow({ entry, project }: { entry: QueueEntry; project: ClankerProject }) {
  const actions = useAppActions()
  const { issue } = entry
  const state = QUEUE_STATE[entry.state]
  const skipped = entry.state === "blocked" && entry.skipped === true
  const runnable = project.status === "active" && entry.state === "ready"
  const run = () => void actions.startRun(project, issue)
  return (
    <li className="border-b last:border-b-0">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex items-center gap-3 px-3 py-1.5">
            <span className="size-3.5 flex-none rounded-full border border-muted-foreground/50" />
            <span className="w-20 flex-none truncate font-mono text-xs text-muted-foreground">{issueKey(issue)}</span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{issue.title}</span>
              <span className="truncate text-xs text-muted-foreground">{entry.reason}</span>
            </div>
            <Pill className={state.tone} hint={`${state.hint} ${entry.reason}`}>
              {skipped ? "saltada" : state.label}
            </Pill>
            {skipped ? (
              <Hint label="Vuelve a la cola: el proyecto la puede tomar de nuevo">
                <Button size="xs" variant="outline" onClick={() => void actions.skipIssue(project, issue, false)}>
                  <Undo2 /> Volver
                </Button>
              </Hint>
            ) : (
              <Hint
                label={
                  runnable
                    ? "Lanza el flujo del proyecto sobre esta issue (también en ⌘K)"
                    : project.status !== "active"
                      ? "El proyecto no está activo: reanúdalo para lanzar corridas"
                      : `No se puede lanzar todavía: ${entry.reason}`
                }
              >
                <span>
                  <Button size="xs" variant="outline" disabled={!runnable} onClick={run} className={cn(!runnable && "pointer-events-none")}>
                    <Play /> Correr
                  </Button>
                </span>
              </Hint>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          <ContextMenuItem disabled={!runnable} onSelect={run}>
            <Play /> Correr ahora
          </ContextMenuItem>
          {entry.state !== "blocked" ? (
            <ContextMenuItem onSelect={() => void actions.boostIssue(project, issue)}>
              <ArrowUpToLine /> Subirla en la cola
            </ContextMenuItem>
          ) : null}
          {skipped ? (
            <ContextMenuItem onSelect={() => void actions.skipIssue(project, issue, false)}>
              <Undo2 /> Volver a la cola
            </ContextMenuItem>
          ) : (
            <ContextMenuItem onSelect={() => void actions.skipIssue(project, issue, true)}>
              <Ban /> No tomarla
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          {issue.ref.tracker !== "local" ? (
            <ContextMenuItem onSelect={() => actions.openExternal(issue.ref.url)}>
              <ExternalLink /> Abrir en {issue.ref.tracker === "linear" ? "Linear" : issue.ref.tracker}
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem onSelect={() => copy(issueKey(issue), "la clave de la issue")}>
            <Copy /> Copiar clave
            <ContextMenuShortcut>{issueKey(issue)}</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  )
}

interface ParkedProps {
  runs: readonly Run[]
  decisions: readonly Decision[]
  subjectOf: (run: Run) => SubjectLabel
  /** Para cada corrida estacionada que prestó su sujeto, la corrida de mantenimiento que lo tiene. */
  borrowers: ReadonlyMap<string, Run>
  project: ClankerProject
}

// Una corrida estacionada espera a una persona: no ocupa cupo ni slot y nada más espera por ella.
export function ParkedList({ runs, decisions, subjectOf, borrowers, project }: ParkedProps) {
  const actions = useAppActions()
  if (!runs.length) return null
  return (
    <section className="flex flex-col gap-2">
      <SectionTitle count={runs.length} aside="Esperan una decisión tuya en la Bandeja y no ocupan cupo del carril">
        Estacionadas
      </SectionTitle>
      <ul className="overflow-hidden rounded-lg border bg-card">
        {runs.map((run) => {
          const subject = subjectOf(run)
          const decision = decisionOf(run, decisions)
          const reason = parkReasonOf(run.parkReason)
          const borrower = borrowers.get(run.id)
          const open = () => actions.openRun(project.slug, run.id)
          return (
            <li key={run.id} className="border-b last:border-b-0">
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <button type="button" onClick={open} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent/60">
                    <RunStatusIcon run={run} />
                    <span className="w-20 flex-none truncate font-mono text-xs text-muted-foreground">{subject.key}</span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{subject.title}</span>
                      <span className="flex min-w-0 gap-1 text-xs text-muted-foreground">
                        <Hint label={reason.hint}>
                          <span className="flex-none font-medium text-amber-700 dark:text-amber-300">{reason.label}</span>
                        </Hint>
                        <span aria-hidden>·</span>
                        <span className="truncate">{decision ? decision.title : "su decisión ya se resolvió: vuelve a la cola de su carril apenas haya cupo"}</span>
                      </span>
                      {borrower ? (
                        <span className="truncate text-xs text-sky-700 dark:text-sky-300">Su PR está prestado al carril de mantenimiento ({borrower.flow.slug}): se lo devuelve al terminar.</span>
                      ) : null}
                    </span>
                    <Pill className={tone.neutral} hint={`Flujo ${run.flow.slug}, versión ${run.flow.version}. La corrida sigue con esa versión aunque el flujo cambie.`}>
                      {run.flow.slug} v{run.flow.version}
                    </Pill>
                    <RunStatusPill run={run} />
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
        })}
      </ul>
    </section>
  )
}
