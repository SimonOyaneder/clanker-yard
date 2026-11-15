// @vitest-environment jsdom
import type { QueueEntry } from "@clanker/api"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, expect, test, vi } from "vitest"
import { AppDataProvider } from "@/app-data"
import { CommandPalette } from "@/components/command-palette"
import { RunCommandsProvider } from "@/components/project/run-commands"
import { HostProvider, type Host } from "@/host"
import { AppActionsContext, type AppActions } from "@/lib/app-context"
import { createMemoryAppData } from "@/memory-app-data"

const NOW = Date.parse("2026-11-15T12:00:00Z")

// cmdk mide y hace scroll: jsdom no tiene ninguna de las dos cosas.
beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Element.prototype.scrollIntoView = () => {}
})
afterEach(cleanup)

async function setup() {
  const data = createMemoryAppData(NOW)
  const [project] = await data.projects()
  const issues = await data.issues(project!.id)
  const [a, b] = issues.filter((i) => i.status === "todo")
  const queue: QueueEntry[] = [
    { issue: a!, state: "ready", reason: "lista", base: { kind: "default" }, dependsOn: [] },
    { issue: b!, state: "blocked", skipped: true, reason: "saltada a mano" },
  ]
  const actions = { setParallel: vi.fn(), boostIssue: vi.fn(), skipIssue: vi.fn() }
  render(
    <AppDataProvider value={data}>
      <RunCommandsProvider>
        <HostProvider value={{ openExternal: vi.fn() } as unknown as Host}>
          <AppActionsContext.Provider value={actions as unknown as AppActions}>
            <CommandPalette
              open
              onOpenChange={() => {}}
              projects={[project!]}
              current={project!}
              runs={[]}
              issues={issues}
              queue={queue}
              onToggleSidebar={() => {}}
              onOpenShortcuts={() => {}}
              prs={[]}
              onGoPrs={() => {}}
              onGoInbox={() => {}}
              pendingDecisions={[]}
              onOpenDecision={() => {}}
              onUndoDecision={null}
              onDecision={null}
              onRunTab={null}
              runCaps={null}
              onStep={null}
            />
          </AppActionsContext.Provider>
        </HostProvider>
      </RunCommandsProvider>
    </AppDataProvider>,
  )
  return { actions, data, project: project!, a: a!, b: b! }
}

test("subir, sacar o devolver una issue de la cola están en ⌘K", async () => {
  const { actions, project, a, b } = await setup()

  fireEvent.click(screen.getByText(/^Subir/))
  expect(actions.boostIssue).toHaveBeenCalledWith(project, a)
  fireEvent.click(screen.getByText(/^No tomar/))
  expect(actions.skipIssue).toHaveBeenCalledWith(project, a, true)
  fireEvent.click(screen.getByText(/^Volver a la cola/))
  expect(actions.skipIssue).toHaveBeenCalledWith(project, b, false)
})

test("Cambiar paralelismo abre una sub-página con 1 a 6", async () => {
  const { actions, project } = await setup()

  fireEvent.click(screen.getByText("Cambiar paralelismo"))
  expect(screen.getAllByText(/^\d corridas? a la vez$/)).toHaveLength(6)
  fireEvent.click(screen.getByText("3 corridas a la vez"))

  expect(actions.setParallel).toHaveBeenCalledWith(project, 3)
})
