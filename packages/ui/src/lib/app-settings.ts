import type { PackInfo, ProjectDefaults, ProjectDefaultsPatch, Repo } from "@clanker/api"
import { maxCostProblem, parallelProblem, type FieldProblems } from "@/lib/project-settings"

/** Los defaults de proyectos nuevos tal como se editan: `parallel` y `maxCostUsd` son el texto de su campo. */
export interface DefaultsDraft {
  defaultFlowId: string | null
  defaultProfileId: string | null
  parallel: string
  maxCostUsd: string
}

export function draftOfDefaults(defaults: ProjectDefaults): DefaultsDraft {
  return {
    defaultFlowId: defaults.defaultFlowId,
    defaultProfileId: defaults.defaultProfileId,
    parallel: String(defaults.parallel),
    maxCostUsd: defaults.maxCostUsd === null ? "" : String(defaults.maxCostUsd),
  }
}

export const sameDefaults = (a: DefaultsDraft, b: DefaultsDraft) =>
  a.defaultFlowId === b.defaultFlowId && a.defaultProfileId === b.defaultProfileId && a.parallel.trim() === b.parallel.trim() && a.maxCostUsd.trim() === b.maxCostUsd.trim()

export function defaultsProblems(draft: DefaultsDraft): FieldProblems {
  const problems: FieldProblems = {}
  const parallel = parallelProblem(draft.parallel)
  if (parallel) problems.parallel = parallel
  const cost = maxCostProblem(draft.maxCostUsd)
  if (cost) problems.maxCostUsd = cost
  return problems
}

/** Solo lo que cambió respecto de `base`. */
export function defaultsPatch(draft: DefaultsDraft, base: DefaultsDraft): ProjectDefaultsPatch {
  const patch: ProjectDefaultsPatch = {}
  if (draft.defaultFlowId !== base.defaultFlowId) patch.defaultFlowId = draft.defaultFlowId
  if (draft.defaultProfileId !== base.defaultProfileId) patch.defaultProfileId = draft.defaultProfileId
  if (draft.parallel.trim() !== base.parallel.trim()) patch.parallel = Number(draft.parallel)
  if (draft.maxCostUsd.trim() !== base.maxCostUsd.trim()) patch.maxCostUsd = draft.maxCostUsd.trim() === "" ? null : Number(draft.maxCostUsd)
  return patch
}

/** Cómo se llama cada campo de los defaults en el aviso de "guardado". */
export const DEFAULTS_FIELD_LABELS = {
  defaultFlowId: "flujo",
  defaultProfileId: "perfil",
  parallel: "corridas a la vez",
  maxCostUsd: "tope de gasto",
} as const satisfies Record<keyof ProjectDefaults, string>

/** Lo que pisa el patch con lo que había antes, para deshacer el guardado. */
export function undoDefaults(before: ProjectDefaults, patch: ProjectDefaultsPatch): ProjectDefaultsPatch {
  return Object.fromEntries(Object.keys(patch).map((field) => [field, before[field as keyof ProjectDefaults]]))
}

/** Un pack cubre a una org de GitHub si la lista en su alcance, sin distinguir mayúsculas. */
const covers = (pack: PackInfo, org: string) => (pack.activate.githubOrgs ?? []).some((o) => o.toLowerCase() === org.toLowerCase())

/** Las orgs de GitHub con repos registrados que ningún pack activo cubre, con los nombres de esos repos. Un repo sin remoto de GitHub no tiene org. */
export function orgsWithoutPack(repos: readonly Repo[], packs: readonly PackInfo[]): { org: string; repos: string[] }[] {
  const byOrg = new Map<string, string[]>()
  for (const repo of repos) {
    const org = repo.remote?.split("/")[0]
    if (!org || packs.some((p) => covers(p, org))) continue
    byOrg.set(org, [...(byOrg.get(org) ?? []), repo.name])
  }
  return [...byOrg].map(([org, names]) => ({ org, repos: names }))
}
