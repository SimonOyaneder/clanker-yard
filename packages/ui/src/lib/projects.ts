import type { ClankerProject } from "@clanker/api"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Un proyecto de Linear que no guarda el id (un UUID) de su proyecto sino otra cosa, como los creados antes de elegirlo
 * de una lista: el core no puede leer su cola hasta que se elija de nuevo en Ajustes.
 */
export const needsTrackerProject = (project: Pick<ClankerProject, "tracker" | "trackerRef">): boolean => project.tracker === "linear" && !UUID.test(project.trackerRef)

/** Los proyectos de la barra lateral en el orden en que se ven (activos y luego pausados); ⌘1…9 los numera así. */
export const barProjects = (projects: ClankerProject[]) => [
  ...projects.filter((p) => p.status === "active"),
  ...projects.filter((p) => p.status === "paused"),
]
