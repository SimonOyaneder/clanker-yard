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
import { useEffect, useMemo, useRef, useState } from "react"
import type { OpenPr } from "@/lib/prs/prs"
import { useColorMode } from "@/hooks/use-color-mode"
import { buildStackForest, layoutStackGroups, listStackGroups } from "@/lib/prs/stack"
import { NODE_HEIGHT, NODE_WIDTH, PrNode, type PrNodeData } from "./pr-node"
import { usePrActions } from "./pr-commands"

const nodeTypes = { pr: PrNode }

/** La clave de la issue que originó el PR, con las issues de todos los proyectos. */
const issueKeyOf = (pr: OpenPr, issueKeys: ReadonlyMap<string, string>) => (pr.issueId === null ? undefined : issueKeys.get(pr.issueId))
const GROUP_GAP = 48
const MAX_ROW_WIDTH = 4 * NODE_WIDTH + 3 * GROUP_GAP

function layoutStacks(
  prs: OpenPr[],
  dimmed: Set<string>,
  issueKeys: ReadonlyMap<string, string>,
  heights: ReadonlyMap<string, number>,
  previous: Map<string, PrNodeData>,
): { nodes: Node<PrNodeData>[]; edges: Edge[] } {
  const forest = buildStackForest(prs)
  const positions = layoutStackGroups(forest, listStackGroups(forest), {
    width: NODE_WIDTH,
    heightOf: (id) => heights.get(id) ?? NODE_HEIGHT,
    maxRowWidth: MAX_ROW_WIDTH,
    gap: GROUP_GAP,
  })
  const nodes: Node<PrNodeData>[] = [...positions].map(([id, position]) => ({
    id,
    type: "pr",
    position,
    data: reuse(previous, id, { pr: forest.byId.get(id)!, dimmed: dimmed.has(id), issueKey: issueKeyOf(forest.byId.get(id)!, issueKeys), combined: forest.combined.get(id) }),
    draggable: false,
  }))

  const edges: Edge[] = forest.edges.map((e) => ({
    id: `${e.parentId}->${e.childId}`,
    source: e.parentId,
    target: e.childId,
    type: "smoothstep",
    style: { stroke: "var(--primary)", strokeWidth: 1.75 },
    markerEnd: { type: MarkerType.ArrowClosed, color: "var(--primary)", width: 16, height: 16 },
  }))
  return { nodes, edges }
}

/**
 * Los datos de la tarjeta de antes si nada de lo que muestra cambió (el PR conserva su identidad entre lecturas iguales):
 * `PrNode` es `memo` y así no se vuelve a dibujar cada tarjeta cuando cambia un solo PR o se re-acomoda el grafo.
 */
function reuse(previous: Map<string, PrNodeData>, id: string, next: PrNodeData): PrNodeData {
  const old = previous.get(id)
  const same =
    old !== undefined && old.pr === next.pr && old.dimmed === next.dimmed && old.issueKey === next.issueKey && old.combined?.join() === next.combined?.join()
  const data = same ? old : next
  previous.set(id, data)
  return data
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
  const commands = usePrActions()
  const previous = useRef(new Map<string, PrNodeData>())
  // Primero se dibuja con una altura estimada; cuando xyflow mide cada tarjeta, se vuelve a acomodar con la real.
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map())
  const { nodes, edges } = useMemo(() => layoutStacks(prs, dimmed, issueKeys, heights, previous.current), [prs, dimmed, issueKeys, heights])
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
      onNodeClick={(e, n) => {
        const { pr } = n.data as PrNodeData
        commands.open(pr, e.metaKey)
      }}
      proOptions={{ hideAttribution: true }}
      className="flow-canvas"
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
