import type { Decision, RunDetail } from "@clanker/api"
import { ChevronRight, MessageSquare } from "lucide-react"
import { useAppData } from "@/app-data"
import { NoteItem } from "@/components/notes"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { useLiveQuery } from "@/hooks/use-live"
import { NOTE_KINDS } from "@/lib/decisions"
import { alsoInRuns, groupByStep } from "@/lib/notes"

/**
 * "Notas del agente": lo que los pasos de la corrida reportaron sin pedir nada a nadie, agrupado por paso.
 * Viven acá y en el PR, no en la Bandeja. Colapsada: son contexto, no una tarea.
 */
export function RunNotes({ run }: { run: RunDetail }) {
  const appData = useAppData()
  const query = useLiveQuery(`run-notes:${run.id}`, () => appData.decisions({ runId: run.id, kind: NOTE_KINDS }), { on: ["decision.*"] })
  const notes: Decision[] = query.data ?? []
  const sameProject = useLiveQuery(`project-notes:${run.projectId}`, () => (run.projectId ? appData.decisions({ projectId: run.projectId, kind: NOTE_KINDS }) : Promise.resolve([])), { on: ["decision.*"] })
  if (notes.length === 0) return null
  const stepName = (id: Decision["stepRunId"]) => run.steps.find((s) => s.id === id)?.nodeId ?? "Sin paso"
  return (
    <Collapsible className="rounded-lg border bg-card">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] font-medium outline-none focus-visible:bg-muted/50">
        <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
        <MessageSquare className="size-3.5 text-sky-600 dark:text-sky-400" />
        Notas del agente
        <span className="text-xs font-normal text-muted-foreground tabular-nums">{notes.length}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 border-t px-3 py-2">
        {groupByStep(notes).map((group) => (
          <section key={group.stepRunId ?? "none"} aria-label={`Notas de ${stepName(group.stepRunId)}`}>
            <h3 className="font-mono text-xs text-muted-foreground">{stepName(group.stepRunId)}</h3>
            <ul className="divide-y">
              {group.notes.map((n) => (
                <NoteItem key={n.id} note={n} also={alsoInRuns(n, sameProject.data ?? [])} />
              ))}
            </ul>
          </section>
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}
