import type { ClankerProject } from "@clanker/api"
import { useAppData } from "@/app-data"
import { useLiveQuery } from "@/hooks/use-live"
import { ACTIONABLE_KINDS } from "@/lib/decisions"
import { messageOf } from "@/lib/utils"

/**
 * Lo que la vista de Operación de un proyecto muestra, y que la paleta y el encabezado de una corrida también leen:
 * sus corridas, issues, cola, decisiones pendientes, carriles, breakers y PRs. Se relee con los eventos en vivo.
 */
export function useProjectData(project: ClankerProject | null) {
  const appData = useAppData()
  return useLiveQuery(project ? `project:${project.id}` : "no-project", async () => {
    if (!project) return null
    const [runs, issues, queue, decisions, lanes, breakers, prs] = await Promise.all([
      appData.runs({ projectId: project.id }),
      appData.issues(project.id),
      // Una cola que no se puede calcular (el tracker sin cuenta conectada) no esconde el resto de la operación.
      appData.queue(project.id).then(
        (entries) => ({ queue: entries }),
        (e: unknown) => ({ queue: [], queueError: messageOf(e) }),
      ),
      appData.decisions({ projectId: project.id, status: ["pending"], kind: ACTIONABLE_KINDS }),
      appData.lanes(),
      appData.breakers(),
      appData.openPrs(),
    ])
    return { runs, issues, ...queue, decisions, lanes, breakers, prs }
  })
}
