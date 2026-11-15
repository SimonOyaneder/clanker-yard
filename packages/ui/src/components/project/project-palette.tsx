import type { ClankerProject, QueueEntry } from "@clanker/api"
import { Fragment } from "react"
import { ArrowUpToLine, Ban, ChevronLeft, Gauge, Undo2 } from "lucide-react"
import { PARALLEL_OPTIONS } from "@/components/project/project-view"
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command"
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
