// @vitest-environment jsdom
import type { Event } from "@clanker/api"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest"
import { App } from "@/App"
import type { AppData } from "@/app-data"
import { browserHost } from "@/browser-host"
import type { Host } from "@/host"
import { UNDO_MS } from "@/hooks/use-decision-resolver"
import { createMemoryAppData } from "@/demo/memory-app-data"

/** El plazo de un `vi.waitFor`: el default de 1 s no alcanza con la suite en paralelo y bajo carga. */
const WAIT = { timeout: 10_000 }

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

async function openInbox(overrides: Partial<AppData> = {}) {
  const data = { ...createMemoryAppData(NOW), ...overrides }
  render(<App appData={data} host={browserHost} />)
  const sidebarItem = await screen.findByRole("button", { name: /^Bandeja/ })
  fireEvent.click(sidebarItem)
  await screen.findByRole("tab", { name: /Pendientes/ })
  // Desde aquí el plazo de deshacer corre con el reloj de la prueba.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  return { data, sidebarItem }
}

const rows = () => within(screen.getByRole("list", { name: /Decisiones/ })).getAllByRole("listitem")
const titles = () => rows().map((row) => within(row).getAllByText(/./)[0]!.textContent)
const key = (k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(document.body, { key: k, ...init })

test("el badge de la barra cuenta las pendientes y se pone ámbar si alguna estaciona una corrida", async () => {
  const { sidebarItem } = await openInbox()

  expect(sidebarItem.getAttribute("title")).toMatch(/4 decisiones pendientes, alguna estaciona su corrida/)
  const badge = sidebarItem.parentElement!.querySelector("[data-sidebar=menu-badge]")!
  expect(badge.textContent).toBe("4")
  expect(badge.className).toMatch(/amber/)
})

test("la bandeja solo trae lo accionable: las notas del agente no están ni en la lista ni en el contador", async () => {
  await openInbox()

  expect(titles()).toEqual(["¿Publico el PR de ENG-9190 como draft?", "La corrida llegó a su tope", "¿El helper va en el engine o en el core?", "La conexión de Linear venció"])
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Resueltas" }), { button: 0 })
  fireEvent.click(screen.getByRole("tab", { name: "Resueltas" }))
  expect(titles()).not.toContain("Quedan 🔴/🟡 tras las rondas de review")
})

test("las que estacionan una corrida van primero y la primera está a la vista con sus opciones numeradas", async () => {
  await openInbox()

  expect(titles().slice(0, 2)).toEqual(["¿Publico el PR de ENG-9190 como draft?", "La corrida llegó a su tope"])
  const detail = screen.getByRole("article", { name: "¿Publico el PR de ENG-9190 como draft?" })
  expect(within(detail).getByText("Estaciona ENG-9190")).toBeTruthy()
  const options = within(within(detail).getByRole("group", { name: "Opciones" })).getAllByRole("button")
  expect(options.slice(0, 3).map((b) => b.textContent)).toEqual(["1Publicar como draft y pedir /review", "2Publicar listo para revisar", "3No publicar todavía"])
})

test("J y K mueven la selección por la lista", async () => {
  await openInbox()

  key("j")
  expect(screen.getByRole("article", { name: "La corrida llegó a su tope" })).toBeTruthy()
  key("j")
  key("k")
  key("k")
  expect(screen.getByRole("article", { name: "¿Publico el PR de ENG-9190 como draft?" })).toBeTruthy()
})

test("elegir una opción con su número saca la decisión de las pendientes y recién después de unos segundos llega al core", async () => {
  const { data } = await openInbox()
  const resolve = vi.spyOn(data, "resolveDecision")

  key("2")

  expect(titles()).not.toContain("¿Publico el PR de ENG-9190 como draft?")
  // pasa a la siguiente decisión
  expect(screen.getByRole("article", { name: "La corrida llegó a su tope" })).toBeTruthy()
  expect(resolve).not.toHaveBeenCalled()
  await act(() => vi.advanceTimersByTimeAsync(UNDO_MS + 10))

  expect(resolve).toHaveBeenCalledWith({ id: expect.stringMatching(/^dec_/), option: "ready" })
  expect((await data.decisions({ status: ["answered"] })).map((d) => d.resolution)).toContainEqual({ option: "ready" })
  expect((await data.runs()).find((r) => r.id.endsWith("4"))?.status).toBe("running")
})

test("Z devuelve la decisión a las pendientes y no se manda nunca", async () => {
  const { data } = await openInbox()
  const resolve = vi.spyOn(data, "resolveDecision")

  key("1")
  expect(titles()).not.toContain("¿Publico el PR de ENG-9190 como draft?")
  key("z")
  await act(() => vi.advanceTimersByTimeAsync(UNDO_MS * 2))

  expect(titles()[0]).toBe("¿Publico el PR de ENG-9190 como draft?")
  expect(screen.getByRole("article", { name: "¿Publico el PR de ENG-9190 como draft?" })).toBeTruthy()
  expect(resolve).not.toHaveBeenCalled()
})

test("R abre el texto libre de una pregunta y ⌘⏎ la responde; un gate no deja responder con texto", async () => {
  const { data } = await openInbox()
  key("r")
  expect(screen.queryByRole("textbox", { name: "Tu respuesta" })).toBeNull()

  // la pregunta es la tercera de la lista
  fireEvent.click(within(rows()[2]!).getByRole("button"))
  expect(screen.getByRole("article", { name: "¿El helper va en el engine o en el core?" })).toBeTruthy()
  key("r")
  const box = screen.getByRole("textbox", { name: "Tu respuesta" })
  fireEvent.change(box, { target: { value: "va en el engine" } })
  fireEvent.keyDown(box, { key: "Enter", metaKey: true })
  await act(() => vi.advanceTimersByTimeAsync(UNDO_MS + 10))

  expect((await data.decisions({ status: ["answered"] })).map((d) => d.resolution)).toContainEqual({ option: "va en el engine" })
})

test("una alerta no tiene botones para resolver: se cierra sola y lleva a Conexiones", async () => {
  await openInbox()

  // la alerta es la cuarta de la lista
  fireEvent.click(within(rows()[3]!).getByRole("button"))
  const detail = screen.getByRole("article", { name: "La conexión de Linear venció" })
  expect(within(detail).queryByRole("group", { name: "Opciones" })).toBeNull()
  expect(within(detail).getByText(/se cierra sola cuando la causa se va/)).toBeTruthy()
  expect(within(detail).getByRole("button", { name: "Ir a Conexiones" })).toBeTruthy()
  key("1")
  key("r")
  expect(screen.queryByRole("textbox", { name: "Tu respuesta" })).toBeNull()
  expect(titles()).toContain("La conexión de Linear venció")
})

test("sin pendientes dice qué pasa y cuántas se resolvieron hoy, y ofrece ver las resueltas", async () => {
  const data = createMemoryAppData(NOW)
  const closed = (await data.decisions()).filter((d) => d.status === "pending")
  for (const d of closed) await data.resolveDecision({ id: d.id, option: d.options[0] ?? "seen" })
  await openInbox(data)

  expect(screen.getByText("No hay nada esperando tu decisión.")).toBeTruthy()
  expect(screen.getByText(/Las notas de los agentes están en cada corrida y en su PR\./)).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Ver las resueltas" }))
  expect(screen.getByRole("list", { name: "Decisiones resueltas" })).toBeTruthy()
})

test("las resueltas muestran lo que se eligió", async () => {
  await openInbox()
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Resueltas" }), { button: 0 })
  fireEvent.click(screen.getByRole("tab", { name: "Resueltas" }))

  const detail = screen.getByRole("article", { name: "¿Publico el PR de ENG-9175?" })
  expect(within(detail).getByRole("region", { name: "Resolución" }).textContent).toMatch(/respondida.*Publicar como draft y pedir \/review/)
})

// Un stream de eventos que la prueba alimenta a mano.
function liveEvents() {
  const queue: Event[] = []
  let wake: (() => void) | undefined
  return {
    push(event: Event) {
      queue.push(event)
      wake?.()
    },
    events: async (_after: number, signal: AbortSignal): Promise<AsyncIterable<Event>> => ({
      async *[Symbol.asyncIterator]() {
        while (!signal.aborted) {
          const next = queue.shift()
          if (next) yield next
          else await new Promise<void>((resolve) => ((wake = resolve), signal.addEventListener("abort", () => resolve(), { once: true })))
        }
      },
    }),
  }
}

const opened = (seq: number, kind: string, title: string): Event => ({ seq, ts: NOW, type: "decision.opened", origin: "core", payload: { decisionId: `dec_${String(seq).padStart(26, "0")}`, kind, title } })

test("una decisión que alguien debe atender avisa con una notificación que solo la abre; una nota no avisa", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(false)
  const stream = liveEvents()
  const notify = vi.fn()
  let navigate: Parameters<Host["onNavigate"]>[0] = () => {}
  const host: Host = { ...browserHost, notify, onNavigate: (cb) => ((navigate = cb), () => {}) }
  render(<App appData={{ ...createMemoryAppData(NOW), events: stream.events }} host={host} />)
  await screen.findByRole("button", { name: /^Bandeja/ })

  stream.push(opened(1, "review_note", "Una nota"))
  stream.push(opened(2, "gate", "¿Publico el PR?"))
  await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1), WAIT)

  expect(notify).toHaveBeenCalledWith({ title: "Una corrida te espera", body: "¿Publico el PR?", target: { decisionId: `dec_${"2".padStart(26, "0")}` } })

  // Hacer clic en la notificación abre la bandeja con esa decisión, sin resolver nada.
  const first = (await createMemoryAppData(NOW).decisions({ status: ["pending"] })).find((d) => d.kind === "needs_human")!
  act(() => navigate({ decisionId: first.id }))
  expect(await screen.findByRole("article", { name: first.title })).toBeTruthy()
  expect(screen.getByRole("group", { name: "Opciones" })).toBeTruthy()
})
