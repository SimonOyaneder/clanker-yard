// @vitest-environment jsdom
import type { QueueEntry } from "@clanker/api"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import type { ComponentProps } from "react"
import { afterEach, beforeAll, expect, test, vi } from "vitest"
import { AppDataProvider } from "@/app-data"
import { CommandPalette } from "@/components/command-palette"
import { PrCommandsProvider, usePrCommands } from "@/components/prs/pr-commands"
import type { PrControls } from "@/components/prs/pr-view"
import { CHAT_KEYS, type ChatAction, type ChatActionId } from "@/hooks/use-pr-chat"
import { RunCommandsProvider } from "@/components/run/run-commands"
import type { SettingsControls } from "@/components/project-settings/settings-view"
import type { SummaryControls } from "@/hooks/use-summary-controls"
import { HostProvider, type Host } from "@/host"
import { AppActionsContext, type AppActions } from "@/lib/app-context"
import { createMemoryAppData } from "@/demo/memory-app-data"
import { openPrsOf, titleOf, type OpenPr } from "@/lib/prs/prs"

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

function PrSelection({ prs }: { prs: OpenPr[] }) {
  const commands = usePrCommands()
  return prs.map((pr) => <button key={pr.id} onClick={() => commands.select(pr.id)}>Seleccionar {titleOf(pr)}</button>)
}

async function setup(extra: { projectTab?: ComponentProps<typeof CommandPalette>["projectTab"]; settings?: SettingsControls; summary?: SummaryControls; prs?: OpenPr[]; pr?: PrControls } = {}) {
  const data = createMemoryAppData(NOW)
  const [project] = await data.projects()
  const issues = await data.issues(project!.id)
  const [a, b] = issues.filter((i) => i.status === "todo")
  const queue: QueueEntry[] = [
    { issue: a!, state: "ready", reason: "lista", base: { kind: "default" }, dependsOn: [] },
    { issue: b!, state: "blocked", skipped: true, reason: "saltada a mano" },
  ]
  const actions = { setParallel: vi.fn(), setLanes: vi.fn(), boostIssue: vi.fn(), skipIssue: vi.fn(), goModule: vi.fn(), startRun: vi.fn() }
  const host = { openExternal: vi.fn() } as unknown as Host
  const openPr = vi.fn()
  const prs = extra.prs ?? []
  render(
    <AppDataProvider value={data}>
      <RunCommandsProvider>
        <HostProvider value={host}>
          <AppActionsContext.Provider value={actions as unknown as AppActions}>
            <PrCommandsProvider prs={prs} projects={[project!]} onOpenRun={() => {}} onOpenPr={openPr}>
            <PrSelection prs={prs} />
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
              pr={extra.pr}
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
  return { actions, host, data, project: project!, a: a!, b: b!, openPr }
}

test("solo ofrece correr las issues ready de la cola, no las todo que esperan o se saltaron", async () => {
  const { actions, project, a, b } = await setup()
  const group = screen.getByRole("group", { name: `Correr en ${project.name}` })

  expect(within(group).queryByText(b.title)).toBeNull()
  fireEvent.click(within(group).getByText(a.title))
  expect(actions.startRun).toHaveBeenCalledWith(project, a)
})

test("un local se busca por branch y título, abre el detalle y no ofrece acciones de GitHub", async () => {
  const local = openPrsOf(await createMemoryAppData(NOW).openPrs()).find((p) => p.local !== null)!
  const { actions, host, openPr } = await setup({ prs: [local] })

  fireEvent.change(screen.getByRole("combobox"), { target: { value: local.local!.branch } })
  fireEvent.click(screen.getByText(local.local!.title))
  expect(openPr).toHaveBeenCalledWith(local.id)
  expect(actions.goModule).not.toHaveBeenCalled()
  expect(host.openExternal).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } })
  expect(screen.queryByText(/Mergear|Marcar hold|Pedir review del bot|Rebasear|Abrir PR en GitHub/)).toBeNull()
  fireEvent.click(screen.getByText("Ver PR"))
  expect(openPr).toHaveBeenCalledTimes(2)
  expect(screen.getByText(local.local!.branch)).toBeTruthy()
})

