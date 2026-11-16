import type { DefIssue, Edge, End, FlowDef, Node, Role } from "@clanker/api"
import { layoutShape, shapeOf } from "@/lib/run-graph"

// Lo que el canvas del editor de flujos necesita para dibujar y editar el mismo `FlowDef` que el editor de JSON.
// Nada aquí valida: eso lo hace `defs.update` con `dryRun`. Las funciones de edición devuelven un flujo nuevo.

export type NodeType = Node["type"]
export const NODE_TYPES: readonly NodeType[] = ["agent", "action", "parallel", "wait", "flow", "gate"]
export const ENDS: readonly End[] = ["@done", "@blocked", "@failed"]
export const END_NAME: Record<End, string> = { "@done": "listo", "@blocked": "bloqueado", "@failed": "falló" }

/** Lo que dice la paleta de cada tipo de paso. */
export const NODE_SUMMARY: Record<NodeType, string> = {
  agent: "un agente hace una tarea (planear, implementar, revisar)",
  action: "código de la app que corre sin agente: checks, git, publicar",
  parallel: "lanza varias ramas a la vez y espera a todas",
  wait: "espera algo de afuera, como el CI o un review",
  flow: "corre otro flujo completo y sigue con su resultado",
  gate: "espera una decisión tuya",
}

/** Lo que el core no sabe adivinar de un paso nuevo: de dónde sacar un rol, una acción o un evento válidos. */
export interface NodeHints {
  role: string
  mode: string
  action: string
  event: string
  flow: string
}

function newNode(type: Exclude<NodeType, "parallel">, hints: NodeHints): Node {
  switch (type) {
    case "agent":
      return { type, role: hints.role, mode: hints.mode, brief: {} }
    case "action":
      return { type, action: hints.action, args: {} }
    case "wait":
      return { type, event: hints.event, args: {} }
    case "flow":
      return { type, flow: hints.flow, params: {} }
    case "gate":
      return { type, question: "¿Seguimos?", options: [{ id: "si", label: "Sí" }, { id: "no", label: "No" }] }
  }
}

const edit = (flow: FlowDef, change: (draft: FlowDef) => void): FlowDef => {
  const draft = structuredClone(flow)
  change(draft)
  return draft
}

/** Un id libre para un paso nuevo: `agent`, `agent-2`... */
const freeId = (flow: FlowDef, type: string) => {
  if (!(type in flow.nodes)) return type
  let n = 2
  while (`${type}-${n}` in flow.nodes) n++
  return `${type}-${n}`
}

/**
 * Agrega un paso del tipo dado, suelto (sin edges). Un parallel nace con una rama (un agente), porque sin ramas no es
 * un flujo válido. Devuelve el flujo y los ids nuevos, el del paso pedido primero.
 */
export function addStep(flow: FlowDef, type: NodeType, hints: NodeHints): { flow: FlowDef; ids: string[] } {
  const draft = structuredClone(flow)
  const id = freeId(draft, type)
  if (type === "parallel") {
    const branch = freeId(draft, "agent")
    draft.nodes[branch] = newNode("agent", hints)
    draft.nodes[id] = { type, branches: [branch] }
    return { flow: draft, ids: [id, branch] }
  }
  draft.nodes[id] = newNode(type, hints)
  return { flow: draft, ids: [id] }
}

export function setNode(flow: FlowDef, id: string, node: Node): FlowDef {
  return edit(flow, (d) => {
    d.nodes[id] = node
  })
}

const targetOf = (edge: Edge) => (typeof edge === "string" ? edge : edge.to)

/** El edge más corto que dice lo mismo: un objeto que solo tiene `to` es el id a secas. */
function tidy(edge: Exclude<Edge, string>): Edge {
  const { to, ...rest } = edge
  return Object.values(rest).some((v) => v !== undefined) ? edge : to
}

/** Saca los pasos del flujo y todo lo que apuntaba a ellos. Si cae el inicial, el primero que quede lo reemplaza. */
export function removeNodes(flow: FlowDef, ids: readonly string[]): FlowDef {
  const gone = new Set(ids)
  return edit(flow, (d) => {
    for (const id of gone) delete d.nodes[id]
    for (const node of Object.values(d.nodes)) {
      if (node.on) {
        for (const [outcome, edge] of Object.entries(node.on)) {
          if (gone.has(targetOf(edge))) {
            delete node.on[outcome]
          } else if (typeof edge === "object" && edge.exhausted !== undefined && gone.has(targetOf(edge.exhausted))) {
            node.on[outcome] = { ...edge, exhausted: "@blocked" }
          }
        }
      }
      if (node.type === "parallel" && Array.isArray(node.branches)) node.branches = node.branches.filter((b) => !gone.has(b))
      if (node.type === "agent" && node.resumeFrom && gone.has(node.resumeFrom)) delete node.resumeFrom
    }
    if (gone.has(d.start)) d.start = Object.keys(d.nodes)[0] ?? d.start
  })
}

