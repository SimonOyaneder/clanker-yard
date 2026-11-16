// @vitest-environment jsdom
import type { Breaker, ClankerProject, Decision, Lanes, QueueEntry, Run } from "@clanker/api"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import { AppDataProvider } from "@/app-data"
import { RunCommandsProvider } from "@/components/project/run-commands"
import { ProjectFrame, ProjectView } from "@/components/project/project-view"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppActionsContext, type AppActions } from "@/lib/app-context"
import { createMemoryAppData } from "@/memory-app-data"

const NOW = Date.parse("2026-11-15T12:00:00Z")
const LANES = { dev: { active: 1, capacity: 4 }, maintenance: { active: 1, capacity: 2 } }
const id = (prefix: string, n: number) => `${prefix}_${String(n).padStart(26, "0")}`

afterEach(cleanup)

interface Scenario {
  entries?: (issues: QueueEntry["issue"][]) => QueueEntry[]
  queueError?: string
  runs?: (runs: Run[]) => Run[]
  decisions?: Decision[]
  breakers?: Breaker[]
  project?: Partial<ClankerProject>
  lanes?: Lanes
}

async function setup({ entries = () => [], queueError, runs = () => [], decisions = [], breakers = [], project: overrides = {}, lanes = LANES }: Scenario = {}) {
  const data = createMemoryAppData(NOW)
  const project = { ...(await data.projects())[0]!, ...overrides }
  const issues = await data.issues(project.id)
  const memoryRuns = await data.runs({ projectId: project.id })
  const actions = {
    startRun: vi.fn(() => Promise.resolve()),
    setParallel: vi.fn(() => Promise.resolve()),
    setLanes: vi.fn(() => Promise.resolve()),
    skipIssue: vi.fn(() => Promise.resolve()),
    boostIssue: vi.fn(() => Promise.resolve()),
    refresh: () => {},
    editQueueFilters: vi.fn(),
    openRun: vi.fn(),
    openExternal: vi.fn(),
  }
  render(
    <AppDataProvider value={data}>
      <RunCommandsProvider>
        <AppActionsContext.Provider value={actions as unknown as AppActions}>
          <TooltipProvider>
            <ProjectFrame project={project} tab="operation" onTab={() => {}}>
              <ProjectView project={project} runs={runs(memoryRuns)} issues={issues} queue={entries(issues)} queueError={queueError} decisions={decisions} lanes={lanes} breakers={breakers} prs={[]} />
            </ProjectFrame>
          </TooltipProvider>
        </AppActionsContext.Provider>
      </RunCommandsProvider>
    </AppDataProvider>,
  )
  return { actions, issues, project, memoryRuns, data }
}

const ready = (issue: QueueEntry["issue"]): QueueEntry => ({ issue, state: "ready", reason: "lista sobre la branch por defecto", base: { kind: "default" }, dependsOn: [] })
const stat = (label: string) => within(screen.getByLabelText("Métricas")).getByText(label).parentElement!

test("En cola muestra la cola del core: cada issue con su estado y solo las listas se pueden lanzar", async () => {
  const { actions, issues } = await setup({
    entries: ([a, b, c]) => [
      ready(a!),
      { issue: b!, state: "waiting", reason: "espera a ENG-9178, en curso" },
      { issue: c!, state: "blocked", reason: "bloqueada por ENG-9183 (Todo): no tiene PR abierto ni corrida en curso" },
    ],
  })

  const rows = screen.getAllByRole("listitem")
  expect(rows.map((row) => within(row).getByText(/^(lista|esperando|bloqueada)$/).textContent)).toEqual(["lista", "esperando", "bloqueada"])
  const buttons = rows.map((row) => within(row).getByRole("button", { name: /Correr/ }) as HTMLButtonElement)
  expect(buttons.map((button) => button.disabled)).toEqual([false, true, true])

  fireEvent.click(buttons[0]!)
  expect(actions.startRun).toHaveBeenCalledWith(expect.anything(), issues[0])
})

test("una issue que el core no puso en la cola no aparece aunque esté en todo", async () => {
  await setup({ entries: ([a]) => [ready(a!)] })

  expect(screen.getAllByRole("listitem")).toHaveLength(1)
})

test("las bloqueadas van en su grupo, cada una con su motivo a la vista", async () => {
  await setup({
    entries: ([a, b]) => [ready(a!), { issue: b!, state: "blocked", reason: "bloqueada por ENG-9183 (Todo): no tiene PR abierto ni corrida en curso" }],
  })

  const blocked = screen.getByRole("heading", { name: /Bloqueadas/ }).closest("section")!
  expect(within(blocked).getByText(/bloqueada por ENG-9183/, { selector: "span.truncate" })).toBeTruthy()
  expect(within(screen.getByRole("heading", { name: /En cola/ }).closest("section")!).queryByText(/bloqueada por ENG-9183/)).toBeNull()
})

test("una cola vacía dice qué filtro la dejó vacía y ofrece editarlos", async () => {
  const { actions } = await setup({ runs: (runs) => runs, project: { queueFilter: { status: ["todo"], excludeLabels: ["no-clanker"] } } })

  expect(screen.getByText(/0 issues en todo sin el label no-clanker/)).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Editar filtros" }))
  expect(actions.editQueueFilters).toHaveBeenCalledOnce()
})

