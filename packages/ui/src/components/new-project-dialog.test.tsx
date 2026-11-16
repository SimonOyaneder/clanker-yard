// @vitest-environment jsdom
import type { NewProject } from "@clanker/api"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeAll, expect, test, vi } from "vitest"
import { AppDataProvider, type AppData } from "@/app-data"
import { NewProjectDialog } from "@/components/new-project-dialog"
import { createMemoryAppData } from "@/memory-app-data"
import { SEED_TECHLEAD, SEED_TOY } from "@/seed-flows"

const NOW = Date.parse("2026-11-15T12:00:00Z")

// cmdk mide y hace scroll, y Radix pide pointer capture: jsdom no tiene nada de eso.
beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Element.prototype.scrollIntoView = () => {}
  Element.prototype.hasPointerCapture = () => false
})
afterEach(cleanup)

// La app trae un solo flujo para elegir: para elegir otro, el de juguete se suma como si fuera tuyo.
const withToy = (data: AppData): Pick<AppData, "defs"> => ({
  defs: async (kind, opts) => {
    const defs = await data.defs(kind, opts)
    return kind === "flow" ? [...defs, { ...defs[0]!, slug: "juguete", scope: "user", body: SEED_TOY }] : defs
  },
})

function setup(override: Partial<AppData> = {}) {
  const data = createMemoryAppData(NOW)
  const createProject = vi.fn<AppData["createProject"]>((input) => data.createProject(input))
  const onOpenConnections = vi.fn()
  render(
    <AppDataProvider value={{ ...data, createProject, ...override }}>
      <NewProjectDialog open onOpenChange={() => {}} onCreated={() => {}} onOpenConnections={onOpenConnections} />
    </AppDataProvider>,
  )
  return { data, createProject, onOpenConnections }
}

const sent = (createProject: ReturnType<typeof setup>["createProject"]): NewProject => createProject.mock.calls[0]![0]
const create = () => fireEvent.click(screen.getByRole("button", { name: "Crear proyecto" }))
const fillName = (name: string) => fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: name } })
const chooseTracker = async (label: string) => {
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Tracker" }), { key: "Enter" })
  fireEvent.click(await screen.findByRole("option", { name: label }))
}

test("flujo y perfil llegan preseleccionados: techlead-clasico y eco", async () => {
  const { createProject } = setup()
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Flujo por defecto" }).textContent).toBe(SEED_TECHLEAD.name))
  expect(screen.getByRole("combobox", { name: "Perfil por defecto" }).textContent).toBe("eco")

  await chooseTracker("Local (para probar)")
  fillName("Uno")
  create()

  await waitFor(() => expect(createProject).toHaveBeenCalled())
  expect(sent(createProject)).toMatchObject({ defaultFlowId: "techlead-clasico", defaultProfileId: "eco" })
})

test("elegir otro flujo muestra su nombre y su slug en mono, y es el que se manda", async () => {
  const { createProject } = setup(withToy(createMemoryAppData(NOW)))
  const trigger = await screen.findByRole("combobox", { name: "Flujo por defecto" })
  await waitFor(() => expect(trigger.textContent).toBe(SEED_TECHLEAD.name))

  fireEvent.keyDown(trigger, { key: "Enter" })
  const option = await screen.findByRole("option", { name: /Juguete/ })
  expect(screen.getByRole("option", { name: new RegExp(SEED_TECHLEAD.name) }).textContent).toContain("techlead-clasico")
  expect(within(option).getByText("juguete").className).toContain("font-mono")
  fireEvent.click(option)
  await chooseTracker("Local (para probar)")
  fillName("Dos")
  create()

  await waitFor(() => expect(createProject).toHaveBeenCalled())
  expect(sent(createProject)).toMatchObject({ defaultFlowId: "juguete" })
})

test("cada perfil dice qué modelos usa", async () => {
  setup()
  fireEvent.keyDown(await screen.findByRole("combobox", { name: "Perfil por defecto" }), { key: "Enter" })

  expect(await screen.findByRole("option", { name: /eco/ })).toBeTruthy()
  expect(screen.getByText("dev sonnet high · reviews sonnet/haiku")).toBeTruthy()
})

test("sin flujos ni perfiles lo dice y el proyecto se crea sin defaults", async () => {
  const { createProject } = setup({ defs: async () => [] })
  expect(await screen.findByText("No hay flujos: el proyecto se crea sin uno por defecto.")).toBeTruthy()
  expect(screen.getByText("No hay perfiles: el proyecto se crea sin uno por defecto.")).toBeTruthy()

  await chooseTracker("Local (para probar)")
  fillName("Tres")
  create()

  await waitFor(() => expect(createProject).toHaveBeenCalled())
  expect(sent(createProject)).not.toHaveProperty("defaultFlowId")
  expect(sent(createProject)).not.toHaveProperty("defaultProfileId")
})