/** El paso con el edge de un outcome cambiado (`undefined` lo quita). */
export function withEdge<N extends Node>(node: N, outcome: string, edge: Edge | undefined): N {
  const on = { ...node.on }
  if (edge === undefined) delete on[outcome]
  else on[outcome] = typeof edge === "object" ? tidy(edge) : edge
  return { ...node, on: Object.keys(on).length > 0 ? on : undefined }
}

/** El outcome de `from` va a `to`; conserva las rondas y lo demás que el edge ya tuviera. */
export function connect(flow: FlowDef, from: string, outcome: string, to: string): FlowDef {
  const node = flow.nodes[from]
  if (!node) return flow
  const current = node.on?.[outcome]
  return setNode(flow, from, withEdge(node, outcome, typeof current === "object" ? { ...current, to } : to))
}

export function setStart(flow: FlowDef, id: string): FlowDef {
  return edit(flow, (d) => {
    d.start = id
  })
}

/** Cada rama de un parallel con su dueño: no tienen salidas propias y no se dibujan con handles. */
export function branchOwners(flow: FlowDef): Map<string, string> {
  const owners = new Map<string, string>()
  for (const [id, node] of Object.entries(flow.nodes)) {
    if (node.type === "parallel" && Array.isArray(node.branches)) for (const b of node.branches) owners.set(b, id)
  }
  return owners
}

/** Las salidas (outcomes) que un paso ofrece como handles: las que sabe su rol, sus opciones o su tipo, y las que ya usa. */
export function outcomesOf(node: Node, roles: ReadonlyMap<string, Role>): string[] {
  let known: string[]
  switch (node.type) {
    case "agent":
      known = roles.get(node.role)?.modes[node.mode]?.outcomes ?? []
      break
    case "gate":
      known = node.options.map((o) => o.id)
      break
    case "flow":
      known = ["done", "blocked", "failed"]
      break
    default:
      known = []
  }
  const all = [...new Set([...known, ...Object.keys(node.on ?? {})])]
  return all.length > 0 ? all : ["ok"]
}

export const edgeSpec = (edge: Edge): Exclude<Edge, string> => (typeof edge === "string" ? { to: edge } : edge)

export type Tone = "error" | "warning"
export interface Mark {
  tone: Tone
  message: string
}

export interface Marks {
  /** Por paso: todo lo que el core dijo de él o de lo que cuelga de él. */
  nodes: Map<string, Mark[]>
  /** Por edge (`paso:outcome`): lo que el core dijo de esa salida. */
  edges: Map<string, Mark[]>
  /** Lo que no es de ningún paso (el inicio, el id, los params). */
  general: Mark[]
}

const push = (map: Map<string, Mark[]>, key: string, mark: Mark) => map.set(key, [...(map.get(key) ?? []), mark])

/** Ubica cada problema del core en el paso o la salida de la que habla su `path` (`nodes.fix.on.ok`). */
export function marksOf(errors: readonly DefIssue[], warnings: readonly DefIssue[]): Marks {
  const marks: Marks = { nodes: new Map(), edges: new Map(), general: [] }
  const place = (tone: Tone, { path, message }: DefIssue) => {
    const mark = { tone, message }
    const [head, id, section, outcome] = path.split(".")
    if (head !== "nodes" || !id) return void marks.general.push(mark)
    push(marks.nodes, id, mark)
    if (section === "on" && outcome) push(marks.edges, `${id}:${outcome}`, mark)
  }
  for (const issue of errors) place("error", issue)
  for (const issue of warnings) place("warning", issue)
  return marks
}

export interface Point {
  x: number
  y: number
}
export const CANVAS_NODE = { width: 280, height: 84 }
export const CANVAS_END = { width: 112, height: 32 }

/**
 * Dónde va cada paso (y cada final): lo que la persona movió, y para el resto el acomodo automático (dagre) de la
 * vista de solo lectura. Un paso nuevo sin lugar guardado cae debajo del más bajo.
 */
export function positionsOf(flow: FlowDef, saved: Readonly<Record<string, Point>>): Map<string, Point> {
  const boxes = layoutShape(shapeOf(flow))
  const positions = new Map<string, Point>()
  const ids = [...Object.keys(flow.nodes), ...ENDS]
  for (const id of ids) {
    const box = boxes.get(id)
    if (saved[id]) positions.set(id, saved[id])
    else if (box) positions.set(id, { x: box.x, y: box.y })
  }
  const bottom = Math.max(0, ...[...positions.values()].map((p) => p.y))
  let extra = 0
  for (const id of ids) {
    if (positions.has(id)) continue
    positions.set(id, { x: 24 + extra++ * (CANVAS_NODE.width + 24), y: bottom + CANVAS_NODE.height + 48 })
  }
  return positions
}

/** Todos los valores de `key` (`action`, `event`...) que usan los flujos dados: sugerencias para quien arma un paso. */
export function usedValues(flows: readonly FlowDef[], key: "action" | "event"): string[] {
  const found = new Set<string>()
  for (const flow of flows) {
    for (const node of Object.values(flow.nodes)) {
      if (key === "action" && node.type === "action") found.add(node.action)
      if (key === "event" && node.type === "wait") found.add(node.event)
    }
  }
  return [...found].toSorted()
}
