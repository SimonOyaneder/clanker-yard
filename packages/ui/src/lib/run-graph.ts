import { Graph, layout } from "@dagrejs/dagre"
import type { FlowDef, Edge as FlowEdge, Node as FlowNodeDef, RunDetail, Step, StepRunId, StepStatus } from "@clanker/api"

// El grafo de una corrida: el `FlowDef` que fijó la corrida (nodos y edges) más el estado de sus
// `step_runs`. Nada aquí conoce nombres de roles, acciones ni nodos: todo sale del flujo.

export type GraphNodeKind = "agent" | "action" | "parallel" | "join" | "wait" | "flow" | "gate" | "end"

export interface GraphNode {
  id: string
  kind: GraphNodeKind
  label: string
  /** Rol y modo, acción, evento, subflujo... lo que dice qué hace el nodo. */
  detail: string | null
}

export interface GraphEdge {
  id: string
  from: string
  to: string
  /** El outcome que toma este edge (`ok` no se rotula). */
  label: string | null
  /** Vuelve a un nodo anterior del flujo. */
  back: boolean
  /** El edge de salida cuando se agotan las rondas del que vuelve. */
  exhausted: boolean
  /** Del parallel a una rama, o de una rama a su join. */
  branch: boolean
  /** Solo un edge que cuenta rondas: su contador y el tope (un número o `$run.params.x`). */
  rounds: { key: string; max: number | string | undefined } | null
}

export interface GraphShape {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export const END_LABEL = { "@done": "listo", "@blocked": "bloqueado", "@failed": "falló" } as const
const END_OUTCOME = { "@done": "done", "@blocked": "blocked", "@failed": "failed" } as const

export const joinId = (parallelId: string) => `${parallelId}#join`
const INLINE_BRANCH = /^(.+)\[(\d+)\]$/
const PARAM_PREFIX = "$run.params."

/** Los ids `nodo[i]` que un `forEach` ya creó en la corrida, por parallel y en orden. */
function inlineBranches(steps: readonly Step[]): Map<string, string[]> {
  const found = new Map<string, Map<number, string>>()
  for (const step of steps) {
    const match = INLINE_BRANCH.exec(step.nodeId)
    if (!match) continue
    const byIndex = found.get(match[1]!) ?? new Map<number, string>()
    byIndex.set(Number(match[2]), step.nodeId)
    found.set(match[1]!, byIndex)
  }
  return new Map([...found].map(([parent, byIndex]) => [parent, [...byIndex].sort(([a], [b]) => a - b).map(([, id]) => id)]))
}

function describe(node: FlowNodeDef): { kind: GraphNodeKind; detail: string | null } {
  switch (node.type) {
    case "agent":
      return { kind: "agent", detail: `${node.role} · ${node.mode}` }
    case "action":
      return { kind: "action", detail: node.action }
    case "wait":
      return { kind: "wait", detail: node.event }
    case "flow":
      return { kind: "flow", detail: node.flow }
    case "gate":
      return { kind: "gate", detail: null }
    case "parallel":
      return { kind: "parallel", detail: Array.isArray(node.branches) ? `${node.branches.length} ramas` : "una rama por ítem" }
  }
}

function joinDetail(node: Extract<FlowNodeDef, { type: "parallel" }>): string {
  const { join } = node
  if (join === undefined) return "worst"
  if (typeof join === "string") return join
  return "fn" in join ? join.fn : `${join.role} · ${join.mode}`
}

/** Nodos y edges del flujo. Un parallel se dibuja como su nodo, sus ramas y un join que concentra sus edges de salida. */
export function shapeOf(def: FlowDef, steps: readonly Step[] = []): GraphShape {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const inline = inlineBranches(steps)
  const ends = new Set<string>()

  const connect = (from: string, to: string, extra: Partial<GraphEdge> & { label: string | null }) => {
    if (to.startsWith("@")) ends.add(to)
    const id = `${from}:${extra.label ?? "ok"}${extra.exhausted ? ":exhausted" : ""}->${to}`
    edges.push({ id, from, to, back: false, exhausted: false, branch: false, rounds: null, ...extra })
  }

  const exits = (from: string, node: FlowNodeDef, id: string) => {
    for (const [outcome, edge] of Object.entries(node.on ?? {})) {
      const spec: Exclude<FlowEdge, string> = typeof edge === "string" ? { to: edge } : edge
      const counts = spec.maxRounds !== undefined || spec.counter !== undefined
      connect(from, spec.to, {
        label: outcome === "ok" ? null : outcome,
        rounds: counts ? { key: spec.counter ?? `${id}.${outcome}`, max: spec.maxRounds } : null,
      })
      if (spec.exhausted !== undefined) {
        connect(from, typeof spec.exhausted === "string" ? spec.exhausted : spec.exhausted.to, { label: "agotado", exhausted: true })
      }
    }
  }

  for (const [id, node] of Object.entries(def.nodes)) {
    nodes.push({ id, label: id, ...describe(node) })
    if (node.type !== "parallel") {
      exits(id, node, id)
      continue
    }
    const join = joinId(id)
    nodes.push({ id: join, kind: "join", label: "join", detail: joinDetail(node) })
    let branches: string[]
    if (Array.isArray(node.branches)) {
      branches = node.branches
    } else {
      // La plantilla de un forEach corre una vez por ítem: hasta que haya pasos se dibuja una sola.
      branches = inline.get(id) ?? [`${id}[…]`]
      for (const branch of branches) nodes.push({ id: branch, label: branch, ...describe(node.branches.branch) })
    }
    for (const branch of branches) {
      connect(id, branch, { label: null, branch: true })
      connect(branch, join, { label: null, branch: true })
    }
    exits(join, node, id)
  }
  for (const end of ends) nodes.push({ id: end, kind: "end", label: END_LABEL[end as keyof typeof END_LABEL] ?? end, detail: null })

  // Agotar las rondas hacia el mismo nodo al que ya va el edge de salida no suma otra línea.
  const kept = edges.filter((e) => !e.exhausted || !edges.some((o) => !o.exhausted && o.from === e.from && o.to === e.to))
  markBackEdges(def.start, nodes, kept)
  return { nodes, edges: kept }
}

// Un edge vuelve atrás si su destino está a la misma distancia del inicio, o a una menor, que su origen:
// así `reviews → fix` (mismo nivel que `fix`, al que llega `checks`) y `fix → checks` se leen como vueltas.
function markBackEdges(start: string, nodes: readonly GraphNode[], edges: GraphEdge[]): void {
  const depth = new Map<string, number>([[start, 0]])
  const queue = [start]
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!
    for (const e of edges) {
      if (e.from !== id || depth.has(e.to)) continue
      depth.set(e.to, depth.get(id)! + 1)
      queue.push(e.to)
    }
  }
  const at = (id: string) => depth.get(id) ?? Number.POSITIVE_INFINITY
  for (const e of edges) e.back = !e.branch && nodes.some((n) => n.id === e.to) && at(e.to) <= at(e.from)
}

