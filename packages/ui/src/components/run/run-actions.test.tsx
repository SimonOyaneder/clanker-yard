// @vitest-environment jsdom
import type { RunDetail } from "@clanker/api"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeAll, expect, test, vi } from "vitest"
import { AppDataProvider, type AppData } from "@/app-data"
import { RunCommandsProvider } from "@/components/run/run-commands"
import { RunView } from "@/components/run/run-view"
import { TooltipProvider } from "@/components/ui/tooltip"
import { createMemoryAppData } from "@/demo/memory-app-data"

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
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, value: 600 })
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 30 })
  // Radix abre los menús con un pointerdown: jsdom no tiene capturas de puntero.
  HTMLElement.prototype.hasPointerCapture = () => false
  HTMLElement.prototype.scrollIntoView = () => {}
})
afterEach(cleanup)

/** La corrida `index` de los datos de ejemplo (0 corre, 2 está estacionada por un paso fallido), con `change` aplicado, y los comandos espiados. */
async function setup(index: number, node: string | null = null, change: (run: RunDetail) => RunDetail = (run) => run) {
  const memory = createMemoryAppData(NOW)
  const [project] = await memory.projects()
  const run = change(await memory.run((await memory.runs({ projectId: project!.id }))[index]!.id))
  const respond = () => Promise.resolve(run)
  const spies = {
    pauseRun: vi.fn<AppData["pauseRun"]>(respond),
    resumeRun: vi.fn<AppData["resumeRun"]>(respond),
    cancelRun: vi.fn<AppData["cancelRun"]>(respond),
    interruptRun: vi.fn<AppData["interruptRun"]>(respond),
    retryStep: vi.fn<AppData["retryStep"]>(respond),
    steerStep: vi.fn<AppData["steerStep"]>(respond),
    forceOutcome: vi.fn<AppData["forceOutcome"]>(respond),
  }
  const data: AppData = { ...memory, ...spies }
  render(
    <AppDataProvider value={data}>
      <RunCommandsProvider>
        <TooltipProvider>
          <RunView run={run} issue={undefined} tab="graph" onTabChange={() => {}} node={node} onNodeChange={() => {}} stepTab="transcript" onStepTab={() => {}} />
        </TooltipProvider>
      </RunCommandsProvider>
    </AppDataProvider>,
  )
  return { run, spies }
}

test("una corrida que corre se pausa de un clic y se interrumpe con confirmación", async () => {
  const { run, spies } = await setup(0)
  expect(screen.queryByRole("button", { name: /Retomar/ })).toBeNull()

  fireEvent.click(screen.getByRole("button", { name: /Pausar/ }))
  expect(spies.pauseRun).toHaveBeenCalledWith(run.id)

  fireEvent.click(screen.getByRole("button", { name: /Interrumpir/ }))
  expect(spies.interruptRun).not.toHaveBeenCalled()
  const dialog = await screen.findByRole("alertdialog")
  fireEvent.click(within(dialog).getByRole("button", { name: "Interrumpir" }))
  await waitFor(() => expect(spies.interruptRun).toHaveBeenCalledWith(run.id))
})

test("una pausada ofrece Retomar y no Pausar", async () => {
  const { run, spies } = await setup(0, null, (r) => ({ ...r, status: "paused" }))
  expect(screen.queryByRole("button", { name: /^Pausar/ })).toBeNull()

  fireEvent.click(screen.getByRole("button", { name: /Retomar/ }))

  expect(spies.resumeRun).toHaveBeenCalledWith(run.id)
})

test("cancelar la corrida está en el menú y pide confirmación", async () => {
  const { run, spies } = await setup(0)

  fireEvent.pointerDown(screen.getByRole("button", { name: "Más acciones de la corrida" }), { button: 0, ctrlKey: false })
  fireEvent.click(await screen.findByRole("menuitem", { name: /Cancelar corrida/ }))
  expect(spies.cancelRun).not.toHaveBeenCalled()
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancelar corrida" }))

  await waitFor(() => expect(spies.cancelRun).toHaveBeenCalledWith(run.id))
})

test("una corrida estacionada por un paso fallido ofrece Reintentar paso, no Pausar", async () => {
  const { run, spies } = await setup(2)
  expect(screen.queryByRole("button", { name: /^Pausar/ })).toBeNull()

  fireEvent.click(screen.getByRole("button", { name: /Reintentar paso/ }))

  const failed = run.steps.findLast((s) => s.status === "failed")!
  await waitFor(() => expect(spies.retryStep).toHaveBeenCalledWith(failed.id))
})

test("el panel de un agente en curso ofrece reintentar, interrumpir y dejarle un mensaje, pero no forzar su resultado", async () => {
  // `implement` es un agente suelto (los reviewers son ramas de un parallel y no se reintentan solos).
  const { spies } = await setup(0, "implement", (r) => ({ ...r, steps: r.steps.map((s) => (s.nodeId === "implement" ? { ...s, status: "running", outcome: null } : s)) }))
  const panel = screen.getByRole("region", { name: "Panel del paso implement" })

  expect(within(panel).getByRole("button", { name: /Reintentar/ })).toBeTruthy()
  expect(within(panel).getByRole("button", { name: /Interrumpir/ })).toBeTruthy()
  expect(within(panel).queryByRole("button", { name: /Forzar resultado/ })).toBeNull()

  fireEvent.click(within(panel).getByRole("button", { name: /Mensaje al agente/ }))
  const message = await screen.findByRole("textbox", { name: "Mensaje para el agente" })
  const send = screen.getByRole("button", { name: "Enviar mensaje" }) as HTMLButtonElement
  expect(send.disabled).toBe(true)
  fireEvent.change(message, { target: { value: "usa el helper que ya existe" } })
  fireEvent.click(send)

  await waitFor(() => expect(spies.steerStep).toHaveBeenCalledWith({ stepId: expect.stringMatching(/^stp_/), message: "usa el helper que ya existe" }))
})

test("el panel de una acción en curso fuerza uno de los outcomes que declara su nodo, con confirmación", async () => {
  // `checks` corre ahora: la acción de la corrida en curso.
  const { spies } = await setup(0, "checks", (r) => ({ ...r, steps: r.steps.map((s) => (s.nodeId === "checks" && s.visit === 2 ? { ...s, status: "running", outcome: null } : s)) }))
  const panel = screen.getByRole("region", { name: "Panel del paso checks" })
  expect(within(panel).queryByRole("button", { name: /Mensaje al agente/ })).toBeNull()

  // El botón lleva un tooltip encima y jsdom no entrega su pointerdown al menú: se abre con el teclado, como haría quien no usa el mouse.
  fireEvent.keyDown(within(panel).getByRole("button", { name: /Forzar resultado/ }), { key: "ArrowDown" })
  fireEvent.click(await screen.findByRole("menuitem", { name: "ok" }))
  expect(spies.forceOutcome).not.toHaveBeenCalled()
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Forzar resultado" }))

  await waitFor(() => expect(spies.forceOutcome).toHaveBeenCalledWith({ stepId: expect.stringMatching(/^stp_/), outcome: "ok" }))
})
