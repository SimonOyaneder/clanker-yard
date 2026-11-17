import { FlowDef, type RunDetail, type Step } from "@clanker/api"
import { describe, expect, test } from "vitest"
import { runCaps, stepCaps } from "@/lib/project/run-commands"
import { shapeOf } from "@/lib/run-graph"

const flowDef = FlowDef.parse({
  schema: 1,
  id: "demo",
  name: "Demo",
  trigger: { type: "manual" },
  start: "plan",
  nodes: {
    plan: { type: "agent", role: "dev", mode: "plan", brief: {}, on: { ok: "check", changes: "@blocked" } },
    check: { type: "action", action: "recipe.check", args: {}, on: { ok: "ci", fail: "@failed" } },
    ci: { type: "wait", event: "pr.ci", args: {}, on: { ok: "fan", fail: "@failed" } },
    fan: { type: "parallel", branches: ["a", "b"], on: { ok: "@done", changes: "@blocked", fail: "@failed" } },
    a: { type: "action", action: "x", args: {} },
    b: { type: "action", action: "x", args: {} },
  },
})

const step = (nodeId: string, status: Step["status"], extra: Partial<Step> = {}): Step => ({
  id: `stp_${nodeId}`,
  nodeId,
  visit: 1,
  round: 0,
  attempt: 1,
  status,
  outcome: null,
  outputHash: null,
  error: null,
  notBefore: null,
  costMicros: 0,
  startedAt: 0,
  endedAt: null,
  ...extra,
})

const runOf = (status: RunDetail["status"], steps: Step[], parkReason: RunDetail["parkReason"] = null) => ({ status, steps, parkReason, flowDef })
const shape = shapeOf(flowDef)
const caps = (run: ReturnType<typeof runOf>, nodeId: string) => stepCaps(run, shape, nodeId, run.steps.findLast((s) => s.nodeId === nodeId))

describe("runCaps", () => {
  test("una corrida que corre se pausa y se cancela; con un agente en curso también se interrumpe", () => {
    expect(runCaps(runOf("running", [step("check", "running")]), shape)).toMatchObject({ pause: true, resume: false, interrupt: false, cancel: true })
    expect(runCaps(runOf("running", [step("plan", "running")]), shape)).toMatchObject({ pause: true, interrupt: true })
  })

  test("una pausada se retoma y se cancela, pero no se pausa", () => {
    expect(runCaps(runOf("paused", [step("plan", "running")]), shape)).toMatchObject({ pause: false, resume: true, interrupt: true, cancel: true })
  })

  test("una estacionada solo se cancela, y su paso fallido es lo que se reintenta", () => {
    const failed = step("plan", "failed")
    expect(runCaps(runOf("parked", [failed], "needs_human"), shape)).toMatchObject({ pause: false, resume: false, cancel: true, failedStep: failed })
    expect(runCaps(runOf("parked", [step("ci", "waiting")], "gate"), shape).failedStep).toBeUndefined()
  })

  test("una terminada no ofrece nada", () => {
    expect(runCaps(runOf("done", [step("plan", "done")]), shape)).toEqual({ pause: false, resume: false, interrupt: false, cancel: false, failedStep: undefined })
  })
})

describe("stepCaps", () => {
  test("un agente en curso se reintenta, se interrumpe y recibe mensajes, pero no se fuerza", () => {
    expect(caps(runOf("running", [step("plan", "running")]), "plan")).toEqual({ retry: "este", interrupt: true, steer: true, force: [] })
  })

  test("una acción en curso se fuerza con los outcomes que declara su nodo", () => {
    expect(caps(runOf("running", [step("plan", "done"), step("check", "running")]), "check")).toEqual({ retry: "este", interrupt: false, steer: false, force: ["ok", "fail"] })
  })

  test("un wait esperando también se fuerza", () => {
    expect(caps(runOf("running", [step("ci", "waiting")]), "ci").force).toEqual(["ok", "fail"])
  })

  test("un paso que ya terminó se reintenta desde ahí y no se fuerza ni recibe mensajes", () => {
    expect(caps(runOf("running", [step("plan", "done"), step("check", "running")]), "plan")).toEqual({ retry: "desde", interrupt: false, steer: false, force: [] })
  })

  test("el paso fallido de una corrida estacionada se reintenta, recibe mensajes y, si es una acción, se fuerza", () => {
    expect(caps(runOf("parked", [step("plan", "failed")], "needs_human"), "plan")).toEqual({ retry: "este", interrupt: false, steer: true, force: [] })
    expect(caps(runOf("parked", [step("plan", "done"), step("check", "failed")], "needs_human"), "check")).toMatchObject({ retry: "este", force: ["ok", "fail"] })
  })

  test("una rama de un parallel no se comanda sola", () => {
    expect(caps(runOf("running", [step("fan", "waiting"), step("a", "running")]), "a")).toEqual({ retry: null, interrupt: false, steer: false, force: [] })
  })

  test("sin estar viva la corrida, o sin paso, no hay nada", () => {
    expect(caps(runOf("done", [step("plan", "done")]), "plan")).toEqual({ retry: null, interrupt: false, steer: false, force: [] })
    expect(stepCaps(runOf("running", []), shape, "plan", undefined).retry).toBeNull()
  })
})