export interface NodeBox {
  x: number
  y: number
  width: number
  height: number
}

const SIZE = {
  node: { width: 280, height: 56 },
  join: { width: 184, height: 40 },
  end: { width: 112, height: 32 },
}
export const boxSize = (kind: GraphNodeKind) => (kind === "end" ? SIZE.end : kind === "join" ? SIZE.join : SIZE.node)

/** Posiciones con dagre, de arriba abajo; las vueltas no cuentan para el orden (se dibujan por el lado). */
export function layoutShape(shape: GraphShape): Map<string, NodeBox> {
  const g = new Graph()
  g.setGraph({ rankdir: "TB", ranksep: 34, nodesep: 24, marginx: 24, marginy: 24 })
  g.setDefaultEdgeLabel(() => ({}))
  // dagre escribe x e y en el objeto que recibe: cada nodo el suyo.
  for (const n of shape.nodes) g.setNode(n.id, { ...boxSize(n.kind) })
  for (const e of shape.edges) if (!e.back) g.setEdge(e.from, e.to)
  layout(g)
  return new Map(
    shape.nodes.map((n) => {
      const { width, height } = boxSize(n.kind)
      const p = g.node(n.id)
      return [n.id, { x: p.x - width / 2, y: p.y - height / 2, width, height }]
    }),
  )
}

export interface NodeState {
  /** `pending` sin visitas: el flujo todavía no llegó a este nodo. */
  status: StepStatus
  outcome: string | null
  error: string | null
  costMicros: number
  durationMs: number | null
  /** Cuántas veces se entró al nodo. */
  visits: number
  /** La vuelta (de un edge con rondas) en que corrió por última vez; 0 si no cuenta. */
  round: number
  /** El paso que la corrida ejecuta ahora: es el que pulsa. */
  current: boolean
  stepId: StepRunId | null
}

