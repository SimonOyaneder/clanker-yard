import type { ClankerProject } from "@clanker/api"

/** Los proyectos de la barra lateral en el orden en que se ven (activos y luego pausados); ⌘1…9 los numera así. */
export const barProjects = (projects: ClankerProject[]) => [
  ...projects.filter((p) => p.status === "active"),
  ...projects.filter((p) => p.status === "paused"),
]
