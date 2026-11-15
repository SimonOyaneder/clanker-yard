import { Graph, layout } from "@dagrejs/dagre"
import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  MarkerType,
  type Node,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { useEffect, useMemo } from "react"
import type { OpenPr } from "@/lib/prs"
import { useColorMode } from "@/hooks/use-color-mode"
import { useHost } from "@/host"
import { buildStackForest, listStackGroups } from "@/lib/stack"
import { NODE_HEIGHT, NODE_WIDTH, PRNode, type PRNodeData } from "./pr-node"

const nodeTypes = { pr: PRNode }

/** La clave de la issue que originó el PR, con las issues de todos los proyectos. */
const issueKeyOf = (pr: OpenPr, issueKeys: ReadonlyMap<string, string>) => (pr.issueId === null ? undefined : issueKeys.get(pr.issueId))
const GROUP_GAP = 48
const MAX_ROW_WIDTH = 4 * NODE_WIDTH + 3 * GROUP_GAP

// Cada stack se ordena con dagre (de la base hacia arriba) y después los stacks se acomodan
// en filas, los más grandes primero. Con un solo dagre los PRs sueltos quedaban en una fila infinita.
function layoutStacks(prs: OpenPr[], dimmed: Set<string>, issueKeys: ReadonlyMap<string, string>): { nodes: Node<PRNodeData>[]; edges: Edge[] } {
  const forest = buildStackForest(prs)
  const groups = listStackGroups(forest)
  const nodes: Node<PRNodeData>[] = []
  let x = 0
  let y = 0
  let rowHeight = 0

  for (const group of groups) {
    const ids = new Set(group.prIds)
    const g = new Graph()
    g.setGraph({ rankdir: "TB", ranksep: 56, nodesep: 28 })
    g.setDefaultEdgeLabel(() => ({}))
    for (const id of group.prIds) g.setNode(id, { width: NODE_WIDTH, height: NODE_HEIGHT })
    for (const e of forest.edges) if (ids.has(e.childId)) g.setEdge(e.parentId, e.childId)
    layout(g)
    const width = Math.max(NODE_WIDTH, g.graph().width ?? NODE_WIDTH)
    const height = Math.max(NODE_HEIGHT, g.graph().height ?? NODE_HEIGHT)

    if (x > 0 && x + width > MAX_ROW_WIDTH) {
      x = 0
      y += rowHeight + GROUP_GAP
      rowHeight = 0
    }
    for (const id of group.prIds) {
      const p = g.node(id)
      nodes.push({
        id,
        type: "pr",
        position: { x: x + p.x - NODE_WIDTH / 2, y: y + p.y - NODE_HEIGHT / 2 },
        data: { pr: forest.byId.get(id)!, dimmed: dimmed.has(id), issueKey: issueKeyOf(forest.byId.get(id)!, issueKeys), combined: forest.combined.get(id) },
        draggable: false,
      })
    }
    x += width + GROUP_GAP
    rowHeight = Math.max(rowHeight, height)
  }

  const edges: Edge[] = forest.edges.map((e) => ({
    id: `${e.parentId}->${e.childId}`,
    source: e.parentId,
    target: e.childId,
    type: "smoothstep",
    animated: true,
    style: { stroke: "var(--primary)", strokeWidth: 1.75 },
    markerEnd: { type: MarkerType.ArrowClosed, color: "var(--primary)", width: 16, height: 16 },
  }))
  return { nodes, edges }
}

function GraphInner({ prs, dimmed, issueKeys, layoutKey }: { prs: OpenPr[]; dimmed: Set<string>; issueKeys: ReadonlyMap<string, string>; layoutKey: string }) {
  const host = useHost()
  const { nodes, edges } = useMemo(() => layoutStacks(prs, dimmed, issueKeys), [prs, dimmed, issueKeys])
  const colorMode = useColorMode()
  const { fitView } = useReactFlow()

  // Re-encuadra solo cuando cambia el conjunto de PRs (filtros), no en cada refresco de datos.
  useEffect(() => {
    requestAnimationFrame(() => void fitView({ padding: 0.12, duration: 250, maxZoom: 1 }))
  }, [layoutKey, fitView])

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      colorMode={colorMode}
      fitView
      fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
      minZoom={0.2}
      maxZoom={1.5}
      nodesConnectable={false}
      elementsSelectable={false}
      // Sin un handler de click, xyflow les pone pointer-events: none a los nodos que no se
      // seleccionan ni arrastran: el click caía en el fondo y la tarjeta nunca abría el PR.
      onNodeClick={(_e, n) => host.openExternal((n.data as PRNodeData).pr.state.url)}
      proOptions={{ hideAttribution: true }}
      className="cc-flow"
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
      <Controls position="bottom-right" showInteractive={false} />
    </ReactFlow>
  )
}

export function StackGraph({ prs, dimmed, issueKeys }: { prs: OpenPr[]; dimmed: Set<string>; issueKeys: ReadonlyMap<string, string> }) {
  const layoutKey = prs
    .map((p) => p.id)
    .sort()
    .join(",")
  return (
    <ReactFlowProvider>
      <GraphInner prs={prs} dimmed={dimmed} issueKeys={issueKeys} layoutKey={layoutKey} />
    </ReactFlowProvider>
  )
}
