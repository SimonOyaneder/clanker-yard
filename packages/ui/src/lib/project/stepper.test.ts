import { expect, test } from "vitest"
import { createMemoryAppData } from "@/demo/memory-app-data"
import { stepperOf } from "@/lib/project/stepper"

const NOW = Date.parse("2026-11-15T12:00:00Z")
const runId = (n: number) => `run_${String(n).padStart(26, "0")}` as const

test("el stepper recorre el flujo real: un parallel es un paso y sus ramas no se listan", async () => {
  const run = await createMemoryAppData(NOW).run(runId(1))

  const { items } = stepperOf(run, NOW)

  expect(items.map((i) => i.id)).toEqual(["ws", "plan", "implement", "checks", "reviews", "fix", "sync", "commit", "publish", "feedback"])
})

test("marca el paso actual (el parallel lo es mientras sus ramas corren) y los agentes que trabajan", async () => {
  const run = await createMemoryAppData(NOW).run(runId(1))

  const stepper = stepperOf(run, NOW)

  expect(stepper.items.filter((i) => i.current).map((i) => i.id)).toEqual(["reviews"])
  expect(stepper.items.find((i) => i.id === "plan")).toMatchObject({ reached: true, status: "done", current: false })
  expect(stepper.items.find((i) => i.id === "commit")).toMatchObject({ reached: false, current: false })
  expect(stepper.working).toEqual(["review-bugs · review"])
  expect(stepper.round).toBe(1)
})

test("una corrida terminada no tiene paso actual", async () => {
  const run = await createMemoryAppData(NOW).run(runId(2))

  const stepper = stepperOf(run, NOW)

  expect(stepper.items.some((i) => i.current)).toBe(false)
  expect(stepper.items.filter((i) => i.reached).map((i) => i.id)).toEqual(["ws", "plan", "implement", "checks", "reviews", "sync", "commit", "publish", "feedback"])
})
