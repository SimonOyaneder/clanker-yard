import { Handle, type NodeProps, Position } from "@xyflow/react"
import { Bot, CircleCheck, Flag, GitFork, Hand, Hourglass, Merge, Terminal, Workflow, type LucideIcon } from "lucide-react"
import { Hint, Pill } from "@/components/common"
import { stepLook } from "@/components/project/status"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu"
import { copy } from "@/lib/clipboard"
import { costUsd, elapsed, tone } from "@/lib/format"
import { boxSize, type GraphNode, type GraphNodeKind, type NodeState } from "@/lib/run-graph"
import { cn } from "@/lib/utils"

export interface FlowNodeData extends Record<string, unknown> {
  node: GraphNode
  state: NodeState
}

const KIND: Record<GraphNodeKind, { Icon: LucideIcon; hint: string }> = {
  agent: { Icon: Bot, hint: "Agente: un rol del flujo trabaja en el worktree y entrega un reporte." },
  action: { Icon: Terminal, hint: "Acción: código del core que corre sin agente (checks, git, publicar)." },
  parallel: { Icon: GitFork, hint: "Parallel: lanza sus ramas a la vez y espera a todas." },
  join: { Icon: Merge, hint: "Join: junta los resultados de las ramas en uno solo." },
  wait: { Icon: Hourglass, hint: "Espera un evento externo (un review, el CI) sin ocupar un agente." },
  flow: { Icon: Workflow, hint: "Subflujo: corre otro flujo completo y sigue con su resultado." },
  gate: { Icon: Hand, hint: "Gate: espera la decisión de una persona." },
  end: { Icon: Flag, hint: "Cómo termina la corrida." },
}

// Un nodo del flujo en solo lectura. El editor de flujos usa este mismo componente con otro `data`.
export function FlowNode({ data, selected }: NodeProps & { data: FlowNodeData }) {
  const { node, state } = data
  const { Icon, hint } = KIND[node.kind]
  const look = stepLook(state.status)
  const reached = state.visits > 0
  const { width, height } = boxSize(node.kind)

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-state={reached ? state.status : "pending"}
          data-current={state.current}
          style={{ width, minHeight: height }}
          className={cn(
            "flex flex-col justify-center gap-1 rounded-lg border bg-card px-2.5 py-2 text-left shadow-xs select-none",
            node.kind === "end" && "items-center rounded-full",
            !reached && node.kind !== "end" && "border-dashed bg-card/60 text-muted-foreground",
            state.status === "failed" && "border-destructive/60",
            state.current && "cc-pulse border-primary",
            selected && "ring-2 ring-ring",
          )}
        >
          <Handle type="target" position={Position.Top} isConnectable={false} className="!opacity-0" />
          <Handle type="source" position={Position.Bottom} isConnectable={false} className="!opacity-0" />
          <Handle id="back-in" type="target" position={Position.Right} isConnectable={false} className="!opacity-0" />
          <Handle id="back-out" type="source" position={Position.Right} isConnectable={false} className="!opacity-0" />

          {node.kind === "end" ? (
            <EndMarker node={node} reached={state.status === "done"} />
          ) : (
            <>
              <div className="flex min-w-0 items-center gap-1.5">
                <Hint label={hint}>
                  <span className="flex-none">
                    <Icon className="size-3.5 text-muted-foreground" aria-label={node.kind} />
                  </span>
                </Hint>
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-foreground">{node.label}</span>
                {reached ? <Tags state={state} /> : null}
                <Hint label={reached ? look.hint : "El flujo todavía no llega a este nodo."}>
                  <span className="flex-none">
                    <look.Icon aria-label={reached ? look.label : "pendiente"} className={cn("size-3.5", look.iconClass, look.pulse && "cc-blink")} />
                  </span>
                </Hint>
              </div>
              <div className="flex min-w-0 items-center gap-2 pl-5 text-[11px] tabular-nums">
                <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{node.detail}</span>
                {reached ? <Numbers state={state} /> : null}
              </div>
              {state.error ? (
                <Hint label={state.error}>
                  <span className="truncate pl-5 text-[11px] text-red-700 dark:text-red-300">{state.error}</span>
                </Hint>
              ) : null}
            </>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={() => copy(node.label, "el nodo")}>Copiar nombre del nodo</ContextMenuItem>
        <ContextMenuItem disabled={!state.stepId} onSelect={() => state.stepId && copy(state.stepId, "el ID del paso")}>
          Copiar ID del paso
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function EndMarker({ node, reached }: { node: GraphNode; reached: boolean }) {
  return (
    <Hint label={reached ? "La corrida terminó así." : "Así terminaría la corrida si el flujo llega aquí."}>
      <span className={cn("flex items-center gap-1.5 text-xs", reached ? "font-medium text-foreground" : "text-muted-foreground")}>
        {reached ? <CircleCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" /> : null}
        {node.label}
      </span>
    </Hint>
  )
}

function Tags({ state }: { state: NodeState }) {
  const small = cn("h-4 px-1.5 text-[10.5px]")
  return (
    <span className="flex flex-none items-center gap-1">
      {state.outcome ? (
        <Pill className={cn(tone.sky, small)} hint="Resultado del paso: decide qué edge sigue el flujo.">
          {state.outcome}
        </Pill>
      ) : null}
      {state.round > 0 ? (
        <Pill className={cn(tone.neutral, small)} hint="Ronda de la vuelta en que corrió por última vez.">
          ronda {state.round}
        </Pill>
      ) : null}
      {state.visits > 1 ? (
        <Pill className={cn(tone.neutral, small)} hint={`El flujo entró a este nodo ${state.visits} veces.`}>
          ×{state.visits}
        </Pill>
      ) : null}
    </span>
  )
}

function Numbers({ state }: { state: NodeState }) {
  return (
    <span className="flex flex-none items-center gap-1.5 text-muted-foreground">
      {state.costMicros > 0 ? <span>{costUsd(state.costMicros)}</span> : null}
      {state.durationMs !== null ? <span>{elapsed(state.durationMs)}</span> : null}
    </span>
  )
}
