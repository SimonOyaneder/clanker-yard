// @vitest-environment jsdom
import type { ClankerProject } from "@clanker/api"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { toast } from "sonner"
import { afterEach, beforeAll, expect, test, vi } from "vitest"
import { AppDataProvider, type AppData } from "@/app-data"
import { type SettingsControls, ProjectSettingsTab } from "@/components/project/settings-view"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppActionsContext, type AppActions } from "@/lib/app-context"
import { createMemoryAppData } from "@/demo/memory-app-data"

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))

const NOW = Date.parse("2026-11-15T12:00:00Z")

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Element.prototype.scrollIntoView = () => {}
  Element.prototype.hasPointerCapture = () => false
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function setup(overrides: Partial<ClankerProject> = {}, which = 0) {
  const data = createMemoryAppData(NOW)
  const project = { ...(await data.projects())[which]!, ...overrides }
  const update = vi.fn<AppData["updateProject"]>((id, patch) => data.updateProject(id, patch))
  const importConfig = vi.fn<AppData["importProjectConfig"]>((input) => data.importProjectConfig(input))
  const controls: { current: SettingsControls | null } = { current: null }
  const actions = { goConnections: vi.fn(), editQueueFilters: vi.fn() }
  const ui = (p: ClankerProject) => (
    <AppDataProvider value={{ ...data, updateProject: update, importProjectConfig: importConfig }}>
      <AppActionsContext.Provider value={actions as unknown as AppActions}>
        <TooltipProvider>
          <ProjectSettingsTab project={p} focus={null} onFocused={() => {}} onControls={(c) => (controls.current = c)} />
        </TooltipProvider>
      </AppActionsContext.Provider>
    </AppDataProvider>
  )
  const view = render(ui(project))
  // Los datos del core llegan async: el formulario aparece cuando están.
  await screen.findByRole("region", { name: "Repos" })
  return { data, project, update, importConfig, controls, actions, rerender: (p: ClankerProject) => view.rerender(ui(p)) }
}

const field = (name: string) => screen.getByRole("textbox", { name })
const save = () => fireEvent.click(screen.getByRole("button", { name: /Guardar cambios/ }))

test("cambiar reviewRounds y guardar manda solo flowParams, con un toast que lo deshace", async () => {
  const { project, update } = await setup({ flowParams: { repo: "repo_x" } })
  // El default del flujo se ve como placeholder, y vacío es "usar el default".
  const rounds = screen.getByLabelText("Rondas de review")
  expect(rounds.getAttribute("placeholder")).toBe("3")

  fireEvent.change(rounds, { target: { value: "5" } })
  save()

  await waitFor(() => expect(update).toHaveBeenCalledWith(project.id, { flowParams: { repo: "repo_x", reviewRounds: 5 } }))
  const [message, options] = vi.mocked(toast).mock.calls[0]!
  expect(message).toContain("parámetros del flujo")
  const action = options?.action
  if (!action || typeof action !== "object" || !("onClick" in action)) throw new Error("el toast no ofrece Deshacer")
  action.onClick({} as never)
  await waitFor(() => expect(update).toHaveBeenLastCalledWith(project.id, { flowParams: { repo: "repo_x" } }))
})

test("el proyecto del tracker se cambia con el mismo selector y se guarda como trackerRef", async () => {
  // Un proyecto viejo guardaba un nombre en vez del id: el selector lo dice y pide elegir uno.
  const { project, update } = await setup({ trackerRef: "boundaries" })
  const section = screen.getByRole("region", { name: "Proyecto del tracker" })
  expect(await within(section).findByText(/El proyecto guardado \(boundaries\) no está en la lista/)).toBeTruthy()

  fireEvent.click(within(section).getByRole("combobox", { name: "Proyecto del tracker" }))
  fireEvent.click(await screen.findByRole("option", { name: "Facturación mensual" }))
  save()

  await waitFor(() => expect(update).toHaveBeenCalledWith(project.id, { trackerRef: "c43b8e70-91d2-4e0c-a6f5-3b1e8d2f6c03" }))
})

test("un proyecto local no muestra el proyecto del tracker", async () => {
  await setup({ tracker: "local" })

  expect(screen.queryByRole("region", { name: "Proyecto del tracker" })).toBeNull()
})

