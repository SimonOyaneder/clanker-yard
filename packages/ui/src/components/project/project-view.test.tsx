// @vitest-environment jsdom
import type { QueueEntry } from "@clanker/api"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import { ProjectView } from "@/components/project/project-view"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppActionsContext, type AppActions } from "@/lib/app-context"
import { createMemoryAppData } from "@/memory-app-data"

const NOW = Date.parse("2026-11-15T12:00:00Z")

afterEach(cleanup)

async function setup(entries: (issues: QueueEntry["issue"][]) => QueueEntry[]) {
  const data = createMemoryAppData(NOW)
  const project = (await data.projects())[0]!
  const issues = await data.issues(project.id)
  const startRun = vi.fn(() => Promise.resolve())
  const actions = { startRun, refresh: () => {}, openRun: () => {} } as unknown as AppActions
  render(
    <AppActionsContext.Provider value={actions}>
      <TooltipProvider>
        <ProjectView project={project} runs={[]} issues={issues} queue={entries(issues)} />
      </TooltipProvider>
    </AppActionsContext.Provider>,
  )
  return { startRun, issues }
}

test("En cola muestra la cola del core: cada issue con su estado y solo las listas se pueden lanzar", async () => {
  const { startRun, issues } = await setup(([a, b, c]) => [
    { issue: a!, state: "ready", reason: "lista sobre la branch por defecto", base: { kind: "default" }, dependsOn: [] },
    { issue: b!, state: "waiting", reason: "espera a ENG-9178, en curso" },
    { issue: c!, state: "blocked", reason: "bloqueada por ENG-9183 (Todo): no tiene PR abierto ni corrida en curso" },
  ])

  const rows = screen.getAllByRole("listitem")
  expect(rows.map((row) => within(row).getByText(/^(lista|esperando|bloqueada)$/).textContent)).toEqual(["lista", "esperando", "bloqueada"])
  const buttons = rows.map((row) => within(row).getByRole("button", { name: /Correr/ }) as HTMLButtonElement)
  expect(buttons.map((button) => button.disabled)).toEqual([false, true, true])

  fireEvent.click(buttons[0]!)
  expect(startRun).toHaveBeenCalledWith(expect.anything(), issues[0])
})

test("una issue que el core no puso en la cola no aparece aunque esté en todo", async () => {
  await setup(([a]) => [{ issue: a!, state: "ready", reason: "lista sobre la branch por defecto", base: { kind: "default" }, dependsOn: [] }])

  expect(screen.getAllByRole("listitem")).toHaveLength(1)
})
