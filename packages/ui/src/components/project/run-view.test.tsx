// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeAll, expect, test, vi } from "vitest"
import { AppDataProvider } from "@/app-data"
import { RunCommandsProvider } from "@/components/project/run-commands"
import { RunView } from "@/components/project/run-view"
import { TooltipProvider } from "@/components/ui/tooltip"
import { createMemoryAppData } from "@/memory-app-data"

const NOW = Date.parse("2026-11-15T12:00:00Z")

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

async function setup(node: string | null, tab: "graph" | "timeline" = "graph") {
  const data = createMemoryAppData(NOW)
  const [project] = await data.projects()
  const run = await data.run((await data.runs({ projectId: project!.id }))[0]!.id)
  const onNodeChange = vi.fn()
  render(
    <AppDataProvider value={data}>
      <RunCommandsProvider>
        <TooltipProvider>
          <RunView run={run} issue={undefined} tab={tab} onTabChange={() => {}} node={node} onNodeChange={onNodeChange} stepTab="transcript" onStepTab={() => {}} />
        </TooltipProvider>
      </RunCommandsProvider>
    </AppDataProvider>,
  )
  return { onNodeChange }
}

test("sin nodo elegido no hay panel; con uno, el panel de ese paso va al lado del grafo", async () => {
  await setup(null)
  expect(screen.queryByRole("region", { name: /Panel del paso/ })).toBeNull()
  cleanup()

  await setup("rv-bugs")
  const panel = screen.getByRole("region", { name: "Panel del paso rv-bugs" })
  expect(within(panel).getByText("review-bugs · review")).toBeTruthy()
  expect(screen.getByRole("group", { name: /Grafo del flujo/ })).toBeTruthy()
})

test("cerrar el panel avisa que no hay nodo elegido", async () => {
  const { onNodeChange } = await setup("rv-bugs")

  fireEvent.click(screen.getByRole("button", { name: "Cerrar el panel" }))

  expect(onNodeChange).toHaveBeenCalledWith(null)
})

test("una fila de la línea de tiempo abre el panel de su paso", async () => {
  const { onNodeChange } = await setup(null, "timeline")

  fireEvent.click(screen.getAllByRole("button", { name: "Abrir el panel de plan" })[0]!)

  expect(onNodeChange).toHaveBeenCalledWith("plan")
})
