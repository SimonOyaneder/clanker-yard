import type { RunDetail, RunStatus, Step } from "@clanker/api"
import type { GraphNodeKind, GraphShape } from "@/lib/run-graph"

// Qué se le puede pedir a una corrida y a cada uno de sus pasos según su estado: los mismos casos que el
// core acepta (`Engine.control` y `Engine.stepCommand`), para ofrecer solo lo que no va a rechazar.

/** Un paso que la corrida tiene en marcha o a punto de ejecutar. */
const OPEN: readonly Step["status"][] = ["pending", "leased", "running", "waiting"]
const IN_FLIGHT: readonly Step["status"][] = ["leased", "running"]
const COMMANDABLE: readonly RunStatus[] = ["running", "paused", "parked"]

export interface RunCaps {
  pause: boolean
  resume: boolean
  /** Hay un agente en curso que se puede detener con su sesión guardada. */
  interrupt: boolean
  cancel: boolean
  /** El paso que falló y en que la corrida espera a una persona (`needs_human`): lo que se reintenta con ⇧⌘R. */
  failedStep: Step | undefined
}

const kindOf = (shape: GraphShape, step: Step): GraphNodeKind | undefined => shape.nodes.find((n) => n.id === step.nodeId)?.kind

export function runCaps(run: Pick<RunDetail, "status" | "steps" | "parkReason">, shape: GraphShape): RunCaps {
  const agentRunning = run.steps.some((s) => IN_FLIGHT.includes(s.status) && (kindOf(shape, s) === "agent" || kindOf(shape, s) === "join"))
  const last = run.steps.at(-1)
  return {
    pause: run.status === "running",
    resume: run.status === "paused",
    interrupt: (run.status === "running" || run.status === "paused") && agentRunning,
    cancel: run.status === "queued" || COMMANDABLE.includes(run.status),
    failedStep: run.status === "parked" && run.parkReason === "needs_human" && last?.status === "failed" ? last : undefined,
  }
}

export interface StepCaps {
  /** "este" si es el paso donde está la corrida (el que falló o corre); "desde" si ya terminó y la corrida sigue más adelante. */
  retry: "este" | "desde" | null
  /** Detiene al agente en curso (es interrumpir la corrida). */
  interrupt: boolean
  /** Dejarle un mensaje al agente y retomar su sesión. */
  steer: boolean
  /** Los outcomes que el nodo declara; vacío si no se puede forzar (solo pasos action y wait, nunca un agente). */
  force: string[]
}

const NONE: StepCaps = { retry: null, interrupt: false, steer: false, force: [] }

/** `step` es el paso más reciente del nodo. */
export function stepCaps(run: Pick<RunDetail, "status" | "steps" | "flowDef">, shape: GraphShape, nodeId: string, step: Step | undefined): StepCaps {
  const node = shape.nodes.find((n) => n.id === nodeId)
  if (!step || !node || node.kind === "end" || node.kind === "join" || !COMMANDABLE.includes(run.status)) return NONE
  // Una rama de un parallel se reintenta con su parallel: el core no la comanda sola.
  const branch = shape.edges.some((e) => e.branch && e.to === nodeId)
  const here = run.steps.at(-1)?.id === step.id
  const inFlight = IN_FLIGHT.includes(step.status)
  const waitingForPerson = run.status === "parked" && step.status === "failed" && here
  const agent = node.kind === "agent"
  const open = OPEN.includes(step.status) && run.status !== "parked"
  const declared = run.flowDef.nodes[nodeId]?.on
  return {
    retry: branch ? null : OPEN.includes(step.status) || step.status === "failed" || (step.status === "canceled" && here) ? "este" : "desde",
    interrupt: agent && inFlight && (run.status === "running" || run.status === "paused"),
    steer: agent && (inFlight || step.status === "pending" || waitingForPerson),
    force: !branch && (node.kind === "action" || node.kind === "wait") && (open || waitingForPerson) ? Object.keys(declared ?? {}) : [],
  }
}