test("buscar un remoto abre el detalle interno, no GitHub", async () => {
  const remote = openPrsOf(await createMemoryAppData(NOW).openPrs()).find((p) => p.state !== null)!
  const { host, openPr } = await setup({ prs: [remote] })

  fireEvent.change(screen.getByRole("combobox"), { target: { value: titleOf(remote) } })
  fireEvent.click(screen.getByText(titleOf(remote)))

  expect(openPr).toHaveBeenCalledWith(remote.id)
  expect(host.openExternal).not.toHaveBeenCalled()
})

test("la paleta del chat comparte acciones, atajos y restricciones con el panel", async () => {
  const actions: Record<ChatActionId, ChatAction> = {
    send: { label: "Enviar mensaje", keys: CHAT_KEYS.send, reason: "Escribe un mensaje para enviar.", run: vi.fn() },
    interrupt: { label: "Interrumpir turno", keys: CHAT_KEYS.interrupt, reason: "No hay un turno en curso.", run: vi.fn() },
    reset: { label: "Reiniciar chat", keys: CHAT_KEYS.reset, reason: null, run: vi.fn() },
    view: { label: "Ver cambios", keys: CHAT_KEYS.view, reason: null, run: vi.fn() },
    apply: { label: "Aplicar propuesta", keys: CHAT_KEYS.apply, reason: "Este PR no lo abrió Clanker Yard.", run: vi.fn() },
    discard: { label: "Descartar propuesta", keys: CHAT_KEYS.discard, reason: null, run: vi.fn() },
  }
  const toggle = vi.fn()
  await setup({ pr: { reload: vi.fn(), mode: "unified", toggleMode: vi.fn(), prevCommit: null, nextCommit: null, allCommits: null, chat: { open: true, toggle, actions } } })
  for (const action of Object.values(actions)) {
    const option = screen.getByRole("option", { name: new RegExp(action.label) })
    expect(option.getAttribute("aria-disabled")).toBe(action.reason ? "true" : "false")
    expect(within(option).getByText(action.keys)).toBeTruthy()
    if (action.reason) expect(option.textContent).toContain(action.reason)
  }
  fireEvent.click(screen.getByRole("option", { name: /Aplicar propuesta/ }))
  expect(actions.apply.run).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("option", { name: /Ver cambios/ }))
  expect(actions.view.run).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole("option", { name: /Plegar chat/ }))
  expect(toggle).toHaveBeenCalledOnce()
})

test("la paleta abre GitHub para el PR seleccionado y sigue los cambios de selección del detalle", async () => {
  const prs = openPrsOf(await createMemoryAppData(NOW).openPrs())
  const remotes = prs.filter((p) => p.state !== null).slice(0, 2)
  const local = prs.find((p) => p.local !== null)!
  const { host, openPr } = await setup({ prs: [...remotes, local] })

  for (const pr of remotes) {
    fireEvent.click(screen.getByText(`Seleccionar ${titleOf(pr)}`))
    const action = screen.getByRole("option", { name: /Abrir PR en GitHub/ })
    expect(within(action).getByText("O")).toBeTruthy()
    fireEvent.click(action)
    expect(host.openExternal).toHaveBeenLastCalledWith(pr.state!.url)
  }
  fireEvent.click(screen.getByText(`Seleccionar ${titleOf(local)}`))
  expect(screen.queryByRole("option", { name: /Abrir PR en GitHub/ })).toBeNull()
  expect(openPr).not.toHaveBeenCalled()
})

test("los controles del diff siguen disponibles en la paleta del detalle remoto", async () => {
  const remote = openPrsOf(await createMemoryAppData(NOW).openPrs()).find((p) => p.state !== null)!
  const controls: PrControls = { reload: vi.fn(), mode: "split", toggleMode: vi.fn(), prevCommit: vi.fn(), nextCommit: vi.fn(), allCommits: vi.fn() }
  await setup({ prs: [remote], pr: controls })
  fireEvent.click(screen.getByText(`Seleccionar ${titleOf(remote)}`))

  fireEvent.click(screen.getByText("Ver el diff unificado"))
  fireEvent.click(screen.getByText("Commit anterior"))
  fireEvent.click(screen.getByText("Commit siguiente"))
  fireEvent.click(screen.getByText("Ver todos los commits"))

  for (const command of [controls.toggleMode, controls.prevCommit, controls.nextCommit, controls.allCommits]) expect(command).toHaveBeenCalledOnce()
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