test("una cola que el core no pudo calcular dice por qué y deja ver el resto de la operación", async () => {
  await setup({ queueError: "No hay una cuenta de Linear conectada: conéctala en Conexiones (connections.linearAuth)." })

  expect(screen.getByText(/No se pudo calcular la cola\. No hay una cuenta de Linear conectada/)).toBeTruthy()
  expect(stat("Carril dev")).toBeTruthy()
})

// Un rebase en mantenimiento mientras dev está lleno, una corrida estacionada que le prestó su PR y un breaker abierto.
const lanesScenario = (runs: Run[]): Run[] => {
  const running = runs.find((r) => r.status === "running")!
  const parked = runs.find((r) => r.status === "parked")!
  return [
    running,
    parked,
    { ...running, id: id("run", 50) as Run["id"], lane: "maintenance", flow: { slug: "rebase", version: 1 }, subject: { type: "pr", id: "pr_1" }, borrowedFromRunId: parked.id },
  ]
}

test("los carriles se ven por separado: el rebase corre en mantenimiento con dev lleno", async () => {
  await setup({ runs: lanesScenario })

  const dev = screen.getByRole("region", { name: "Carril dev" })
  const maintenance = screen.getByRole("region", { name: "Carril mantenimiento" })
  expect(within(dev).getByText("1/1")).toBeTruthy()
  expect(within(dev).getByText("ENG-9178")).toBeTruthy()
  expect(within(maintenance).getByText("1/2")).toBeTruthy()
  expect(within(maintenance).getByText("rebase v1")).toBeTruthy()
  expect(within(maintenance).getByText(/PR prestado de ENG-9183/)).toBeTruthy()
  expect(stat("Carril dev").textContent).toContain("1/1")
  expect(stat("Carril mantenimiento").textContent).toContain("1/2")
})

const openLanes = () => fireEvent.click(screen.getAllByRole("button", { name: "Cambiar la capacidad de los carriles" })[0]!)

test("el popover de carriles sube y baja la capacidad con lo que hay en uso", async () => {
  const { actions } = await setup()

  openLanes()
  const dev = await screen.findByRole("group", { name: "Carril dev" })
  expect(within(dev).getByText("en uso: 1")).toBeTruthy()
  expect(within(dev).getByLabelText("Capacidad del carril dev").textContent).toBe("4")
  fireEvent.click(within(dev).getByRole("button", { name: "Subir la capacidad del carril dev" }))
  expect(actions.setLanes).toHaveBeenLastCalledWith("dev", 5, 4)
  fireEvent.click(within(screen.getByRole("group", { name: "Carril mantenimiento" })).getByRole("button", { name: "Bajar la capacidad del carril mantenimiento" }))
  expect(actions.setLanes).toHaveBeenLastCalledWith("maintenance", 1, 2)
  expect(screen.getByText(/el tope de la máquina entera/)).toBeTruthy()
  expect(screen.queryByText(/Las corridas en curso siguen/)).toBeNull()
})

test("la capacidad de un carril no baja de 1", async () => {
  await setup({ lanes: { dev: { active: 0, capacity: 1 }, maintenance: { active: 0, capacity: 2 } } })

  openLanes()
  const down = within(await screen.findByRole("group", { name: "Carril dev" })).getByRole("button", { name: "Bajar la capacidad del carril dev" }) as HTMLButtonElement
  expect(down.disabled).toBe(true)
})

test("con la capacidad por debajo de lo que corre avisa que las corridas en curso siguen", async () => {
  await setup({ lanes: { dev: { active: 3, capacity: 2 }, maintenance: { active: 0, capacity: 2 } } })

  openLanes()
  const dev = await screen.findByRole("group", { name: "Carril dev" })
  expect(within(dev).getByText("Las corridas en curso siguen; no entran nuevas hasta que baje.")).toBeTruthy()
  expect(within(screen.getByRole("group", { name: "Carril mantenimiento" })).queryByText(/Las corridas en curso siguen/)).toBeNull()
})

test("cada corrida en un carril lleva el flujo real como stepper, con su paso actual", async () => {
  await setup({ runs: lanesScenario })

  const stepper = await within(screen.getByRole("region", { name: "Carril dev" })).findByRole("list", { name: "Pasos del flujo" })
  const steps = within(stepper).getAllByRole("listitem")
  expect(steps).toHaveLength(10)
  expect(steps.filter((s) => s.getAttribute("aria-current") === "step").map((s) => s.textContent)).toEqual(["reviews: corriendo"])
})

