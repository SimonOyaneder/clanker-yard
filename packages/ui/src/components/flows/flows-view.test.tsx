// @vitest-environment jsdom
import type { DefRecord } from "@clanker/api"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, expect, test } from "vitest"
import { App } from "@/App"
import type { AppData } from "@/app-data"
import { browserHost } from "@/browser-host"
import { createMemoryAppData } from "@/memory-app-data"

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
afterEach(cleanup)

async function openFlows(overrides: Partial<AppData> = {}) {
  const data = { ...createMemoryAppData(), ...overrides }
  render(<App appData={data} host={browserHost} />)
  fireEvent.click(await screen.findByRole("button", { name: /^Flujos/ }))
  await screen.findByRole("tab", { name: /Roles/ })
  return data
}

const rowOf = (slug: string) => screen.getByText(slug, { selector: "span.font-mono" }).closest("li")!

test("la vista lista los flujos con su origen, versión y proyectos, y abre el grafo del primero", async () => {
  await openFlows()
  const row = await waitFor(() => rowOf("techlead-clasico"))
  expect(within(row).getByText("incluido")).toBeTruthy()
  expect(within(row).getByText("v3")).toBeTruthy()
  expect(within(row).getByText("Boundaries de engines")).toBeTruthy()
  fireEvent.click(within(row).getByRole("button"))
  expect(await screen.findByRole("group", { name: "Grafo del flujo techlead-clasico" })).toBeTruthy()
  expect(await screen.findByText("versión 2")).toBeTruthy()
})

test("hay pestañas de roles y perfiles", async () => {
  await openFlows()
  fireEvent.mouseDown(screen.getByRole("tab", { name: /Roles/ }), { button: 0 })
  expect(await screen.findByText("review-bugs", { selector: "span.font-mono" })).toBeTruthy()
  fireEvent.mouseDown(screen.getByRole("tab", { name: /Perfiles/ }), { button: 0 })
  expect(await screen.findByText("medio", { selector: "span.font-mono" })).toBeTruthy()
})

test("duplicar un incluido crea uno tuyo que manda sobre él; archivarlo devuelve el mando", async () => {
  await openFlows()
  fireEvent.click(await screen.findByRole("button", { name: /Duplicar para editar/ }))
  await waitFor(() => expect(screen.getAllByText("tuyo").length).toBeGreaterThan(0))
  await waitFor(() => expect(screen.getAllByText("reemplazado por el tuyo").length).toBeGreaterThan(0))
  // Lo tuyo se archiva sin salir de la app.
  fireEvent.click(screen.getByRole("button", { name: /^Archivar/ }))
  await waitFor(() => expect(screen.queryByText("reemplazado por el tuyo")).toBeNull())
  expect(screen.getByText(/Mostrar archivados \(1\)/)).toBeTruthy()
})

test("uno incluido no se archiva y dice qué hacer", async () => {
  await openFlows()
  await screen.findByRole("button", { name: /Duplicar para editar/ })
  expect(screen.queryByRole("button", { name: /^Archivar/ })).toBeNull()
  expect(screen.getByText(/no se edita directo/)).toBeTruthy()
})

test("los flujos internos van aparte y plegados", async () => {
  const base = createMemoryAppData()
  const flows = await base.defs("flow")
  const internal: DefRecord = { ...flows.find((f) => f.slug === "juguete")!, body: { ...(flows.find((f) => f.slug === "juguete")!.body as object), internal: true } }
  await openFlows({ defs: async (kind, opts) => (kind === "flow" ? [...flows.filter((f) => f.slug !== "juguete"), internal] : base.defs(kind, opts)) })
  const toggle = await screen.findByRole("button", { name: /Internos/ })
  expect(toggle.getAttribute("aria-expanded")).toBe("false")
  expect(screen.queryByRole("list", { name: "Flujos internos" })).toBeNull()
  fireEvent.click(toggle)
  expect(within(screen.getByRole("list", { name: "Flujos internos" })).getByText("interno")).toBeTruthy()
})

test("sin flujos explica por qué y qué revisar", async () => {
  await openFlows({ defs: async () => [] })
  expect(await screen.findByText(/Todavía no hay flujos/)).toBeTruthy()
})
