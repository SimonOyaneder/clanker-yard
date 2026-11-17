// @vitest-environment jsdom
import type { QueueEntry } from "@clanker/api"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ComponentProps } from "react"
import { afterEach, beforeAll, expect, test, vi } from "vitest"
import { AppDataProvider } from "@/app-data"
import { CommandPalette } from "@/components/command-palette"
import { PrCommandsProvider } from "@/components/prs/pr-commands"
import { RunCommandsProvider } from "@/components/run/run-commands"
import type { SettingsControls } from "@/components/project-settings/settings-view"
import type { SummaryControls } from "@/hooks/use-summary-controls"
import { HostProvider, type Host } from "@/host"
import { AppActionsContext, type AppActions } from "@/lib/app-context"
import { createMemoryAppData } from "@/demo/memory-app-data"
import { openPrsOf, type OpenPr } from "@/lib/prs/prs"

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

async function setup(extra: { projectTab?: ComponentProps<typeof CommandPalette>["projectTab"]; settings?: SettingsControls; summary?: SummaryControls; prs?: OpenPr[] } = {}) {
  const data = createMemoryAppData(NOW)
  const [project] = await data.projects()
  const issues = await data.issues(project!.id)
  const [a, b] = issues.filter((i) => i.status === "todo")
  const queue: QueueEntry[] = [
    { issue: a!, state: "ready", reason: "lista", base: { kind: "default" }, dependsOn: [] },
    { issue: b!, state: "blocked", skipped: true, reason: "saltada a mano" },
  ]
  const actions = { setParallel: vi.fn(), setLanes: vi.fn(), boostIssue: vi.fn(), skipIssue: vi.fn(), goModule: vi.fn() }
  const host = { openExternal: vi.fn() } as unknown as Host
  const prs = extra.prs ?? []
  render(
    <AppDataProvider value={data}>
      <RunCommandsProvider>
        <HostProvider value={host}>
          <AppActionsContext.Provider value={actions as unknown as AppActions}>
            <PrCommandsProvider prs={prs} projects={[project!]} onOpenRun={() => {}} onOpenLocal={() => {}}>
            <CommandPalette
              open
              onOpenChange={() => {}}
              projects={[project!]}
              current={project!}
              runs={[]}
              issues={issues}
              queue={queue}
              prs={prs}
              prsActive={prs.length > 0}
              learnings={null}
              pendingDecisions={[]}
              onUndoDecision={null}
              onDecision={null}
              projectTab={extra.projectTab ?? null}
              settings={extra.settings ?? null}
              summary={extra.summary ?? null}
              onRunTab={null}
              runCaps={null}
              onStep={null}
            />
            </PrCommandsProvider>
          </AppActionsContext.Provider>
        </HostProvider>
      </RunCommandsProvider>
    </AppDataProvider>,
  )
  return { actions, host, data, project: project!, a: a!, b: b! }
}

test("un local se busca por branch y título, abre Stacks y no ofrece acciones de GitHub", async () => {
  const local = openPrsOf(await createMemoryAppData(NOW).openPrs()).find((p) => p.local !== null)!
  const { actions, host } = await setup({ prs: [local] })

  fireEvent.click(screen.getByText(local.local!.title))
  expect(actions.goModule).toHaveBeenCalledWith("prs")
  expect(host.openExternal).not.toHaveBeenCalled()
  expect(screen.queryByText(/Mergear|Marcar hold|Pedir review del bot|Rebasear/)).toBeNull()
  expect(screen.getByText(local.local!.branch)).toBeTruthy()
})

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

test("Cambiar capacidad de carriles sube o baja un carril de la máquina; en 1 no se puede bajar", async () => {
  const { actions, data } = await setup()
  const lanes = await data.lanes()

  fireEvent.click(screen.getByText("Cambiar capacidad de carriles"))
  fireEvent.click(await screen.findByText(`Subir carril mantenimiento a ${lanes.maintenance.capacity + 1}`))
  expect(actions.setLanes).toHaveBeenCalledWith("maintenance", lanes.maintenance.capacity + 1, lanes.maintenance.capacity)
})

test("las pestañas del proyecto y los filtros del Resumen son acciones de ⌘K", async () => {
  const onTab = vi.fn()
  const controls = { range: { preset: "all", from: "", to: "" }, origin: "all", asTables: false, setRange: vi.fn(), setOrigin: vi.fn(), toggleTables: vi.fn() } as unknown as SummaryControls
  await setup({ projectTab: { tab: "operation", onTab }, summary: controls })

  fireEvent.click(screen.getByText(/^Resumen de /))
  expect(onTab).toHaveBeenCalledWith("summary")
  fireEvent.click(screen.getByText("Rango: últimos 7 días"))
  expect(controls.setRange).toHaveBeenCalledWith({ preset: "7d", from: "", to: "" })
  fireEvent.click(screen.getByText("Origen: importadas"))
  expect(controls.setOrigin).toHaveBeenCalledWith("imported")
  fireEvent.click(screen.getByText("Ver los datos como tablas"))
  expect(controls.toggleTables).toHaveBeenCalled()
})
