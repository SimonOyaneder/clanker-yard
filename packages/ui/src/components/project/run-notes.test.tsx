// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, expect, test } from "vitest"
import { AppDataProvider } from "@/app-data"
import { RunNotes } from "@/components/project/run-notes"
import { createMemoryAppData } from "@/demo/memory-app-data"

afterEach(cleanup)

test("la corrida muestra sus notas colapsadas, con cuántas hay y agrupadas por paso", async () => {
  const data = createMemoryAppData(Date.parse("2026-11-15T12:00:00Z"))
  const [note] = await data.decisions({ kind: ["review_note"] })
  const run = await data.run(note!.runId!)
  render(
    <AppDataProvider value={data}>
      <RunNotes run={run} />
    </AppDataProvider>,
  )

  const trigger = await screen.findByRole("button", { name: /Notas del agente/ })
  expect(trigger.textContent).toMatch(/1$/)
  expect(screen.queryByText(note!.title)).toBeNull()
  fireEvent.click(trigger)

  const step = run.steps.find((s) => s.id === note!.stepRunId)!
  expect(within(screen.getByRole("region", { name: `Notas de ${step.nodeId}` })).getByText(note!.title)).toBeTruthy()
})

test("una corrida sin notas no muestra la sección", async () => {
  const data = createMemoryAppData(Date.parse("2026-11-15T12:00:00Z"))
  const run = await data.run((await data.runs()).find((r) => r.id.endsWith("1"))!.id)
  const { container } = render(
    <AppDataProvider value={data}>
      <RunNotes run={run} />
    </AppDataProvider>,
  )
  await new Promise((r) => setTimeout(r, 20))

  expect(container.textContent).toBe("")
})
