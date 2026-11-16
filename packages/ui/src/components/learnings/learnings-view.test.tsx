// @vitest-environment jsdom
import type { Learning } from "@clanker/api"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest"
import { App } from "@/App"
import type { AppData } from "@/app-data"
import { browserHost } from "@/browser-host"
import { UNDO_MS } from "@/hooks/use-decision-resolver"
import { createMemoryAppData } from "@/demo/memory-app-data"

const NOW = Date.parse("2026-11-15T12:00:00Z")

// jsdom no trae matchMedia (el tema y el sidebar), ResizeObserver (Radix) ni scrollIntoView.
beforeAll(() => {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Element.prototype.scrollIntoView = () => {}
  Element.prototype.hasPointerCapture = () => false
})
beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function openLearnings(overrides: Partial<AppData> = {}) {
  const data = { ...createMemoryAppData(NOW), ...overrides }
  render(<App appData={data} host={browserHost} />)
  const sidebarItem = await screen.findByRole("button", { name: /^Learnings/ })
  fireEvent.click(sidebarItem)
  await screen.findByRole("tab", { name: /Por revisar/ })
  await screen.findAllByRole("listitem")
  // Desde aquí el plazo de deshacer corre con el reloj de la prueba.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  return { data, sidebarItem }
}

const rows = () => within(screen.getByRole("list", { name: /^Learnings:/ })).getAllByRole("listitem")
const texts = () => rows().map((row) => within(row).getAllByText(/./)[0]!.textContent)
const key = (k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(document.body, { key: k, ...init })
const tabCount = (name: RegExp) => screen.getByRole("tab", { name }).textContent
const detail = () => screen.getByRole("article", { name: "Learning" })

test("la barra cuenta los por revisar y cada pestaña sus estados", async () => {
  const { sidebarItem } = await openLearnings()

  expect(sidebarItem.getAttribute("title")).toMatch(/6 por revisar/)
  expect(sidebarItem.parentElement!.querySelector("[data-sidebar=menu-badge]")!.textContent).toBe("6")
  expect(tabCount(/Por revisar/)).toMatch(/6/)
  expect(tabCount(/Aprobados/)).toMatch(/2/)
  expect(tabCount(/Rechazados/)).toMatch(/1/)
  expect(tabCount(/Retirados/)).toMatch(/1/)
  // El más reciente primero, con su detalle a la vista.
  expect(rows()).toHaveLength(6)
  expect(detail().textContent).toContain(texts()[0]!)
})

test("A aprueba el que está a la vista: sale de Por revisar al instante y el core lo sabe pasado el plazo", async () => {
  const { data } = await openLearnings()
  const approve = vi.spyOn(data, "approveLearning")
  const first = texts()[0]!

  key("a")

  expect(texts()).not.toContain(first)
  expect(rows()).toHaveLength(5)
  // El que sigue pasa a estar a la vista y el badge ya no lo cuenta.
  expect(detail().textContent).toContain(texts()[0]!)
  expect(tabCount(/Aprobados/)).toMatch(/3/)
  expect(approve).not.toHaveBeenCalled()
  await act(() => vi.advanceTimersByTimeAsync(UNDO_MS + 10))

  expect(approve).toHaveBeenCalledTimes(1)
  expect((await data.learnings()).filter((l) => l.status === "approved")).toHaveLength(3)
})

test("Z devuelve lo que se aprobó y el core no se entera nunca", async () => {
  const { data } = await openLearnings()
  const approve = vi.spyOn(data, "approveLearning")
  const first = texts()[0]!

  key("a")
  key("z")
  await act(() => vi.advanceTimersByTimeAsync(UNDO_MS * 2))

  expect(texts()[0]).toBe(first)
  expect(rows()).toHaveLength(6)
  expect(approve).not.toHaveBeenCalled()
})

test("X marca, ⌘A marca todo lo que se ve y A aprueba el lote entero como una sola decisión", async () => {
  const { data } = await openLearnings()
  const approve = vi.spyOn(data, "approveLearning")
  const reject = vi.spyOn(data, "rejectLearning")

  key("x")
  expect(screen.getByText("1 marcado")).toBeTruthy()
  key("a", { metaKey: true })
  expect(screen.getByText("6 marcados")).toBeTruthy()
  key("a")

  expect(screen.getByRole("heading", { name: "Nada por revisar" })).toBeTruthy()
  expect(screen.getByRole("button", { name: "Ver los aprobados" })).toBeTruthy()
  // Z deshace el lote entero.
  key("z")
  expect(rows()).toHaveLength(6)
  key("a", { metaKey: true })
  key("r")
  await act(() => vi.advanceTimersByTimeAsync(UNDO_MS + 10))

  expect(approve).not.toHaveBeenCalled()
  expect(reject).toHaveBeenCalledTimes(6)
  expect((await data.learnings()).filter((l) => l.status === "rejected")).toHaveLength(7)
})

test("los filtros por origen, rol y texto acotan la lista y los contadores", async () => {
  await openLearnings()

  fireEvent.change(screen.getByLabelText("Buscar learnings"), { target: { value: "boundaries" } })
  expect(rows()).toHaveLength(2)
  expect(tabCount(/Aprobados/)).toMatch(/0/)

  fireEvent.change(screen.getByLabelText("Buscar learnings"), { target: { value: "no existe esto" } })
  expect(screen.getByRole("heading", { name: "Ningún learning coincide con los filtros" })).toBeTruthy()
  fireEvent.click(screen.getAllByRole("button", { name: "Quitar filtros" })[0]!)
  expect(rows()).toHaveLength(6)
})

test("E edita el texto y los roles, ⌘⏎ guarda y un texto repetido muestra el error del core sin cerrar el formulario", async () => {
  const { data } = await openLearnings()
  const update = vi.spyOn(data, "updateLearning")
  // El segundo y el tercero de la lista son del mismo proyecto: el texto de uno ya existe en el alcance del otro.
  key("j")
  const first = texts()[1]!

  key("e")
  const form = screen.getByRole("form", { name: "Editar learning" })
  expect(within(form).getByText(/lo fija el core al crear el learning y no se edita/)).toBeTruthy()
  // Un texto que ya existe en el mismo alcance: el core lo rechaza y el formulario sigue abierto con el motivo.
  const other = texts()[2]!
  fireEvent.change(within(form).getByLabelText("Texto"), { target: { value: other } })
  fireEvent.keyDown(form, { key: "Enter", metaKey: true })
  await act(() => vi.advanceTimersByTimeAsync(10))
  expect(screen.getByRole("alert").textContent).toMatch(/Ya existe ese texto/)
  expect(screen.getByRole("form", { name: "Editar learning" })).toBeTruthy()

  fireEvent.change(within(form).getByLabelText("Texto"), { target: { value: "Texto corregido a mano" } })
  fireEvent.change(within(form).getByLabelText("Roles"), { target: { value: "dev," } })
  fireEvent.keyDown(form, { key: "Enter", metaKey: true })
  await act(() => vi.advanceTimersByTimeAsync(10))

  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Texto corregido a mano", roles: ["dev"] }))
  expect(screen.queryByRole("form", { name: "Editar learning" })).toBeNull()
  expect(detail().textContent).toContain("Texto corregido a mano")
  expect(texts()).not.toContain(first)
})

test("en Aprobados, R retira: queda en Retirados y deja de entrar a los briefs", async () => {
  const { data } = await openLearnings()
  const reject = vi.spyOn(data, "rejectLearning")

  // Radix activa la pestaña al bajar el botón, no al soltarlo.
  fireEvent.mouseDown(screen.getByRole("tab", { name: /Aprobados/ }), { button: 0 })
  expect(rows()).toHaveLength(2)
  expect(within(detail()).getByRole("button", { name: /Retirar/ })).toBeTruthy()
  key("r")

  expect(tabCount(/Retirados/)).toMatch(/2/)
  await act(() => vi.advanceTimersByTimeAsync(UNDO_MS + 10))
  expect(reject).toHaveBeenCalledTimes(1)
  expect((await data.learnings()).filter((l) => l.status === "archived")).toHaveLength(2)
})

test("si el core rechaza una decisión, el learning vuelve a su lugar y el error se muestra", async () => {
  const { data } = await openLearnings({
    approveLearning: async () => {
      throw new Error("Solo la app puede aprobar")
    },
  })
  const first = texts()[0]!
  key("a")
  expect(texts()).not.toContain(first)
  await act(() => vi.advanceTimersByTimeAsync(UNDO_MS + 10))
  await act(() => vi.advanceTimersByTimeAsync(10))

  expect(texts()[0]).toBe(first)
  expect(screen.getByText(/No pude aprobar el learning: Solo la app puede aprobar/)).toBeTruthy()
  expect((await data.learnings()).filter((l) => l.status === "approved")).toHaveLength(2)
})

test("sin ningún learning, la vista explica de dónde salen y ofrece el comando de importación", async () => {
  const data = { ...createMemoryAppData(NOW), learnings: async () => [] as Learning[] }
  render(<App appData={data} host={browserHost} />)
  fireEvent.click(await screen.findByRole("button", { name: /^Learnings/ }))

  expect(await screen.findByRole("heading", { name: "Todavía no hay learnings" })).toBeTruthy()
  expect(screen.getByRole("button", { name: /Copiar el comando de importación/ })).toBeTruthy()
})

test("⌘K ofrece aprobar, rechazar y editar sobre lo marcado, y sirve para aprobarlo sin tocar el mouse", async () => {
  const { data } = await openLearnings()
  const approve = vi.spyOn(data, "approveLearning")

  key("x")
  key("j")
  key("x")
  fireEvent.click(screen.getByRole("button", { name: /Buscar o ejecutar/ }))
  await act(() => vi.advanceTimersByTimeAsync(10))
  const palette = screen.getByRole("dialog")
  expect(within(palette).getByText("2 learnings marcados")).toBeTruthy()
  expect(within(palette).getByRole("option", { name: /Rechazar 2/ })).toBeTruthy()
  expect(within(palette).getByRole("option", { name: /Ir a Learnings/ })).toBeTruthy()
  fireEvent.click(within(palette).getByRole("option", { name: /Aprobar 2/ }))
  await act(() => vi.advanceTimersByTimeAsync(UNDO_MS + 10))

  expect(approve).toHaveBeenCalledTimes(2)
})

test("«Filtrar con el criterio» muestra qué archivaría y por qué, y solo archiva al confirmar", async () => {
  const { data } = await openLearnings()
  const archive = vi.spyOn(data, "archiveLearnings")

  fireEvent.click(screen.getByRole("button", { name: /Filtrar con el criterio/ }))
  await act(async () => {})

  const list = screen.getByRole("list", { name: "Learnings a archivar" })
  expect(within(list).getAllByRole("listitem")).toHaveLength(1)
  expect(list.textContent).toContain("No cambia lo que haría un agente en otra issue.")
  expect(archive).not.toHaveBeenCalled()
  expect((await data.learnings()).filter((l) => l.status === "archived")).toHaveLength(1)

  fireEvent.click(screen.getByRole("button", { name: /Archivar 1/ }))
  await act(async () => {})

  expect(archive).toHaveBeenCalledTimes(1)
  // El de ejemplo ya estaba archivado de antes: ahora hay dos y nada se borró.
  expect((await data.learnings()).filter((l) => l.status === "archived")).toHaveLength(2)
  expect((await data.learnings()).filter((l) => l.status === "proposed")).toHaveLength(5)
})

test("cancelar el filtro no archiva nada", async () => {
  const { data } = await openLearnings()
  const archive = vi.spyOn(data, "archiveLearnings")

  fireEvent.click(screen.getByRole("button", { name: /Filtrar con el criterio/ }))
  await act(async () => {})
  fireEvent.click(screen.getByRole("button", { name: "Cancelar" }))

  expect(archive).not.toHaveBeenCalled()
  expect((await data.learnings()).filter((l) => l.status === "proposed")).toHaveLength(6)
})

async function fillNewLearning(text: string) {
  fireEvent.click(screen.getByRole("button", { name: /Nuevo learning/ }))
  await act(() => vi.advanceTimersByTimeAsync(10))
  const dialog = screen.getByRole("dialog", { name: "Nuevo learning" })
  const scope = within(dialog).getByLabelText("Alcance") as HTMLSelectElement
  fireEvent.change(scope, { target: { value: scope.querySelector("optgroup[label=Proyectos] option")!.getAttribute("value")! } })
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "dev" }))
  fireEvent.change(within(dialog).getByLabelText("Texto"), { target: { value: text } })
  return dialog
}

