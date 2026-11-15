import type { OpenPr } from "./prs"

// Un PR cuelga de otro si su base es la head del otro en el mismo repo, o si el core lo registró así (`parents`,
// de `pr_parents`): ese camino cubre una base combinada, cuya rama sintética no es la head de ningún PR.
export interface StackForest {
  byId: Map<string, OpenPr>
  edges: { parentId: string; childId: string }[]
  roots: string[]
  childrenOf: Map<string, string[]>
  /** Los PRs con más de un padre: su base es una rama sintética que junta a todos (por id del hijo, con la clave de cada padre). */
  combined: Map<string, string[]>
}

export interface StackGroup {
  /** El primer PR de la base; con una base combinada, sus padres son varias raíces y `rootIds` las trae todas. */
  rootId: string
  rootIds: string[]
  repoFullName: string
  prIds: string[] // en orden de la base hacia arriba
}

const headKey = (repo: string, branch: string) => `${repo}@${branch}`

export function buildStackForest(prs: OpenPr[]): StackForest {
  const byId = new Map(prs.map((p) => [p.id, p]))
  const byHead = new Map(prs.map((p) => [headKey(p.ref.repo, p.state.headRef), p]))
  const edges: StackForest["edges"] = []
  const childrenOf = new Map<string, string[]>()
  const hasParent = new Set<string>()
  const combined = new Map<string, string[]>()
  for (const pr of prs) {
    const parents = new Set(pr.parents.filter((id) => byId.has(id) && id !== pr.id))
    const byBase = byHead.get(headKey(pr.ref.repo, pr.state.baseRef))
    if (byBase && byBase.id !== pr.id) parents.add(byBase.id)
    if (pr.parents.length > 1) combined.set(pr.id, pr.parents.map((id) => byId.get(id)?.state.key ?? "un PR que ya no está abierto"))
    for (const parentId of parents) {
      edges.push({ parentId, childId: pr.id })
      hasParent.add(pr.id)
      childrenOf.set(parentId, [...(childrenOf.get(parentId) ?? []), pr.id])
    }
  }
  const roots = prs.filter((p) => !hasParent.has(p.id)).map((p) => p.id)
  return { byId, edges, roots, childrenOf, combined }
}

/**
 * Los stacks: cada grupo de PRs unidos por algún edge, de la base hacia arriba. Una base combinada junta los stacks de
 * sus padres en uno solo (el PR hijo no puede dibujarse dos veces).
 */
export function listStackGroups(forest: StackForest): StackGroup[] {
  const component = new Map<string, string>()
  const find = (id: string): string => {
    const parent = component.get(id) ?? id
    if (parent === id) return id
    const root = find(parent)
    component.set(id, root)
    return root
  }
  for (const { parentId, childId } of forest.edges) component.set(find(childId), find(parentId))

  const roots = new Map<string, string[]>()
  for (const rootId of forest.roots) roots.set(find(rootId), [...(roots.get(find(rootId)) ?? []), rootId])

  const groups: StackGroup[] = []
  for (const [, rootIds] of roots) {
    const root = forest.byId.get(rootIds[0]!)
    if (!root) continue
    const prIds: string[] = []
    const seen = new Set<string>()
    const queue = [...rootIds]
    while (queue.length) {
      const id = queue.shift()!
      if (seen.has(id)) continue
      seen.add(id)
      prIds.push(id)
      queue.push(...(forest.childrenOf.get(id) ?? []))
    }
    groups.push({ rootId: rootIds[0]!, rootIds, repoFullName: root.ref.repo, prIds })
  }
  return groups.sort((a, b) => b.prIds.length - a.prIds.length)
}
