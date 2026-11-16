// @vitest-environment jsdom
import type { NewProject } from "@clanker/api"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeAll, expect, test, vi } from "vitest"
import { AppDataProvider, type AppData } from "@/app-data"
import { NewProjectDialog } from "@/components/new-project-dialog"
import { createMemoryAppData } from "@/memory-app-data"

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
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Flujo por defecto" }).textContent).toBe("Techlead clásico"))
  expect(screen.getByRole("combobox", { name: "Perfil por defecto" }).textContent).toBe("eco")

  fillName("Uno")
  create()

  await waitFor(() => expect(createProject).toHaveBeenCalled())
  expect(sent(createProject)).toMatchObject({ defaultFlowId: "techlead-clasico", defaultProfileId: "eco" })
})

test("elegir otro flujo muestra su nombre y su slug en mono, y es el que se manda", async () => {
  const { createProject } = setup()
  const trigger = await screen.findByRole("combobox", { name: "Flujo por defecto" })
  await waitFor(() => expect(trigger.textContent).toBe("Techlead clásico"))

  fireEvent.keyDown(trigger, { key: "Enter" })
  const option = await screen.findByRole("option", { name: /Juguete/ })
  expect(screen.getByRole("option", { name: /Techlead clásico/ }).textContent).toContain("techlead-clasico")
  expect(within(option).getByText("juguete").className).toContain("font-mono")
  fireEvent.click(option)
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
  expect(names).toEqual(["Boundaries de engines", "Clanker Yard MVP", "Facturación mensual", "Limpieza de feature flags"])
  expect(screen.getByText("Míos")).toBeTruthy()

  fireEvent.change(screen.getByPlaceholderText("Buscar proyecto"), { target: { value: "facturacion" } })
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
  const { data, onOpenConnections } = setup()
  await data.disconnect("linear", "clanker-yard")
  await chooseTracker("Linear")

  expect((await screen.findByRole("alert")).textContent).toContain("Linear no está conectado")
  fireEvent.click(screen.getByRole("button", { name: "Ir a Conexiones" }))

  expect(onOpenConnections).toHaveBeenCalled()
})

test("sin proyectos en la cuenta lo dice", async () => {
  setup({ trackerProjects: async () => [] })
  await chooseTracker("Linear")

  expect(await screen.findByText(/no tiene proyectos todavía/)).toBeTruthy()
})

test("un tracker sin listado (Jira) deja el campo de texto con el id", async () => {
  const { createProject } = setup()
  await chooseTracker("Jira")

  fireEvent.change(screen.getByLabelText("Proyecto del tracker"), { target: { value: "PROJ-1" } })
  fillName("Cinco")
  create()

  await waitFor(() => expect(createProject).toHaveBeenCalled())
  expect(sent(createProject)).toMatchObject({ tracker: "jira", trackerRef: "PROJ-1" })
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
  const { createProject } = setup({ projectDefaults: data.projectDefaults })
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Flujo por defecto" }).textContent).toBe("Juguete"))
  expect(screen.getByRole("combobox", { name: "Perfil por defecto" }).textContent).toBe("medio")
  expect((screen.getByLabelText("Corridas en paralelo") as HTMLInputElement).value).toBe("3")

  fillName("Tres")
  create()

  await waitFor(() => expect(createProject).toHaveBeenCalled())
  expect(sent(createProject)).toMatchObject({ defaultFlowId: "juguete", defaultProfileId: "medio", parallel: 3 })
})
