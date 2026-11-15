import type { RunDetail, StepRunId } from "@clanker/api"
import { Background, BackgroundVariant, Controls, MarkerType, type Node, ReactFlow, ReactFlowProvider, useReactFlow, useStore } from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { useEffect, useMemo } from "react"
import { FlowEdge, type FlowEdgeType } from "@/components/project/flow-edge"
import { FlowNode, type FlowNodeData } from "@/components/project/flow-node"
import { useColorMode } from "@/hooks/use-color-mode"
import { layoutShape, nodeStates, roundsOf, type GraphEdge, type GraphShape, type NodeState } from "@/lib/run-graph"

const nodeTypes = { flow: FlowNode }
const edgeTypes = { flow: FlowEdge }

const STROKE = { taken: "var(--muted-foreground)", idle: "var(--input)", active: "var(--primary)" } as const

function edgeOf(e: GraphEdge, run: RunDetail, states: Map<string, NodeState>): FlowEdgeType {
  const from = states.get(e.from)
  const to = states.get(e.to)
  const active = !!to?.current && (from?.visits ?? 0) > 0
  const taken = (from?.visits ?? 0) > 0 && (to?.visits ?? 0) > 0
  const color = active ? STROKE.active : taken ? STROKE.taken : STROKE.idle
  const rounds = roundsOf(e, run)
  const label = rounds
    ? `${e.back ? "↑ " : ""}${e.label ?? "ok"} ${rounds.taken}${rounds.max === null ? "" : `/${rounds.max}`}`
    : e.label
  return {
    id: e.id,
    type: "flow",
    source: e.from,
    target: e.to,
    sourceHandle: e.back ? "back-out" : undefined,
    targetHandle: e.back ? "back-in" : undefined,
    animated: active,
    // Las ramas salen y entran en abanico (curvas); el resto va en ángulos rectos, y las vueltas por el costado.
    data: { label, curved: e.branch, back: e.back },
    style: { stroke: color, strokeWidth: taken || active ? 1.75 : 1.25, strokeDasharray: e.exhausted || e.back ? "5 4" : undefined },
    markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
  }
}

interface Selection {
  /** El nodo cuyo panel está abierto. */
  selected: string | null
  onSelect: (nodeId: string) => void
  onCopySessionId: (stepId: StepRunId) => void
}

function toFlow(shape: GraphShape, run: RunDetail, now: number, { selected, onSelect, onCopySessionId }: Selection): { nodes: Node<FlowNodeData>[]; edges: FlowEdgeType[] } {
  const boxes = layoutShape(shape)
  const states = nodeStates(shape, run, now)
  return {
    nodes: shape.nodes.map((node) => {
      const box = boxes.get(node.id)!
      const state = states.get(node.id)!
      return {
        id: node.id,
        type: "flow",
        position: { x: box.x, y: box.y },
        width: box.width,
        height: box.height,
        data: {
          node,
          state,
          onOpen: node.kind === "end" ? undefined : () => onSelect(node.id),
          onCopySessionId: state.stepId ? () => onCopySessionId(state.stepId!) : undefined,
        },
        selected: node.id === selected,
        draggable: false,
        connectable: false,
      }
    }),
    edges: shape.edges.map((e) => edgeOf(e, run, states)),
  }
}

// Al cambiar el ancho del lienzo (se abre el panel del paso, se arrastra su borde) el flujo vuelve a caber.
function FitOnResize() {
  const { fitView } = useReactFlow()
  const width = useStore((s) => s.width)
  useEffect(() => {
    void fitView({ padding: 0.1, maxZoom: 1, duration: 150 })
  }, [width, fitView])
  return null
}

// La corrida como el grafo de su flujo, sea cual sea: solo lectura. Un clic (o ⏎ sobre el nodo enfocado)
// abre el panel de su paso.
export function RunGraph({ run, now, shape, selected, onSelect, onCopySessionId }: { run: RunDetail; now: number; shape: GraphShape } & Selection) {
  const colorMode = useColorMode()
  const { nodes, edges } = useMemo(() => toFlow(shape, run, now, { selected, onSelect, onCopySessionId }), [shape, run, now, selected, onSelect, onCopySessionId])

  return (
    <div
      className="h-full overflow-hidden rounded-lg border"
      role="group"
      aria-label={`Grafo del flujo ${run.flow.slug}`}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return
        const id = (e.target as HTMLElement).closest(".react-flow__node")?.getAttribute("data-id")
        if (id) onSelect(id)
      }}
    >
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          colorMode={colorMode}
          fitView
          fitViewOptions={{ padding: 0.1, maxZoom: 1 }}
          minZoom={0.2}
          maxZoom={1.5}
          nodesConnectable={false}
          nodesDraggable={false}
          onNodeClick={(_, node) => node.data.node.kind !== "end" && onSelect(node.id)}
          proOptions={{ hideAttribution: true }}
          className="cc-flow"
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
          <Controls position="bottom-right" showInteractive={false} />
          <FitOnResize />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  )
}