test("un valor inválido dice qué escribir y no deja guardar", async () => {
  const { update } = await setup()

  fireEvent.change(screen.getByLabelText("Rondas de review"), { target: { value: "0" } })

  expect((await screen.findByRole("alert")).textContent).toContain("Escribe un entero de 1 en adelante (el flujo usa 3)")
  expect((screen.getByRole("button", { name: /Guardar cambios/ }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByRole("region", { name: "Cambios sin guardar" }).textContent).toContain("necesita corrección")
  expect(update).not.toHaveBeenCalled()
})

test("las corridas a la vez del proyecto se editan en Apilado y gasto y se distinguen del carril", async () => {
  const { update, project } = await setup({ parallel: 1 })
  const limits = screen.getByRole("region", { name: "Apilado y gasto" })
  expect(within(limits).getByText(/el carril es el tope de la máquina entera y se cambia desde Operación/)).toBeTruthy()

  fireEvent.change(within(limits).getByLabelText("Corridas a la vez del proyecto"), { target: { value: "0" } })
  expect(within(limits).getByRole("alert").textContent).toContain("entero de 1 en adelante")
  expect((screen.getByRole("button", { name: /Guardar cambios/ }) as HTMLButtonElement).disabled).toBe(true)

  fireEvent.change(within(limits).getByLabelText("Corridas a la vez del proyecto"), { target: { value: "3" } })
  save()
  await waitFor(() => expect(update).toHaveBeenCalledWith(project.id, { parallel: 3 }))
})

test("el índice lleva a cada sección y marca la que se clicó", async () => {
  await setup()
  const scrolled: string[] = []
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.id)
  }
  const nav = screen.getByRole("navigation", { name: "Secciones de Ajustes" })

  fireEvent.click(within(nav).getByRole("button", { name: "Apilado y gasto" }))

  expect(scrolled).toEqual(["settings-limits"])
  expect(within(nav).getByRole("button", { name: "Apilado y gasto" }).getAttribute("aria-current")).toBe("location")
  expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual(["Repos", "Proyecto del tracker", "Filtros de la cola", "Mapeo de estados", "Flujo y parámetros", "Apilado y gasto", "Convenciones", "Exportar e importar"])
})

test("la ayuda de un parámetro avisa que otro flujo lo lee con otro default", async () => {
  await setup()

  expect(screen.getByText(/También lo lee: rebase-conflicto \(default 2\)/)).toBeTruthy()
})

test("Enter agrega un label a los filtros de la cola, la X lo quita y Descartar deja todo como estaba", async () => {
  const { update } = await setup()
  const labels = field("Labels que debe tener")

  fireEvent.change(labels, { target: { value: "clanker" } })
  fireEvent.keyDown(labels, { key: "Enter" })

  expect(screen.getByRole("button", { name: "Quitar clanker" })).toBeTruthy()
  expect(screen.getByRole("region", { name: "Cambios sin guardar" }).textContent).toContain("filtros de la cola")
  fireEvent.click(screen.getByRole("button", { name: "Descartar" }))
  expect(screen.queryByRole("button", { name: "Quitar clanker" })).toBeNull()
  expect(screen.queryByRole("region", { name: "Cambios sin guardar" })).toBeNull()
  expect(update).not.toHaveBeenCalled()
})

test("un label en los pedidos y en los excluidos avisa que la cola quedaría vacía", async () => {
  await setup()
  for (const [name, value] of [["Labels que debe tener", "clanker"], ["Labels que la sacan de la cola", "clanker"]] as const) {
    const input = field(name)
    fireEvent.change(input, { target: { value } })
    fireEvent.keyDown(input, { key: "Enter" })
  }

  expect((await screen.findByRole("alert")).textContent).toContain("la cola quedaría vacía")
})

test("quitar un repo y hacer otro el de por defecto reordena la lista que se guarda", async () => {
  const data = createMemoryAppData(NOW)
  const [api, web] = (await data.repos()).map((r) => r.repo.id)
  const { project, update } = await setup({ repos: [{ repoId: api!, labels: [] }, { repoId: web!, labels: ["web"] }] })

  fireEvent.contextMenu(screen.getByText("web", { selector: "span.font-medium" }))
  fireEvent.click(await screen.findByRole("menuitem", { name: "Hacer repo por defecto" }))
  save()

  await waitFor(() =>
    expect(update).toHaveBeenCalledWith(project.id, { repos: [{ repoId: web, labels: ["web"] }, { repoId: api, labels: [] }] }),
  )
})

test("con tracker local el mapeo de estados explica que no hay nada que mapear", async () => {
  await setup({ tracker: "local" }, 1)

  expect(within(screen.getByRole("region", { name: "Mapeo de estados" })).getByText(/El tracker local ya usa las categorías/)).toBeTruthy()
})

test("⌘S guarda y la paleta recibe los controles mientras hay cambios", async () => {
  const { project, update, controls } = await setup()
  expect(controls.current).toMatchObject({ dirty: false, blocked: false })

  fireEvent.change(field("Tope de gasto por corrida (USD)"), { target: { value: "4.5" } })
  expect(controls.current).toMatchObject({ dirty: true, blocked: false })
  fireEvent.keyDown(window, { key: "s", code: "KeyS", metaKey: true })

  await waitFor(() => expect(update).toHaveBeenCalledWith(project.id, { maxCostUsd: 4.5 }))
})

