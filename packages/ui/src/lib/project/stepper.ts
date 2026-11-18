import type { RunDetail, StepStatus } from "@clanker/api"
import { type NodeState, nodeStates, shapeOf } from "@/lib/run-graph"

export interface StepperItem {
  id: string
  label: string
  status: StepStatus
  /** El flujo ya pasó por este nodo. */
  reached: boolean
  /** El paso que la corrida ejecuta ahora. */
  current: boolean
}

export interface Stepper {
  items: StepperItem[]
  /** Los agentes del paso actual (`rol · modo`, como los declara el flujo); más de uno si corren ramas. */
  working: string[]
  /** La vuelta en que va un nodo que cuenta rondas. */
  round: number
}

/**
 * Los nodos del flujo real en el orden en que se recorren, para un stepper de una línea: un parallel cuenta
 * como un paso (sus ramas y su join no se listan) y los fines (`@done`...) tampoco. Nada aquí nombra roles ni
 * nodos: todo sale del `flowDef` que fijó la corrida.
 */
export function stepperOf(run: Pick<RunDetail, "flowDef" | "steps" | "outcome">): Stepper {
  const shape = shapeOf(run.flowDef, run.steps)
  const states = nodeStates(shape, run)
  // Las ramas de un parallel (y su join) no se listan: el parallel es un solo paso.
  const inBranch = new Set(shape.edges.filter((e) => e.branch).map((e) => e.to))

  // Profundidad desde el inicio por cualquier edge: así un nodo que solo se alcanza al volver (un `fix`) cae donde corresponde.
  const depth = new Map<string, number>([[run.flowDef.start, 0]])
  const queue = [run.flowDef.start]
  for (let i = 0; i < queue.length; i++) {
    for (const e of shape.edges) {
      if (e.from !== queue[i] || depth.has(e.to)) continue
      depth.set(e.to, depth.get(queue[i]!)! + 1)
      queue.push(e.to)
    }
  }
  const at = (id: string) => depth.get(id) ?? Number.POSITIVE_INFINITY
  // A igual profundidad va primero el nodo al que se llega por el camino normal (`ok`) y después el de una vuelta (un `fix`).
  const normal = (id: string) => (shape.edges.some((e) => e.to === id && e.label === null) ? 0 : 1)

  const nodes = shape.nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.kind !== "end" && node.kind !== "join" && !inBranch.has(node.id))
    .sort((a, b) => at(a.node.id) - at(b.node.id) || normal(a.node.id) - normal(b.node.id) || a.index - b.index)
    .map(({ node }) => node)

  const stateOf = (id: string): NodeState => states.get(id)!
  const working = shape.nodes.filter((n) => n.kind === "agent" && n.detail !== null && stateOf(n.id).current).map((n) => n.detail!)
  return {
    items: nodes.map((n) => {
      const state = stateOf(n.id)
      // Un parallel que espera a sus ramas está en curso aunque su propio paso solo espere.
      const branchesWorking = n.kind === "parallel" && shape.edges.some((e) => e.branch && e.from === n.id && stateOf(e.to).current)
      return { id: n.id, label: n.label, status: state.status, reached: state.visits > 0, current: state.current || branchesWorking }
    }),
    working,
    round: Math.max(0, ...run.steps.map((s) => s.round)),
  }
}
