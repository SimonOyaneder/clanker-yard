import { useMemo } from "react"
import { toast } from "sonner"
import type { RunId } from "@clanker/api"
import { useAppData } from "@/app-data"
import { useLive } from "@/hooks/use-live"
import type { AppActions } from "@/lib/app-context"
import { issueKey } from "@/lib/format"
import { undoable } from "@/lib/undoable"
import { messageOf } from "@/lib/utils"

// Las acciones de `AppActions` no devuelven nada: el fallo ya salió en el toast.
const reversible = async (...args: Parameters<typeof undoable>): Promise<void> => void (await undoable(...args))

export type ProjectActions = Pick<AppActions, "startRun" | "setParallel" | "setLanes" | "skipIssue" | "boostIssue">

/**
 * Lo que una persona le cambia a un proyecto desde la app: lanzar una issue, los cupos y la cola. Lo que se puede
 * deshacer sale con un toast "Deshacer" (`undoable`). `openRun` abre la corrida recién lanzada.
 */
export function useProjectActions(openRun: (slug: string, runId: RunId) => void): ProjectActions {
  const appData = useAppData()
  const live = useLive()
  return useMemo<ProjectActions>(
    () => ({
      startRun: async (p, issue) => {
        try {
          const started = await appData.startRun({ projectId: p.id, issueId: issue.id })
          toast.success(`Corrida lanzada para ${issueKey(issue)}`, { action: { label: "Ver", onClick: () => openRun(p.slug, started.id) } })
        } catch (e) {
          toast.error(messageOf(e))
        }
      },
      setParallel: (p, parallel) =>
        reversible(
          `${p.name}: ${parallel} ${parallel === 1 ? "corrida" : "corridas"} a la vez en dev`,
          () => appData.updateProject({ id: p.id, parallel }),
          () => appData.updateProject({ id: p.id, parallel: p.parallel }),
        ),
      setLanes: async (lane, capacity, from) => {
        const apply = (n: number) => appData.setLanes({ [lane]: n }).then(live.refresh)
        await reversible(
          `${lane === "dev" ? "Carril dev" : "Carril mantenimiento"}: ${capacity} ${capacity === 1 ? "cupo" : "cupos"} en la máquina`,
          () => apply(capacity),
          () => apply(from),
        )
      },
      skipIssue: (p, issue, skipped) =>
        reversible(
          skipped ? `No tomaré ${issueKey(issue)}` : `${issueKey(issue)} vuelve a la cola`,
          () => appData.skipIssue({ id: p.id, issueId: issue.id, skipped }),
          () => appData.skipIssue({ id: p.id, issueId: issue.id, skipped: !skipped }),
        ),
      boostIssue: (p, issue) =>
        reversible(
          `${issueKey(issue)} sube al principio de la cola`,
          () => appData.boostIssue({ id: p.id, issueId: issue.id, boosted: true }),
          () => appData.boostIssue({ id: p.id, issueId: issue.id, boosted: false }),
        ),
    }),
    [appData, live, openRun],
  )
}
