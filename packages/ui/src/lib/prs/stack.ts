import { Graph, layout } from "@dagrejs/dagre"
import { baseOf, branchOf, keyOf, type OpenPr } from "./prs"

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
  const byHead = new Map(prs.map((p) => [headKey(p.repo, branchOf(p)), p]))
  const edges: StackForest["edges"] = []
  const childrenOf = new Map<string, string[]>()
  const hasParent = new Set<string>()
  const combined = new Map<string, string[]>()
  for (const pr of prs) {
    const parents = new Set(pr.parents.filter((id) => byId.has(id) && id !== pr.id))
    const byBase = byHead.get(headKey(pr.repo, baseOf(pr)))
    if (byBase && byBase.id !== pr.id) parents.add(byBase.id)
    if (pr.parents.length > 1) combined.set(pr.id, pr.parents.map((id) => {
      const parent = byId.get(id)
      return parent ? keyOf(parent) : "un PR que ya no está abierto"
    }))
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
    groups.push({ rootId: rootIds[0]!, rootIds, repoFullName: root.repo, prIds })
  }
  return groups.sort((a, b) => b.prIds.length - a.prIds.length)
}

export interface StackLayoutOptions {
  /** El ancho fijo de una tarjeta. */
  width: number
  /** La altura de cada tarjeta: la medida en pantalla o, mientras no se mide, una estimada. */
  heightOf: (id: string) => number
  /** El ancho máximo de una fila de stacks. */
  maxRowWidth: number
  gap: number
}

/**
 * La esquina superior izquierda de cada PR. Cada stack se ordena con dagre (de la base hacia arriba) y después los stacks
 * se acomodan en filas, los más grandes primero: con un solo dagre los PRs sueltos quedaban en una fila infinita.
 * Las tarjetas miden distinto según sus notas, reviewers y labels, así que cada una usa su altura: con una fija las más
 * altas se montaban sobre la de abajo. Las de un mismo nivel quedan alineadas arriba.
 */
export function layoutStackGroups(forest: StackForest, groups: StackGroup[], opts: StackLayoutOptions): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()
  let x = 0
  let y = 0
  let rowHeight = 0

  for (const group of groups) {
    const ids = new Set(group.prIds)
    const g = new Graph()
    g.setGraph({ rankdir: "TB", ranksep: 56, nodesep: 28 })
    g.setDefaultEdgeLabel(() => ({}))
    for (const id of group.prIds) g.setNode(id, { width: opts.width, height: opts.heightOf(id) })
    for (const e of forest.edges) if (ids.has(e.childId)) g.setEdge(e.parentId, e.childId)
    layout(g)
    const width = Math.max(opts.width, g.graph().width ?? opts.width)
    const height = g.graph().height ?? 0

    if (x > 0 && x + width > opts.maxRowWidth) {
      x = 0
      y += rowHeight + opts.gap
      rowHeight = 0
    }
    // dagre centra cada tarjeta en su nivel: el borde de arriba del nivel es su centro menos media tarjeta más alta.
    const rankTop = new Map<number, number>()
    for (const id of group.prIds) {
      const p = g.node(id)
      rankTop.set(p.y, Math.min(rankTop.get(p.y) ?? Infinity, p.y - opts.heightOf(id) / 2))
    }
    for (const id of group.prIds) {
      const p = g.node(id)
      positions.set(id, { x: x + p.x - opts.width / 2, y: y + rankTop.get(p.y)! })
    }
    x += width + opts.gap
    rowHeight = Math.max(rowHeight, height)
  }
  return positions
}
