import { BaseEdge, type Edge, EdgeLabelRenderer, type EdgeProps, getBezierPath, getSmoothStepPath } from "@xyflow/react"

export type FlowEdgeType = Edge<{ label: string | null; curved: boolean; back: boolean }, "flow">

// La etiqueta va en HTML por encima de los nodos. La de un edge de vuelta se pega a la salida del nodo
// de origen: a la mitad de su recorrido caería sobre otros nodos.
export function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, data }: EdgeProps<FlowEdgeType>) {
  const geometry = { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }
  const [path, midX, midY] = data?.curved ? getBezierPath(geometry) : getSmoothStepPath({ ...geometry, borderRadius: 10, offset: 32 })

  const label = data?.back ? { x: sourceX + 8, y: sourceY, shift: "0px, -50%" } : { x: midX, y: midY, shift: "-50%, -50%" }

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {data?.label ? (
        <EdgeLabelRenderer>
          <span
            style={{ transform: `translate(${label.shift}) translate(${label.x}px, ${label.y}px)` }}
            className="pointer-events-none absolute z-10 rounded border bg-background px-1 text-[11px] leading-4 text-muted-foreground tabular-nums"
          >
            {data.label}
          </span>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}
