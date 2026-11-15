// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeAll, expect, test } from "vitest"
import { RunGraph } from "@/components/project/run-graph"
import { TooltipProvider } from "@/components/ui/tooltip"
import { createMemoryAppData } from "@/memory-app-data"

const NOW = Date.parse("2026-11-15T12:00:00Z")

// jsdom no mide el DOM: xyflow necesita estas dos APIs para montar.
beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.DOMMatrixReadOnly = class {
    m22 = 1
  } as unknown as typeof DOMMatrixReadOnly
})
afterEach(cleanup)

async function runGraphOf(index: number) {
  const data = createMemoryAppData(NOW)
  const [project] = await data.projects()
  const summary = (await data.runs({ projectId: project!.id }))[index]!
  return data.run(summary.id)
}

test("un flujo con parallel dibuja sus ramas y el join", async () => {
  const run = await runGraphOf(0)
  const { container } = render(
    <TooltipProvider>
      <RunGraph run={run} now={NOW} />
    </TooltipProvider>,
  )

  const nodes = [...container.querySelectorAll(".react-flow__node")].map((n) => n.getAttribute("data-id"))
  for (const branch of ["rv-bugs", "rv-tests", "rv-patterns", "rv-lore", "reviews", "reviews#join"]) expect(nodes).toContain(branch)

  // La rama que sigue corriendo late; las que ya cerraron muestran su resultado.
  const bugs = container.querySelector('[data-id="rv-bugs"] [data-current]')
  expect(bugs).toHaveProperty("dataset.current", "true")
  expect(container.querySelector('[data-id="rv-tests"] [data-current]')).toHaveProperty("dataset.current", "false")
}
)
