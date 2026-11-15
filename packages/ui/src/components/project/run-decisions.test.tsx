// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import { AppDataProvider } from "@/app-data"
import { ParkedCallout } from "@/components/project/run-decisions"
import { TooltipProvider } from "@/components/ui/tooltip"
import { type AppActions, AppActionsContext } from "@/lib/app-context"
import { createMemoryAppData } from "@/memory-app-data"

const NOW = Date.parse("2026-11-15T12:00:00Z")

afterEach(cleanup)

async function setup(status: "parked" | "running") {
  const data = createMemoryAppData(NOW)
  const parked = (await data.runs({ status: [status] }))[0]!
  const run = await data.run(parked.id)
  const [decision] = await data.decisions({ runId: run.id, status: ["pending"] })
  const openDecision = vi.fn()
  render(
    <AppActionsContext.Provider value={{ openDecision } as unknown as AppActions}>
      <AppDataProvider value={data}>
        <TooltipProvider>
          <ParkedCallout run={run} />
        </TooltipProvider>
      </AppDataProvider>
    </AppActionsContext.Provider>,
  )
  return { openDecision, decision }
}

test("una corrida estacionada avisa que no frena a nadie y lleva a la decisión con el botón o con D", async () => {
  const { openDecision, decision } = await setup("parked")

  const button = await screen.findByRole("button", { name: "Abrir decisión" })
  expect(screen.getByRole("status").textContent).toMatch(/no ocupa cupo en su carril y nada más espera/)
  fireEvent.click(button)
  fireEvent.keyDown(document.body, { key: "d" })

  expect(openDecision.mock.calls).toEqual([[decision!.id], [decision!.id]])
})

test("una corrida que no está estacionada no muestra nada", async () => {
  await setup("running")

  expect(screen.queryByRole("status")).toBeNull()
})