test("una corrida estacionada va aparte con su motivo, su decisión y el préstamo de su PR", async () => {
  const { memoryRuns } = await setup({
    runs: lanesScenario,
    decisions: [
      {
        id: id("dec", 7),
        projectId: id("prj", 1),
        runId: id("run", 3),
        stepRunId: null,
        subject: null,
        kind: "needs_human",
        title: "ENG-9183 se pasó del tope de gasto",
        body: "",
        options: ["retry", "cancel"],
        status: "pending",
        resolution: null,
        resolvedBy: null,
        createdAt: NOW,
        resolvedAt: null,
      } as Decision,
    ],
  })

  const parked = screen.getByRole("heading", { name: /Estacionadas/ }).closest("section")!
  expect(memoryRuns.some((r) => r.status === "parked")).toBe(true)
  expect(within(parked).getByText("ENG-9183 se pasó del tope de gasto")).toBeTruthy()
  expect(within(parked).getByText("necesita a una persona")).toBeTruthy()
  expect(within(parked).getByText(/Su PR está prestado al carril de mantenimiento/)).toBeTruthy()
  expect(stat("Decisiones pendientes").textContent).toContain("1")
  // No ocupa cupo: dev sigue en 1/1 con la corrida en curso.
  expect(within(screen.getByRole("region", { name: "Carril dev" })).getByText("1/1")).toBeTruthy()
})

test("un breaker abierto muestra la causa, qué pausa y el próximo reintento", async () => {
  const breaker: Breaker = {
    scope: "github",
    label: "github",
    cause: "rate_limited",
    reason: "GitHub cortó las requests por cuota.",
    openedAt: NOW - 60_000,
    probes: 0,
    nextProbeAt: NOW + 40 * 60_000,
    decisionId: id("dec", 9) as Breaker["decisionId"],
  }
  await setup({ breakers: [breaker, { ...breaker, scope: `repo:${id("repo", 99)}`, label: "repo otro" }] })

  const strip = screen.getByRole("region", { name: "Breakers abiertos" })
  expect(within(strip).getByText("En pausa: github")).toBeTruthy()
  expect(within(strip).getByText("límite de GitHub")).toBeTruthy()
  expect(within(strip).getByText(/No se publica a GitHub/)).toBeTruthy()
  expect(within(strip).getByText(/Próximo reintento/)).toBeTruthy()
  // El de un repo que el proyecto no usa no le afecta.
  expect(within(strip).queryByText("En pausa: repo otro")).toBeNull()
})

test("sin breakers no hay franja", async () => {
  await setup()

  expect(screen.queryByRole("region", { name: "Breakers abiertos" })).toBeNull()
})

test("el botón principal pausa el proyecto activo y reanuda el pausado", async () => {
  const active = await setup()
  const pause = vi.spyOn(active.data, "pauseProject")
  fireEvent.click(screen.getByRole("button", { name: /Pausar/ }))
  expect(pause).toHaveBeenCalledWith(active.project.id)

  cleanup()
  const paused = await setup({ project: { status: "paused" } })
  const resume = vi.spyOn(paused.data, "resumeProject")
  fireEvent.click(screen.getByRole("button", { name: /Reanudar/ }))
  expect(resume).toHaveBeenCalledWith(paused.project.id)
})

test("el menú contextual de una issue la sube en la cola o la saca", async () => {
  const { actions, issues } = await setup({ entries: ([a]) => [ready(a!)] })
  const row = screen.getAllByRole("listitem")[0]!

  fireEvent.contextMenu(within(row).getByText(issues[0]!.title))
  fireEvent.click(await screen.findByRole("menuitem", { name: /Subirla en la cola/ }))
  expect(actions.boostIssue).toHaveBeenCalledWith(expect.anything(), issues[0])

  fireEvent.contextMenu(within(row).getByText(issues[0]!.title))
  fireEvent.click(await screen.findByRole("menuitem", { name: /No tomarla/ }))
  expect(actions.skipIssue).toHaveBeenCalledWith(expect.anything(), issues[0], true)
})

test("una issue saltada sale como saltada y se devuelve a la cola con un click", async () => {
  const { actions, issues } = await setup({
    entries: ([a]) => [{ issue: a!, state: "blocked", skipped: true, reason: "saltada a mano: el usuario pidió que el Scheduler no la lance (projects.skipIssue)" }],
  })

  expect(screen.getByText("saltada")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: /Volver/ }))
  expect(actions.skipIssue).toHaveBeenCalledWith(expect.anything(), issues[0], false)
})

test("las pestañas Operación y Resumen están en el encabezado del proyecto y la actual queda marcada", async () => {
  const data = createMemoryAppData(NOW)
  const project = (await data.projects())[0]!
  const onTab = vi.fn()
  render(
    <AppDataProvider value={data}>
      <RunCommandsProvider>
        <AppActionsContext.Provider value={{ refresh: () => {} } as unknown as AppActions}>
          <TooltipProvider>
            <ProjectFrame project={project} tab="operation" onTab={onTab}>
              <p>cuerpo de la pestaña</p>
            </ProjectFrame>
          </TooltipProvider>
        </AppActionsContext.Provider>
      </RunCommandsProvider>
    </AppDataProvider>,
  )

  // Al enfocar la pestaña se abre su tooltip, que mide con un ResizeObserver que jsdom no trae.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  expect(screen.getByRole("tab", { name: "Operación" }).getAttribute("aria-selected")).toBe("true")
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Resumen" }))
  expect(onTab).toHaveBeenCalledWith("summary")
})