test("Nuevo learning lo propone y lo aprueba con los roles marcados", async () => {
  const { data } = await openLearnings()
  const propose = vi.spyOn(data, "proposeLearning")
  const approve = vi.spyOn(data, "approveLearning")
  const dialog = await fillNewLearning("Corre `srb tc` con `doppler run --config dev`")

  fireEvent.click(within(dialog).getByRole("button", { name: "Guardar" }))
  await act(() => vi.advanceTimersByTimeAsync(10))

  expect(propose).toHaveBeenCalledWith(expect.objectContaining({ text: "Corre `srb tc` con `doppler run --config dev`", roles: ["dev"] }))
  const created = (await data.learnings()).find((l) => l.text.startsWith("Corre `srb tc`"))!
  expect(approve).toHaveBeenCalledWith(created.id)
  expect(created).toMatchObject({ status: "approved", source: "human", roles: ["dev"] })
  expect(screen.queryByRole("dialog", { name: "Nuevo learning" })).toBeNull()
})

test("Nuevo learning con un texto que ya existía no lo aprueba de nuevo", async () => {
  const { data } = await openLearnings()
  const approve = vi.spyOn(data, "approveLearning")
  const existing = (await data.learnings()).find((l) => l.status === "proposed" && l.projectId)!
  const dialog = await fillNewLearning(existing.text)
  const scope = within(dialog).getByLabelText("Alcance") as HTMLSelectElement
  fireEvent.change(scope, { target: { value: `p:${existing.projectId}` } })

  fireEvent.click(within(dialog).getByRole("button", { name: "Guardar" }))
  await act(() => vi.advanceTimersByTimeAsync(10))

  expect(approve).not.toHaveBeenCalled()
  expect(screen.getByText(/Ya existía en ese alcance/)).toBeTruthy()
})