/** Un nodo al que ninguna corrida llegó. */
export const IDLE_NODE: NodeState = { status: "pending", outcome: null, error: null, costMicros: 0, durationMs: null, visits: 0, round: 0, current: false, stepId: null }

const isClosed = (status: StepStatus) => status === "done" || status === "failed" || status === "canceled"

function stateOf(steps: readonly Step[], kind: GraphNodeKind, now: number): NodeState {
  const last = steps.at(-1)
  if (!last) return IDLE_NODE
  const timed = steps.filter((s) => s.startedAt !== null)
  return {
    status: last.status,
    outcome: last.outcome,
    error: last.error,
    costMicros: steps.reduce((sum, s) => sum + s.costMicros, 0),
    durationMs: timed.length ? timed.reduce((sum, s) => sum + ((s.endedAt ?? now) - s.startedAt!), 0) : null,
    visits: steps.length,
    round: Math.max(...steps.map((s) => s.round)),
    // Un wait que espera es el paso actual; un parallel o un flow que esperan lo son sus ramas o su hija.
    current: last.status === "leased" || last.status === "running" || (last.status === "waiting" && kind === "wait"),
    stepId: last.id,
  }
}

/** El estado de cada nodo del grafo según los pasos de la corrida. */
export function nodeStates(shape: GraphShape, run: Pick<RunDetail, "steps" | "outcome">, now: number): Map<string, NodeState> {
  const byNode = new Map<string, Step[]>()
  for (const step of run.steps) byNode.set(step.nodeId, [...(byNode.get(step.nodeId) ?? []), step])
  const states = new Map<string, NodeState>()
  for (const n of shape.nodes) {
    if (n.kind === "end") {
      // Llegar a `@blocked` o `@failed` termina la corrida como `failed`: el fin lo dice el outcome, no el estado.
      const reached = END_OUTCOME[n.id as keyof typeof END_OUTCOME] === run.outcome
      states.set(n.id, reached ? { ...IDLE_NODE, status: "done", visits: 1 } : IDLE_NODE)
    } else if (n.kind === "join") {
      states.set(n.id, joinState(byNode, n.id.slice(0, -"#join".length), now))
    } else {
      states.set(n.id, stateOf(byNode.get(n.id) ?? [], n.kind, now))
    }
  }
  return states
}

// El join no tiene paso propio salvo con rol (`nodo#join`): sin él termina cuando cierra el parallel.
function joinState(byNode: Map<string, Step[]>, parallelId: string, now: number): NodeState {
  const consolidator = byNode.get(joinId(parallelId))
  if (consolidator) return stateOf(consolidator, "agent", now)
  const parallel = byNode.get(parallelId)?.at(-1)
  if (!parallel || !isClosed(parallel.status)) return IDLE_NODE
  return { ...IDLE_NODE, status: parallel.status, outcome: parallel.outcome, visits: 1, round: parallel.round }
}

/** `maxRounds` ya resuelto: el número, o el param de la corrida al que apunta. */
export function resolveMax(max: number | string | undefined, params: Record<string, unknown>): number | null {
  if (typeof max === "number") return max
  if (typeof max !== "string") return null
  const value = params[max.slice(PARAM_PREFIX.length)]
  return typeof value === "number" ? value : null
}

/** Los edges de vuelta, con las veces que la corrida los tomó. */
export function roundsOf(edge: GraphEdge, run: Pick<RunDetail, "rounds" | "params">): { taken: number; max: number | null } | null {
  if (!edge.rounds) return null
  return { taken: run.rounds[edge.rounds.key] ?? 0, max: resolveMax(edge.rounds.max, run.params) }
}

/** La ronda en que va la corrida: la vuelta del último paso que corrió en una, con su tope. */
export function currentRound(shape: GraphShape, run: Pick<RunDetail, "steps" | "rounds" | "params">): { name: string; round: number; max: number | null } | null {
  const step = run.steps.findLast((s) => s.round > 0)
  if (!step) return null
  const edge = shape.edges.find((e) => e.to === step.nodeId && e.rounds && (run.rounds[e.rounds.key] ?? 0) >= step.round)
  if (!edge?.rounds) return null
  return { name: edge.rounds.key.replace(".", " "), round: step.round, max: resolveMax(edge.rounds.max, run.params) }
}
