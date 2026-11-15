import type { PullRequest } from "@/types"

// Portado de stack-pr: un PR cuelga de otro si su base es la head del otro, en el mismo repo.
export interface StackForest {
  byId: Map<number, PullRequest>
  edges: { parentId: number; childId: number }[]
  roots: number[]
  childrenOf: Map<number, number[]>
}

export interface StackGroup {
  rootId: number
  repoFullName: string
  prIds: number[] // en orden de la base hacia arriba
}

const headKey = (repo: string, branch: string) => `${repo}@${branch}`

export function buildStackForest(prs: PullRequest[]): StackForest {
  const byId = new Map(prs.map((p) => [p.id, p]))
  const byHead = new Map(prs.map((p) => [headKey(p.repoFullName, p.headRef), p]))
  const edges: StackForest["edges"] = []
  const childrenOf = new Map<number, number[]>()
  const hasParent = new Set<number>()
  for (const pr of prs) {
    const parent = byHead.get(headKey(pr.repoFullName, pr.baseRef))
    if (!parent || parent.id === pr.id) continue
    edges.push({ parentId: parent.id, childId: pr.id })
    hasParent.add(pr.id)
    childrenOf.set(parent.id, [...(childrenOf.get(parent.id) ?? []), pr.id])
  }
  const roots = prs.filter((p) => !hasParent.has(p.id)).map((p) => p.id)
  return { byId, edges, roots, childrenOf }
}

export function listStackGroups(forest: StackForest): StackGroup[] {
  const groups: StackGroup[] = []
  for (const rootId of forest.roots) {
    const root = forest.byId.get(rootId)
    if (!root) continue
    const prIds: number[] = []
    const queue = [rootId]
    while (queue.length) {
      const id = queue.shift()!
      prIds.push(id)
      queue.push(...(forest.childrenOf.get(id) ?? []))
    }
    groups.push({ rootId, repoFullName: root.repoFullName, prIds })
  }
  return groups.sort((a, b) => b.prIds.length - a.prIds.length)
}
