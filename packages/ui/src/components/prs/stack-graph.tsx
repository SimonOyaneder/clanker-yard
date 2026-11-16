import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  MarkerType,
  type Node,
  type NodeChange,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { useEffect, useMemo, useState } from "react"
import type { OpenPr } from "@/lib/prs"
import { useColorMode } from "@/hooks/use-color-mode"
import { useHost } from "@/host"
import { buildStackForest, layoutStackGroups, listStackGroups } from "@/lib/stack"
import { NODE_HEIGHT, NODE_WIDTH, PRNode, type PRNodeData } from "./pr-node"

const nodeTypes = { pr: PRNode }

/** La clave de la issue que originó el PR, con las issues de todos los proyectos. */
const issueKeyOf = (pr: OpenPr, issueKeys: ReadonlyMap<string, string>) => (pr.issueId === null ? undefined : issueKeys.get(pr.issueId))
const GROUP_GAP = 48
const MAX_ROW_WIDTH = 4 * NODE_WIDTH + 3 * GROUP_GAP

function layoutStacks(
  prs: OpenPr[],
  dimmed: Set<string>,
  issueKeys: ReadonlyMap<string, string>,
  heights: ReadonlyMap<string, number>,
): { nodes: Node<PRNodeData>[]; edges: Edge[] } {
  const forest = buildStackForest(prs)
  const positions = layoutStackGroups(forest, listStackGroups(forest), {
    width: NODE_WIDTH,
    heightOf: (id) => heights.get(id) ?? NODE_HEIGHT,
    maxRowWidth: MAX_ROW_WIDTH,
    gap: GROUP_GAP,
  })
  const nodes: Node<PRNodeData>[] = [...positions].map(([id, position]) => ({
    id,
    type: "pr",
    position,
    data: { pr: forest.byId.get(id)!, dimmed: dimmed.has(id), issueKey: issueKeyOf(forest.byId.get(id)!, issueKeys), combined: forest.combined.get(id) },
    draggable: false,
  }))

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

/** Guarda la altura que xyflow midió de cada tarjeta; devuelve el mismo mapa si nada cambió, para no re-acomodar. */
function withMeasuredHeights(prev: ReadonlyMap<string, number>, changes: NodeChange[]): ReadonlyMap<string, number> {
  let next: Map<string, number> | undefined
  for (const c of changes) {
    if (c.type !== "dimensions" || !c.dimensions) continue
    const height = Math.ceil(c.dimensions.height)
    if (prev.get(c.id) === height) continue
    next ??= new Map(prev)
    next.set(c.id, height)
  }
  return next ?? prev
}

function GraphInner({ prs, dimmed, issueKeys, layoutKey }: { prs: OpenPr[]; dimmed: Set<string>; issueKeys: ReadonlyMap<string, string>; layoutKey: string }) {
  const host = useHost()
  // Primero se dibuja con una altura estimada; cuando xyflow mide cada tarjeta, se vuelve a acomodar con la real.
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map())
  const { nodes, edges } = useMemo(() => layoutStacks(prs, dimmed, issueKeys, heights), [prs, dimmed, issueKeys, heights])
  const measured = prs.every((p) => heights.has(p.id))
  const colorMode = useColorMode()
  const { fitView } = useReactFlow()

  // Re-encuadra cuando cambia el conjunto de PRs (filtros) y cuando termina de medirlos, no en cada refresco de datos.
  useEffect(() => {
    requestAnimationFrame(() => void fitView({ padding: 0.12, duration: 250, maxZoom: 1 }))
  }, [layoutKey, measured, fitView])

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={(changes) => setHeights((prev) => withMeasuredHeights(prev, changes))}
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
