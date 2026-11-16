import { type FlowDef, Role } from "@clanker/api"
import { expect, test } from "vitest"
import { addStep, branchOwners, connect, marksOf, outcomesOf, positionsOf, removeNodes, setNode, withEdge } from "@/lib/flow-canvas"
import { SEED_TECHLEAD } from "@/seed-flows"

const hints = { role: "dev", mode: "plan", action: "workspace.acquire", event: "pr.ci", flow: "pr-feedback" }
const techlead = SEED_TECHLEAD

test("sacar un paso lo quita de las ramas y de todo edge que iba a él", () => {
  const next = removeNodes(techlead, ["rv-lore"])
  expect(next.nodes["rv-lore"]).toBeUndefined()
  expect(next.nodes.reviews).toMatchObject({ branches: ["rv-bugs", "rv-tests", "rv-patterns"] })
  expect(techlead.nodes["rv-lore"]).toBeDefined()

  const noFix = removeNodes(techlead, ["fix"])
  expect(noFix.nodes.checks!.on).toEqual({ ok: "reviews" })
  expect(noFix.nodes.reviews!.on).toEqual({ ok: "sync" })
})

test("si el destino de agotarse se va, el edge sigue y agota a @blocked", () => {
  const next = removeNodes(techlead, ["sync"])
  expect(next.nodes.reviews!.on).toMatchObject({ changes: { to: "fix", exhausted: "@blocked" } })
})

test("si cae el paso inicial lo reemplaza el primero que queda", () => {
  expect(removeNodes(techlead, ["ws"]).start).toBe("plan")
})

test("conectar cambia el destino y conserva las rondas del edge", () => {
  const next = connect(techlead, "checks", "fail", "plan")
  expect(next.nodes.checks!.on!.fail).toMatchObject({ to: "plan", maxRounds: "$run.params.checkRounds" })
  expect(connect(techlead, "plan", "ok", "checks").nodes.plan!.on).toEqual({ ok: "checks" })
  expect(connect(techlead, "publish", "fail", "@failed").nodes.publish!.on).toEqual({ ok: "feedback", fail: "@failed" })
})

test("un edge objeto que queda solo con `to` vuelve a ser el id", () => {
  const next = withEdge(techlead.nodes.sync!, "rebased", { to: "checks" })
  expect(next.on!.rebased).toBe("checks")
  expect(withEdge(techlead.nodes.ws!, "ok", undefined).on).toBeUndefined()
})

test("agregar un paso le da un id libre y lo deja suelto", () => {
  const first = addStep(techlead, "gate", hints)
  expect(first.ids).toEqual(["gate"])
  expect(first.flow.nodes.gate).toMatchObject({ type: "gate", options: [{ id: "si" }, { id: "no" }] })
  expect(addStep(first.flow, "gate", hints).ids).toEqual(["gate-2"])
  expect(first.flow.nodes.gate!.on).toBeUndefined()
})

test("un parallel nuevo nace con una rama para ser un flujo válido", () => {
  const { flow, ids } = addStep(techlead, "parallel", hints)
  expect(ids).toEqual(["parallel", "agent"])
  expect(flow.nodes.parallel).toMatchObject({ type: "parallel", branches: ["agent"] })
  expect(branchOwners(flow).get("agent")).toBe("parallel")
})

test("las salidas de un paso salen de su rol, sus opciones o su tipo, más las que ya usa", () => {
  const role = Role.parse({ prompt: "x", context: [], modes: { review: { instructions: "x", report: { type: "object" }, outcomes: ["ok", "changes"], session: "new" } } })
  const roles = new Map([["review-bugs", role]])
  expect(outcomesOf({ type: "agent", role: "review-bugs", mode: "review", brief: {}, on: { error: "@failed" } }, roles)).toEqual(["ok", "changes", "error"])
  expect(outcomesOf({ type: "agent", role: "otro", mode: "x", brief: {} }, roles)).toEqual(["ok"])
  expect(outcomesOf({ type: "gate", question: "?", options: [{ id: "si", label: "Sí" }] }, roles)).toEqual(["si"])
  expect(outcomesOf(techlead.nodes.feedback!, roles)).toEqual(["done", "blocked", "failed"])
})

test("cada problema del core cae en su paso y, si habla de una salida, en ese edge", () => {
  const marks = marksOf(
    [
      { path: "nodes.fix.on.ok", message: "el nodo no existe" },
      { path: "nodes.plan", message: "no es alcanzable" },
      { path: "start", message: "el nodo inicial no existe" },
    ],
    [{ path: "nodes.gate.timeoutSec", message: "gate sin timeoutSec" }],
  )
  expect(marks.nodes.get("fix")).toEqual([{ tone: "error", message: "el nodo no existe" }])
  expect(marks.edges.get("fix:ok")).toHaveLength(1)
  expect(marks.nodes.get("plan")).toHaveLength(1)
  expect(marks.edges.has("plan:ok")).toBe(false)
  expect(marks.nodes.get("gate")).toEqual([{ tone: "warning", message: "gate sin timeoutSec" }])
  expect(marks.general).toEqual([{ tone: "error", message: "el nodo inicial no existe" }])
})

test("lo que la persona movió manda; el resto se acomoda solo, y los tres finales siempre tienen lugar", () => {
  const auto = positionsOf(techlead, {})
  const moved = positionsOf(techlead, { plan: { x: 999, y: 111 } })
  expect(moved.get("plan")).toEqual({ x: 999, y: 111 })
  expect(moved.get("implement")).toEqual(auto.get("implement"))
  for (const end of ["@done", "@blocked", "@failed"]) expect(moved.get(end)).toBeDefined()
})

test("mover o editar pasos no agrega nada al body: el flujo sigue siendo el mismo JSON", () => {
  const next: FlowDef = setNode(techlead, "plan", { ...techlead.nodes.plan!, timeoutSec: 60 })
  expect(Object.keys(next).toSorted()).toEqual(Object.keys(techlead).toSorted())
})
