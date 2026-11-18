import type { ClankerProject, QueueEntry } from "@clanker/api"
import { Fragment } from "react"
import { ArrowUpToLine, Ban, ChevronLeft, Gauge, Minus, Plus, Undo2 } from "lucide-react"
import { BELOW_USE, LANE_NAME } from "@/components/project/lanes-control"
import { PARALLEL_OPTIONS } from "@/components/project/project-view"
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command"
import { useAppData } from "@/app-data"
import { useLiveQuery } from "@/hooks/use-live"
import { useAppActions } from "@/lib/app-context"
import { issueKey } from "@/lib/format"

interface ParallelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: ClankerProject
  onBack: () => void
}

// La sub-página "Cambiar paralelismo ›" de ⌘K: elegir 1 a 6 cambia el cupo del carril dev del proyecto.
export function ParallelPage({ open, onOpenChange, project, onBack }: ParallelProps) {
  const actions = useAppActions()
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Cambiar paralelismo" description="Cuántas corridas del carril dev puede tener el proyecto a la vez">
      <CommandInput placeholder="Cuántas corridas a la vez en dev…" />
      <CommandList className="max-h-[420px]">
        <CommandEmpty>Sin resultados.</CommandEmpty>
        <CommandGroup heading={`Paralelismo de ${project.name}`}>
          <CommandItem value="volver" onSelect={onBack}>
            <ChevronLeft /> Volver
          </CommandItem>
          {PARALLEL_OPTIONS.map((n) => (
            <CommandItem
              key={n}
              value={`paralelismo ${n}`}
              onSelect={() => {
                onOpenChange(false)
                void actions.setParallel(project, n)
              }}
            >
              <Gauge /> {n} {n === 1 ? "corrida" : "corridas"} a la vez
              {n === project.parallel ? <CommandShortcut>actual</CommandShortcut> : null}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}

// La sub-página "Cambiar capacidad de carriles ›" de ⌘K: sube o baja en 1 el tope de cada carril de la máquina.
export function LanesPage({ open, onOpenChange, onBack }: { open: boolean; onOpenChange: (open: boolean) => void; onBack: () => void }) {
  const actions = useAppActions()
  const data = useAppData()
  const { data: lanes } = useLiveQuery("lanes", () => data.lanes(), { on: ["lanes.changed", "run.*"] })
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Cambiar capacidad de carriles" description="Cuántas corridas caben a la vez en cada carril de la máquina">
      <CommandInput placeholder="Subir o bajar un carril…" />
      <CommandList className="max-h-[420px]">
        <CommandEmpty>Sin resultados.</CommandEmpty>
        <CommandGroup heading="Capacidad de los carriles (tope de la máquina; el parallel es el de cada proyecto)">
          <CommandItem value="volver" onSelect={onBack}>
            <ChevronLeft /> Volver
          </CommandItem>
          {lanes
            ? (["dev", "maintenance"] as const).flatMap((lane) => {
                const { capacity, active } = lanes[lane]
                const change = (to: number) => () => {
                  onOpenChange(false)
                  void actions.setLanes(lane, to, capacity)
                }
                const state = `${capacity} ahora, en uso ${active}`
                return [
                  <CommandItem key={`${lane}-up`} value={`subir ${LANE_NAME[lane]}`} onSelect={change(capacity + 1)}>
                    <Plus /> Subir {LANE_NAME[lane].toLowerCase()} a {capacity + 1}
                    <CommandShortcut>{state}</CommandShortcut>
                  </CommandItem>,
                  capacity > 1 ? (
                    <CommandItem key={`${lane}-down`} value={`bajar ${LANE_NAME[lane]}`} onSelect={change(capacity - 1)}>
                      <Minus /> Bajar {LANE_NAME[lane].toLowerCase()} a {capacity - 1}
                      <CommandShortcut>{capacity - 1 < active ? BELOW_USE : state}</CommandShortcut>
                    </CommandItem>
                  ) : null,
                ]
              })
            : null}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}

// Subir en la cola, no tomar o devolver cada issue de la cola del proyecto. `run` cierra la paleta y hace la acción.
export function QueueCommands({ project, queue, run }: { project: ClankerProject; queue: readonly QueueEntry[]; run: (fn: () => void) => () => void }) {
  const actions = useAppActions()
  if (!queue.length) return null
  return (
    <CommandGroup heading="Cola del proyecto">
      {queue.map((entry) => {
        const { issue } = entry
        const label = (
          <>
            <span className="w-[68px] flex-none truncate font-mono text-[11.5px] text-muted-foreground">{issueKey(issue)}</span>
            <span className="truncate">{issue.title}</span>
          </>
        )
        const skipped = entry.state === "blocked" && entry.skipped === true
        return (
          <Fragment key={issue.id}>
            {entry.state !== "blocked" ? (
              <CommandItem value={`subir en la cola ${issueKey(issue)} ${issue.title}`} onSelect={run(() => void actions.boostIssue(project, issue))}>
                <ArrowUpToLine /> Subir {label}
              </CommandItem>
            ) : null}
            {skipped ? (
              <CommandItem value={`volver a la cola ${issueKey(issue)} ${issue.title}`} onSelect={run(() => void actions.skipIssue(project, issue, false))}>
                <Undo2 /> Volver a la cola {label}
              </CommandItem>
            ) : (
              <CommandItem value={`no tomar ${issueKey(issue)} ${issue.title}`} onSelect={run(() => void actions.skipIssue(project, issue, true))}>
                <Ban /> No tomar {label}
              </CommandItem>
            )}
          </Fragment>
        )
      })}
    </CommandGroup>
  )
}
