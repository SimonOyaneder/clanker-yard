import { Handle, type Node, type NodeProps, Position } from "@xyflow/react"
import { Flag, TriangleAlert } from "lucide-react"
import { Hint } from "@/components/common"
import { KIND } from "@/components/project/flow-node"
import { END_NAME, type Mark, type NodeType } from "@/lib/flow-canvas"
import { cn } from "@/lib/utils"

export interface CanvasNodeData extends Record<string, unknown> {
  id: string
  /** `end` es uno de los tres finales (`@done`...): solo recibe edges. */
  type: NodeType | "end"
  /** Rol y modo, acción, evento... lo que dice qué hace el paso. */
  detail: string | null
  isStart: boolean
  /** Es rama de un parallel: no tiene salidas propias. */
  branch: boolean
  outcomes: { name: string; connected: boolean }[]
  marks: Mark[]
  /** Los outcomes con un problema, para pintar su chip. */
  badOutcomes: string[]
}

export type CanvasFlowNode = Node<CanvasNodeData, "step">

const handle = "!size-2.5 !border !border-muted-foreground !bg-background hover:!bg-primary"

/** Un paso del flujo en el canvas de edición: cada outcome es un handle de salida y arrastrarlo a otro paso crea el edge. */
export function CanvasNode({ data, selected }: NodeProps<CanvasFlowNode>) {
  const { id, type, detail, isStart, branch, outcomes, marks, badOutcomes } = data
  const errors = marks.filter((m) => m.tone === "error")
  const flagged = marks.length > 0
  if (type === "end") {
    return (
      <div className={cn("flex h-8 w-28 items-center justify-center gap-1.5 rounded-full border bg-card text-xs", selected && "ring-2 ring-ring")}>
        <Handle type="target" position={Position.Top} className={handle} />
        <Flag className="size-3.5 text-muted-foreground" />
        {END_NAME[id as keyof typeof END_NAME]}
      </div>
    )
  }
  const { Icon, hint } = KIND[type]
  return (
    <div
      data-invalid={errors.length > 0}
      className={cn(
        "flex w-[280px] flex-col gap-1.5 rounded-lg border bg-card px-2.5 py-2 text-left shadow-xs",
        errors.length > 0 ? "border-destructive/70" : flagged && "border-amber-500/70",
        selected && "ring-2 ring-ring",
      )}
    >
      <Handle type="target" position={Position.Top} className={handle} />
      {type === "parallel" ? <Handle id="branches" type="source" position={Position.Right} isConnectable={false} className="!opacity-0" /> : null}
      <div className="flex min-w-0 items-center gap-1.5">
        <Hint label={hint}>
          <span className="flex-none">
            <Icon className="size-3.5 text-muted-foreground" aria-label={type} />
          </span>
        </Hint>
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{id}</span>
        {isStart ? <span className="flex-none rounded border px-1 text-[10.5px] text-muted-foreground">inicio</span> : null}
        {flagged ? (
          <Hint label={marks.map((m) => m.message).join(" · ")}>
            <span className="flex flex-none items-center gap-0.5 text-[11px]" role="img" aria-label={`${marks.length} ${marks.length === 1 ? "problema" : "problemas"} en ${id}`}>
              <TriangleAlert className={cn("size-3.5", errors.length > 0 ? "text-destructive" : "text-amber-600 dark:text-amber-400")} />
              {marks.length}
            </span>
          </Hint>
        ) : null}
      </div>
      <p className="truncate pl-5 font-mono text-[11px] text-muted-foreground">{detail ?? " "}</p>
      {branch ? (
        <p className="pl-5 text-[11px] text-muted-foreground">rama de un parallel</p>
      ) : (
        <ul aria-label={`Salidas de ${id}`} className="flex flex-wrap justify-around gap-x-2 gap-y-3 pb-1.5">
          {outcomes.map((o) => (
            <li
              key={o.name}
              data-bad={badOutcomes.includes(o.name)}
              className={cn(
                "relative rounded border px-1.5 text-[11px] leading-4",
                o.connected ? "bg-muted" : "border-dashed text-muted-foreground",
                badOutcomes.includes(o.name) && "border-destructive text-destructive",
              )}
            >
              {o.name}
              <Handle id={o.name} type="source" position={Position.Bottom} className={handle} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
