// @vitest-environment jsdom
import type { RunDetail } from "@clanker/api"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, expect, test, vi } from "vitest"
import { AppDataProvider, type AppData } from "@/app-data"
import { RunCommandsProvider } from "@/components/run/run-commands"
import { StepPanel, type StepTab } from "@/components/run/step-panel"
import { TooltipProvider } from "@/components/ui/tooltip"
import { shapeOf } from "@/lib/run-graph"
import { createMemoryAppData } from "@/demo/memory-app-data"

const NOW = Date.parse("2026-11-15T12:00:00Z")

// jsdom no mide el DOM: la lista virtualizada del transcript necesita un alto, y Radix un ResizeObserver.
beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, value: 600 })
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 30 })
})
afterEach(cleanup)

async function setup(nodeId: string, tab: StepTab, overrides: Partial<AppData> = {}) {
  const data = { ...createMemoryAppData(NOW), ...overrides }
  const [project] = await data.projects()
  const run: RunDetail = await data.run((await data.runs({ projectId: project!.id }))[0]!.id)
  const shape = shapeOf(run.flowDef, run.steps)
  const node = shape.nodes.find((n) => n.id === nodeId)!
  const onTab = vi.fn()
  const view = (current: StepTab) => (
    <AppDataProvider value={data}>
      <RunCommandsProvider>
        <TooltipProvider>
          <StepPanel run={run} shape={shape} node={node} tab={current} onTab={onTab} onClose={() => {}} />
        </TooltipProvider>
      </RunCommandsProvider>
    </AppDataProvider>
  )
  const result = render(view(tab))
  return { ...result, onTab, show: (next: StepTab) => result.rerender(view(next)), data }
}

test("un agente tiene transcript, brief, reporte, artefactos e intentos; una acción cambia el transcript por su comando", async () => {
  const agent = await setup("rv-tests", "transcript")
  expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Transcript", "Brief", "Reporte", "Artefactos", "Intentos"])
  agent.unmount()

  await setup("checks", "command")
  expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Comando", "Brief", "Reporte", "Artefactos", "Intentos"])
})

test("la pestaña pedida no existe en el nodo: se muestra la principal", async () => {
  await setup("checks", "transcript")

  expect(await screen.findByText("$ npm test")).toBeTruthy()
})

test("una acción muestra su comando, su salida y su código de salida", async () => {
  await setup("checks", "command")

  expect(await screen.findByText("$ npm run typecheck")).toBeTruthy()
  expect(screen.getByText("$ npm test")).toBeTruthy()
  expect(screen.getAllByText("exit 0")).toHaveLength(2)
  expect(screen.getByText(/42 passed \(42\)/)).toBeTruthy()
})

test("el brief es lo que el paso recibió, y el reporte, el que el agente entregó", async () => {
  const { show } = await setup("rv-tests", "brief")
  expect(await screen.findByText(/"key": "ENG-9178"/)).toBeTruthy()
  expect(screen.getByText("review-tests")).toBeTruthy()

  show("report")
  expect(await screen.findByText(/el scope por organización no cubre el caso sin modelo/)).toBeTruthy()
  expect(screen.getByText("Scope por organización")).toBeTruthy()
})

test("elegir un intento lleva a su transcript", async () => {
  const { onTab } = await setup("rv-tests", "attempts")

  fireEvent.click(await screen.findByRole("button", { name: /Intento 1/ }))

  expect(onTab).toHaveBeenCalledWith("transcript")
})

test("un nodo al que el flujo todavía no llega lo dice y no pide nada al core", async () => {
  const step = vi.fn()
  await setup("commit", "transcript", { step })

  expect(await screen.findByText("El flujo todavía no llega a este nodo")).toBeTruthy()
  expect(step).not.toHaveBeenCalled()
})

test("un paso con varias visitas deja elegir la ronda y empieza en la última", async () => {
  await setup("checks", "command")

  expect(screen.getByRole("combobox", { name: "Visita" }).textContent).toBe("visita 2 · ok")
})
