import type { ClankerProject, Lane, Run } from "@clanker/api"
import { Copy, GitPullRequest } from "lucide-react"
import { useAppData } from "@/app-data"
import { Hint, Pill, SectionTitle } from "@/components/common"
import { RunStatusIcon, RunStatusPill, stepLook } from "@/components/project/status"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { useLiveQuery } from "@/hooks/use-live"
import { useAppActions } from "@/lib/app-context"
import { copy } from "@/lib/clipboard"
import { costUsd, elapsed, tone } from "@/lib/format"
import { holdsLane, type LaneUsage } from "@/lib/project-ops"
import { type Stepper, stepperOf } from "@/lib/stepper"
import type { SubjectLabel } from "@/lib/subject"
import { cn } from "@/lib/utils"

const LANE = {
  dev: {
    title: "Carril dev",
    hint: "Desarrolla issues nuevas. Su cupo es el paralelismo del proyecto, con el tope global de la máquina.",
    empty: "Cupo libre. El proyecto lanza aquí la próxima issue de la cola.",
  },
  maintenance: {
    title: "Carril mantenimiento",
    hint: "Rebasea, restackea y atiende PRs ya abiertos. Tiene su propio cupo: nunca usa ni espera el de dev.",
    empty: "Sin rebases ni restacks en curso. Si un PR cae en conflicto, se atiende aquí aunque dev esté lleno.",
  },
} as const satisfies Record<Lane, { title: string; hint: string; empty: string }>

interface BoardProps {
  project: ClankerProject
  runs: readonly Run[]
  usage: Record<Lane, LaneUsage>
  subjectOf: (run: Run) => SubjectLabel
  now: number
}

// Los dos carriles lado a lado: dev y mantenimiento tienen cupos separados, así que un rebase se ve en
// mantenimiento aunque dev esté lleno.
export function LaneBoard({ project, runs, usage, subjectOf, now }: BoardProps) {
  const lenderOf = (run: Run) => (run.borrowedFromRunId ? runs.find((r) => r.id === run.borrowedFromRunId) : undefined)
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {(["dev", "maintenance"] as const).map((lane) => {
        const inLane = runs.filter((r) => r.lane === lane && r.parentRunId === null)
        return (
          <LaneColumn
            key={lane}
            lane={lane}
            usage={usage[lane]}
            holding={inLane.filter(holdsLane)}
            waiting={inLane.filter((r) => r.status === "queued")}
            project={project}
            subjectOf={subjectOf}
            lenderOf={lenderOf}
            now={now}
          />
        )
      })}
    </div>
  )
}

function LaneColumn({
  lane,
  usage,
  holding,
  waiting,
  project,
  subjectOf,
  lenderOf,
  now,
}: {
  lane: Lane
  usage: LaneUsage
  holding: Run[]
  waiting: Run[]
  project: ClankerProject
  subjectOf: (run: Run) => SubjectLabel
  lenderOf: (run: Run) => Run | undefined
  now: number
}) {
  const words = LANE[lane]
  const full = usage.active >= usage.capacity
  return (
    <section aria-label={words.title} className="flex flex-col gap-2">
      <SectionTitle
        aside={
          <Hint label={`Toda la máquina usa ${usage.machine.active} de ${usage.machine.capacity} cupos de ${lane === "dev" ? "dev" : "mantenimiento"}.`}>
            <span>
              máquina {usage.machine.active}/{usage.machine.capacity}
            </span>
          </Hint>
        }
      >
        <Hint label={words.hint}>
          <span>{words.title}</span>
        </Hint>
        <Pill className={full ? tone.violet : tone.neutral} hint={`${usage.active} de ${usage.capacity} cupos de este proyecto en uso.`}>
          {usage.active}/{usage.capacity}
        </Pill>
      </SectionTitle>
      {holding.length === 0 && waiting.length === 0 ? <p className="rounded-lg border border-dashed px-3 py-4 text-muted-foreground">{words.empty}</p> : null}
      {holding.map((run) => {
        const lender = lenderOf(run)
        return <SlotCard key={run.id} run={run} subject={subjectOf(run)} lentBy={lender && subjectOf(lender)} project={project} now={now} />
      })}
      {waiting.length ? (
        <ul className="overflow-hidden rounded-lg border bg-card">
          {waiting.map((run) => (
            <WaitingRow key={run.id} run={run} subject={subjectOf(run)} project={project} />
          ))}
        </ul>
      ) : null}
    </section>
  )
}

