import type { OpenPr } from "./prs"
import type { StackGroup } from "./stack"

/** Lo que la lista necesita de un proyecto para titular su grupo. */
export interface PrProject {
  id: string
  name: string
}

export interface ProjectPrGroup {
  /** `null` agrupa los PRs que no salen de una issue de un proyecto (los que descubrió la búsqueda de tus PRs). */
  project: PrProject | null
  groups: StackGroup[]
  prCount: number
}

/**
 * Reparte los stacks y PRs sueltos por el proyecto de la issue que los originó. Un stack va entero al proyecto del
 * primer PR con proyecto, de la base hacia arriba: un stack no se parte entre dos grupos. Los proyectos salen por
 * nombre y los PRs sin proyecto al final.
 */
export function groupByProject(groups: readonly StackGroup[], byId: ReadonlyMap<string, OpenPr>, issueProjects: ReadonlyMap<string, PrProject>): ProjectPrGroup[] {
  const buckets = new Map<string | null, ProjectPrGroup>()
  for (const group of groups) {
    const project = group.prIds.map((id) => byId.get(id)?.issueId).map((issueId) => (issueId ? issueProjects.get(issueId) : undefined)).find((p) => p !== undefined) ?? null
    const key = project?.id ?? null
    const bucket = buckets.get(key) ?? { project, groups: [], prCount: 0 }
    bucket.groups.push(group)
    bucket.prCount += group.prIds.length
    buckets.set(key, bucket)
  }
  return [...buckets.values()].sort((a, b) => (a.project === null ? 1 : b.project === null ? -1 : a.project.name.localeCompare(b.project.name)))
}