test("con Linear, los proyectos salen con los míos primero, se filtran por texto y la elección es el trackerRef", async () => {
  const { data, createProject } = setup()
  await chooseTracker("Linear")
  fillName("Cuatro")
  expect((screen.getByRole("button", { name: "Crear proyecto" }) as HTMLButtonElement).disabled).toBe(true)

  fireEvent.click(await screen.findByRole("combobox", { name: "Proyecto del tracker" }))
  const names = screen.getAllByRole("option").map((o) => o.textContent)
  expect(names).toEqual(["Boundaries de engines", "SOPORTE", "Facturación mensual", "Limpieza de feature flags"])
  expect(screen.getByText("Míos")).toBeTruthy()

  fireEvent.change(screen.getByPlaceholderText("Buscar proyecto"), { target: { value: "factura" } })
  const options = screen.getAllByRole("option")
  expect(options.map((o) => o.textContent)).toEqual(["Facturación mensual"])
  fireEvent.click(options[0]!)

  expect(screen.getByRole("combobox", { name: "Proyecto del tracker" }).textContent).toBe("Facturación mensual")
  const expected = (await data.trackerProjects("linear")).find((p) => p.name === "Facturación mensual")!
  create()
  await waitFor(() => expect(createProject).toHaveBeenCalled())
  expect(sent(createProject)).toMatchObject({ tracker: "linear", trackerRef: expected.ref.id, trackerAccount: expected.account })
})

test("con Linear sin conectar muestra el error del core y un botón a Conexiones", async () => {
  const data = createMemoryAppData(NOW)
  await data.disconnect("linear", "clanker-yard")
  const { onOpenConnections } = setup({ trackerProjects: data.trackerProjects })

  expect((await screen.findByRole("alert")).textContent).toContain("Linear no está conectado")
  fireEvent.click(screen.getByRole("button", { name: "Ir a Conexiones" }))

  expect(onOpenConnections).toHaveBeenCalled()
})

test("sin proyectos en la cuenta lo dice", async () => {
  setup({ trackerProjects: async () => [] })
  await chooseTracker("Linear")

  expect(await screen.findByText(/no tiene proyectos todavía/)).toBeTruthy()
})

test("parte en Linear y solo ofrece los trackers que el core sabe leer", async () => {
  setup()
  const tracker = screen.getByRole("combobox", { name: "Tracker" })
  expect(tracker.textContent).toBe("Linear")

  fireEvent.keyDown(tracker, { key: "Enter" })
  expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["Linear", "Local (para probar)"])
})

test("con dos workspaces, el proyecto que se elige guarda la cuenta de su workspace", async () => {
  const project = (id: string, name: string, account: string) => ({ ref: { tracker: "linear" as const, id }, name, mine: true, account })
  const { createProject } = setup({
    trackerProjects: async () => [project("a1", "Pagos", "acme"), project("b1", "Clanker Yard MVP", "clanker-yard")],
  })
  await chooseTracker("Linear")
  fillName("Cinco")

  fireEvent.click(await screen.findByRole("combobox", { name: "Proyecto del tracker" }))
  fireEvent.click(screen.getByRole("option", { name: /Clanker Yard MVP/ }))
  create()

  await waitFor(() => expect(createProject).toHaveBeenCalled())
  expect(sent(createProject)).toMatchObject({ tracker: "linear", trackerRef: "b1", trackerAccount: "clanker-yard" })
})

test("los defaults de proyectos nuevos de Ajustes mandan sobre los de siempre", async () => {
  const data = createMemoryAppData(NOW)
  await data.setProjectDefaults({ defaultFlowId: "juguete", defaultProfileId: "medio", parallel: 3 })
  const { createProject } = setup({ projectDefaults: data.projectDefaults, ...withToy(data) })
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Flujo por defecto" }).textContent).toBe("Juguete"))
  expect(screen.getByRole("combobox", { name: "Perfil por defecto" }).textContent).toBe("medio")
  expect((screen.getByLabelText("Corridas en paralelo") as HTMLInputElement).value).toBe("3")

  await chooseTracker("Local (para probar)")
  fillName("Tres")
  create()

  await waitFor(() => expect(createProject).toHaveBeenCalled())
  expect(sent(createProject)).toMatchObject({ defaultFlowId: "juguete", defaultProfileId: "medio", parallel: 3 })
})
