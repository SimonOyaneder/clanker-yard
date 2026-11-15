import type { FlowDef, RunDetail } from "@clanker/api"
import { expect, test } from "vitest"
import { createMemoryAppData } from "@/memory-app-data"
import { currentRound, joinId, layoutShape, nodeStates, roundsOf, shapeOf } from "./run-graph"

const NOW = Date.parse("2026-11-15T12:00:00Z")

async function runs(): Promise<RunDetail[]> {
  const data = createMemoryAppData(NOW)
  const [project] = await data.projects()
  const summaries = await data.runs({ projectId: project!.id })
  return Promise.all(summaries.map((r) => data.run(r.id)))
}

test("un parallel se dibuja como su nodo, una arista a cada rama, y un join que concentra sus salidas", async () => {
  const [running] = await runs()
  const shape = shapeOf(running!.flowDef, running!.steps)
  const edges = shape.edges.map((e) => `${e.from}->${e.to}`)

  for (const branch of ["rv-bugs", "rv-tests", "rv-patterns", "rv-lore"]) {
    expect(edges).toContain(`reviews->${branch}`)
    expect(edges).toContain(`${branch}->${joinId("reviews")}`)
  }
  expect(edges).toContain(`${joinId("reviews")}->sync`)
  expect(edges).toContain(`${joinId("reviews")}->fix`)
  expect(edges).not.toContain("reviews->sync")
})

test("las vueltas del flujo se marcan como edges de vuelta y las salidas hacia adelante no", async () => {
  const [running] = await runs()
  const back = shapeOf(running!.flowDef).edges.filter((e) => e.back).map((e) => `${e.from}->${e.to}`)

  expect(back).toEqual(expect.arrayContaining(["fix->checks", `${joinId("reviews")}->fix`, "sync->checks"]))
  expect(back).not.toContain("checks->fix")
  expect(back).not.toContain("ws->plan")
})

test("las vueltas cuentan sus rondas contra el tope del param de la corrida", async () => {
  const [running] = await runs()
  const shape = shapeOf(running!.flowDef, running!.steps)
  const changes = shape.edges.find((e) => e.from === joinId("reviews") && e.to === "fix")!

  expect(roundsOf(changes, running!)).toEqual({ taken: 1, max: 3 })
  expect(currentRound(shape, running!)).toEqual({ name: "review", round: 1, max: 3 })
})

test("cada nodo toma el estado de sus pasos: el actual late, las visitas se cuentan y el costo se suma", async () => {
  const [running] = await runs()
  const shape = shapeOf(running!.flowDef, running!.steps)
  const states = nodeStates(shape, running!, NOW)

  expect(states.get("rv-bugs")).toMatchObject({ status: "running", current: true, visits: 2, costMicros: 570_000 })
  expect(states.get("checks")).toMatchObject({ status: "done", current: false, visits: 2 })
  expect(states.get("reviews")).toMatchObject({ status: "waiting", current: false })
  expect(states.get("fix")).toMatchObject({ round: 1 })
  expect(states.get("publish")).toMatchObject({ status: "pending", visits: 0 })
  // La duración suma las visitas: 1,5 min y 1 min.
  expect(states.get("checks")?.durationMs).toBe(1.5 * 60_000 + 60_000)
})

test("una corrida terminada marca por dónde acabó el flujo", async () => {
  const [, done] = await runs()
  const shape = shapeOf(done!.flowDef, done!.steps)
  const states = nodeStates(shape, done!, NOW)

  expect(states.get("@done")?.status).toBe("done")
  expect(states.get("@failed")?.status).toBe("pending")
  expect(states.get(joinId("reviews"))).toMatchObject({ status: "done", outcome: "ok" })
})

test("una corrida que llega a @failed o @blocked queda failed y marca ese fin", async () => {
  const [, done] = await runs()
  const shape = shapeOf(done!.flowDef, done!.steps)

  for (const end of ["failed", "blocked"] as const) {
    const ended: RunDetail = { ...done!, status: "failed", outcome: end }
    const states = nodeStates(shape, ended, NOW)
    expect(states.get(`@${end}`)?.status).toBe("done")
    expect(states.get("@done")?.status).toBe("pending")
  }
})

test("las ramas de un forEach son las que la corrida ya creó, en orden de ítem", () => {
  const def: FlowDef = {
    schema: 1,
    id: "bench",
    name: "Bench",
    trigger: { type: "manual" },
    start: "fan",
    nodes: { fan: { type: "parallel", branches: { forEach: "$run.params.items", branch: { type: "action", action: "run", args: {} } }, on: { ok: "@done" } } },
  }
  const step = (n: number, nodeId: string) => ({ id: `stp_${n}`, nodeId }) as RunDetail["steps"][number]

  expect(shapeOf(def, [step(1, "fan[1]"), step(2, "fan[0]")]).nodes.map((n) => n.id)).toEqual(["fan", "fan#join", "fan[0]", "fan[1]", "@done"])
  expect(shapeOf(def).nodes.map((n) => n.id)).toContain("fan[…]")
})

test("el layout deja las ramas de un parallel en el mismo nivel y debajo de su nodo", async () => {
  const [running] = await runs()
  const boxes = layoutShape(shapeOf(running!.flowDef))
  const ys = ["rv-bugs", "rv-tests", "rv-patterns", "rv-lore"].map((id) => boxes.get(id)!.y)

  expect(new Set(ys).size).toBe(1)
  expect(ys[0]).toBeGreaterThan(boxes.get("reviews")!.y)
  expect(boxes.get(joinId("reviews"))!.y).toBeGreaterThan(ys[0]!)
})