function WaitingRow({ run, subject, project }: { run: Run; subject: SubjectLabel; project: ClankerProject }) {
  const actions = useAppActions()
  return (
    <li className="border-b last:border-b-0">
      <button type="button" onClick={() => actions.openRun(project.slug, run.id)} className="flex h-9 w-full items-center gap-3 px-3 text-left hover:bg-accent/60">
        <RunStatusIcon run={run} />
        <span className="w-20 flex-none truncate font-mono text-xs text-muted-foreground">{subject.key}</span>
        <span className="min-w-0 flex-1 truncate">{subject.title}</span>
        <RunStatusPill run={run} />
      </button>
    </li>
  )
}

// Una corrida que ocupa un cupo: la issue, el flujo real como stepper y qué hace el agente ahora.
function SlotCard({
  run,
  subject,
  lentBy,
  project,
  now,
}: {
  run: Run
  subject: SubjectLabel
  /** El sujeto de la corrida de dev estacionada que le prestó el suyo, si esta es un préstamo. */
  lentBy: SubjectLabel | undefined
  project: ClankerProject
  now: number
}) {
  const data = useAppData()
  const actions = useAppActions()
  const detail = useLiveQuery(`run:${run.id}`, () => data.run(run.id))
  const stepper = detail.data ? stepperOf(detail.data, now) : null
  const open = () => actions.openRun(project.slug, run.id)
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button type="button" onClick={open} className="flex w-full flex-col gap-2.5 rounded-lg border bg-card p-3 text-left hover:bg-accent/40">
          <span className="flex w-full items-center gap-2.5">
            <RunStatusIcon run={run} />
            <span className="flex-none font-mono text-xs text-muted-foreground">{subject.key}</span>
            <span className="min-w-0 flex-1 truncate font-medium">{subject.title}</span>
            {lentBy ? (
              <Pill className={tone.sky} hint={`Usa el PR y el worktree de ${lentBy.key}, cuya corrida está estacionada. Se lo devuelve al terminar.`}>
                <GitPullRequest className="size-3" />
                PR prestado de {lentBy.key}
              </Pill>
            ) : null}
            <Pill className={tone.neutral} hint={`Flujo ${run.flow.slug}, versión ${run.flow.version}. La corrida sigue con esa versión aunque el flujo cambie.`}>
              {run.flow.slug} v{run.flow.version}
            </Pill>
          </span>
          {stepper ? <FlowStepper stepper={stepper} /> : <Skeleton className="h-1.5 w-full" />}
          <span className="flex w-full items-center gap-3 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">{stepper ? whereIs(run, stepper) : " "}</span>
            <span className="flex-none tabular-nums">{elapsed(now - run.startedAt)}</span>
            <span className="flex-none text-foreground tabular-nums">{costUsd(run.costMicros)}</span>
          </span>
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
  )
}

/** Dónde va la corrida: el nodo actual y los agentes que lo trabajan. */
function whereIs(run: Run, stepper: Stepper): string {
  if (run.status === "paused") return "Pausada a mano"
  const current = stepper.items.filter((i) => i.current).map((i) => i.label)
  const where = current.length ? current.join(", ") : (stepper.items.find((i) => !i.reached)?.label ?? "terminando")
  const who = stepper.working.length ? ` (${stepper.working.join(", ")})` : ""
  const round = stepper.round > 0 ? ` · ronda ${stepper.round}` : ""
  return `${run.status === "waiting" ? "Espera en" : "Ahora"}: ${where}${who}${round}`
}

const SEGMENT: Record<string, string> = {
  done: "bg-emerald-500/70",
  failed: "bg-red-500",
  waiting: "bg-sky-500/70",
}

// El flujo real de la corrida en una línea: un segmento por nodo, en el orden en que se recorren.
function FlowStepper({ stepper }: { stepper: Stepper }) {
  return (
    <ol aria-label="Pasos del flujo" className="flex w-full gap-1">
      {stepper.items.map((item) => {
        const look = stepLook(item.status)
        const state = item.current ? "corriendo" : item.reached ? look.label : "pendiente"
        return (
          <li key={item.id} aria-current={item.current ? "step" : undefined} className="min-w-0 flex-1">
            <Hint label={`${item.label} · ${state}`}>
              <div
                data-state={item.current ? "current" : item.reached ? item.status : "pending"}
                className={cn("h-1.5 rounded-full bg-muted", item.reached && SEGMENT[item.status], item.current && "animate-blink bg-violet-500")}
              />
            </Hint>
            <span className="sr-only">
              {item.label}: {state}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
