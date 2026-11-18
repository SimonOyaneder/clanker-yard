// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, beforeAll, expect, test, vi } from "vitest"
import { AppDataProvider } from "@/app-data"
import { RunCommandsProvider } from "@/components/run/run-commands"
import { RunGraph } from "@/components/run/run-graph"
import { TooltipProvider } from "@/components/ui/tooltip"
import { shapeOf } from "@/lib/run-graph"
import { createMemoryAppData } from "@/demo/memory-app-data"

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

async function renderGraph(index: number, props: Partial<Pick<Parameters<typeof RunGraph>[0], "selected" | "onSelect">> = {}) {
  const run = await runGraphOf(index)
  return render(
    <AppDataProvider value={createMemoryAppData(NOW)}>
      <RunCommandsProvider>
        <TooltipProvider>
          <RunGraph run={run} shape={shapeOf(run.flowDef, run.steps)} selected={null} onSelect={() => {}} onCopySessionId={() => {}} {...props} />
        </TooltipProvider>
      </RunCommandsProvider>
    </AppDataProvider>,
  )
}

test("un flujo con parallel dibuja sus ramas y el join", async () => {
  const { container } = await renderGraph(0)

  const nodes = [...container.querySelectorAll(".react-flow__node")].map((n) => n.getAttribute("data-id"))
  for (const branch of ["rv-bugs", "rv-tests", "rv-patterns", "rv-lore", "reviews", "reviews#join"]) expect(nodes).toContain(branch)

  // La rama que sigue corriendo late; las que ya cerraron muestran su resultado.
  const bugs = container.querySelector('[data-id="rv-bugs"] [data-current]')
  expect(bugs).toHaveProperty("dataset.current", "true")
  expect(container.querySelector('[data-id="rv-tests"] [data-current]')).toHaveProperty("dataset.current", "false")
})

test("un clic en un nodo abre su panel y el final del flujo no se puede abrir", async () => {
  const onSelect = vi.fn()
  const { container } = await renderGraph(0, { onSelect })

  fireEvent.click(container.querySelector('[data-id="rv-bugs"]')!)
  expect(onSelect).toHaveBeenCalledWith("rv-bugs")
  onSelect.mockClear()
  fireEvent.click(container.querySelector('[data-id="@done"]')!)
  expect(onSelect).not.toHaveBeenCalled()
})

test("el nodo cuyo panel está abierto queda marcado", async () => {
  const { container } = await renderGraph(0, { selected: "rv-bugs" })

  expect(container.querySelector('[data-id="rv-bugs"]')).toHaveProperty("className", expect.stringContaining("selected"))
  expect(container.querySelector('[data-id="rv-tests"]')).toHaveProperty("className", expect.not.stringContaining("selected"))
})