test("mientras se edita, que el proyecto llegue con otros datos no pisa lo escrito", async () => {
  const { project, rerender } = await setup()
  fireEvent.change(field("Tope de gasto por corrida (USD)"), { target: { value: "9" } })

  rerender({ ...project, parallel: 3 })

  expect((field("Tope de gasto por corrida (USD)") as HTMLInputElement).value).toBe("9")
})

test("el mapeo de estados lista los estados de las issues con su categoría de hoy y guarda el que se ajusta", async () => {
  const { project, update } = await setup()
  const region = screen.getByRole("region", { name: "Mapeo de estados" })
  expect(within(region).getByText("in_progress")).toBeTruthy()
  expect(within(region).getByText("hoy: En progreso")).toBeTruthy()

  // Un estado que ninguna issue trae todavía se agrega con su nombre exacto y parte automático.
  fireEvent.change(within(region).getByLabelText("Nombre de un estado del tracker"), { target: { value: "In Staging" } })
  fireEvent.click(within(region).getByRole("button", { name: "Agregar estado" }))
  fireEvent.keyDown(within(region).getByRole("combobox", { name: "Categoría de In Staging" }), { key: "Enter" })
  fireEvent.click(await screen.findByRole("option", { name: "En review" }))
  save()

  await waitFor(() => expect(update).toHaveBeenCalledWith(project.id, { statusMapping: { "In Staging": "in_review" } }))
})

const fileOf = (content: unknown, name = "config.json") => new File([typeof content === "string" ? content : JSON.stringify(content)], name, { type: "application/json" })
const pickFile = (file: File) => fireEvent.change(screen.getByLabelText("Archivo de configuración"), { target: { files: [file] } })

test("exportar baja la configuración del proyecto como archivo", async () => {
  const { project } = await setup()
  const blobs: Blob[] = []
  URL.createObjectURL = (blob: Blob | MediaSource) => (blobs.push(blob as Blob), "blob:x")
  URL.revokeObjectURL = () => {}
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})

  fireEvent.click(screen.getByRole("button", { name: /Exportar configuración/ }))

  await waitFor(() => expect(click).toHaveBeenCalled())
  expect(JSON.parse(await blobs[0]!.text())).toMatchObject({ clankerProjectConfig: 1, name: project.name, trackerRef: project.trackerRef })
  click.mockRestore()
})

test("importar muestra qué cambia y qué no se pudo mapear antes de escribir, y recién al confirmar aplica", async () => {
  const { data, project, importConfig: apply } = await setup()
  const config = { ...(await data.exportProjectConfig(project.id)), parallel: 3, repos: [{ name: "api", remote: "acme/api", labels: ["be"] }, { name: "x", remote: "acme/x", labels: [] }] }

  pickFile(fileOf(config))

  const dialog = await screen.findByRole("alertdialog")
  expect(within(dialog).getByRole("list", { name: "Cambios" }).textContent).toContain("Cupo del carril dev (cambia)")
  expect(within(dialog).getByRole("list", { name: "Cambios" }).textContent).toContain("Repos")
  expect(within(dialog).getByRole("list", { name: "Sin mapear" }).textContent).toContain("acme/x no está registrado en esta máquina")
  expect(apply).toHaveBeenCalledTimes(1)
  expect(apply).toHaveBeenLastCalledWith({ projectId: project.id, config, dryRun: true })
  expect((await data.projects())[0]!.parallel).toBe(1)

  fireEvent.click(within(dialog).getByRole("button", { name: "Importar" }))

  await waitFor(() => expect(apply).toHaveBeenLastCalledWith({ projectId: project.id, config, dryRun: false }))
  await waitFor(async () => expect((await data.projects())[0]!.parallel).toBe(3))
})

test("un archivo que no es una configuración no deja importar y no escribe nada", async () => {
  const { data, project, importConfig: apply } = await setup()

  pickFile(fileOf("{ no es json"))
  await waitFor(() => expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toContain("no es un JSON"))
  expect(apply).not.toHaveBeenCalled()

  pickFile(fileOf({ clankerProjectConfig: 1, name: "x", tracker: "linear", trackerRef: "t", parallel: 0 }))
  const dialog = await screen.findByRole("alertdialog")
  expect(within(dialog).getByRole("list", { name: "Cambios" }).textContent).toContain("Cupo del carril dev")
  expect(within(dialog).queryByRole("button", { name: "Importar" })).toBeNull()
  expect(apply).toHaveBeenCalledTimes(1)
  expect((await data.projects())[0]!.parallel).toBe(project.parallel)
})

test("con ajustes sin guardar no se puede importar", async () => {
  await setup()
  fireEvent.change(screen.getByLabelText("Rondas de review"), { target: { value: "5" } })

  expect((screen.getByRole("button", { name: /Importar…/ }) as HTMLButtonElement).disabled).toBe(true)
})
