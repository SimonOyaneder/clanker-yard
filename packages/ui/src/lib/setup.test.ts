import { expect, test } from "vitest"
import { setupSteps } from "@/lib/setup"

test("recién instalada no hay nada hecho, en el orden en que conviene hacerlo", () => {
  const steps = setupSteps({ connections: [], repos: 0, projects: 0 })
  expect(steps.map((s) => [s.id, s.done])).toEqual([
    ["github", false],
    ["linear", false],
    ["claude", false],
    ["repo", false],
    ["project", false],
  ])
})

test("cada conexión, un repo y un proyecto marcan su paso", () => {
  const steps = setupSteps({
    connections: [{ provider: "github" }, { provider: "linear" }, { provider: "claude" }],
    repos: 1,
    projects: 2,
  })
  expect(steps.every((s) => s.done)).toBe(true)
})
