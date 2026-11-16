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

// Duplica el flujo incluido (queda uno tuyo, editable), abre el editor y devuelve su textarea.
async function openEditor() {
  await openFlows()
  fireEvent.click(await screen.findByRole("button", { name: /Duplicar para editar/ }))
  fireEvent.click(await screen.findByRole("button", { name: /Editar JSON/ }))
  return (await screen.findByRole("textbox", { name: /en JSON/ })) as HTMLTextAreaElement
}

const withName = (area: HTMLTextAreaElement, name: string) => JSON.stringify({ ...JSON.parse(area.value), name }, null, 2)

test("editar un flujo tuyo: el diff se ve antes de guardar, se crea una versión nueva y se puede volver a la anterior", async () => {
  const area = await openEditor()
  expect(screen.getByText(/Las corridas en curso siguen con la versión con que empezaron: lo que guardes/)).toBeTruthy()
  fireEvent.change(area, { target: { value: withName(area, "Mi techlead") } })
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("1 cambio por guardar"))

  fireEvent.click(screen.getByRole("button", { name: /^Guardar…/ }))
  const dialog = await screen.findByRole("alertdialog")
  expect(within(dialog).getByRole("list", { name: "Cambios" }).textContent).toContain("campo `name` (cambia)")
  expect(within(dialog).getByText('"Mi techlead"')).toBeTruthy()
  fireEvent.click(within(dialog).getByRole("button", { name: "Guardar versión nueva" }))

  expect(await screen.findByText("versión 2", { selector: "span.text-xs" })).toBeTruthy()
  expect(screen.queryByRole("textbox", { name: /en JSON/ })).toBeNull()

  fireEvent.click(await screen.findByRole("button", { name: "Volver a la versión 1" }))
  const back = await screen.findByRole("alertdialog")
  expect(within(back).getByText(/campo `name`/)).toBeTruthy()
  fireEvent.click(within(back).getByRole("button", { name: "Volver a esta versión" }))
  expect(await screen.findByText("versión 3", { selector: "span.text-xs" })).toBeTruthy()
})

test("un error del core se marca en su línea, dicho como paso y campo, y bloquea guardar", async () => {
  const area = await openEditor()
  const flow = JSON.parse(area.value) as { nodes: Record<string, { type: string; role?: string }> }
  const agentId = Object.keys(flow.nodes).find((id) => flow.nodes[id]!.type === "agent")!
  flow.nodes[agentId]!.role = "no-existe"
  fireEvent.change(area, { target: { value: JSON.stringify(flow, null, 2) } })

  const list = await screen.findByRole("list", { name: "Problemas por arreglar" })
  expect(within(list).getByText(`paso \`${agentId}\` → campo \`role\`: no existe el rol "no-existe"`)).toBeTruthy()
  expect((screen.getByRole("button", { name: /^Guardar…/ }) as HTMLButtonElement).disabled).toBe(true)
})

test("un JSON roto dice en qué línea y no llama al core", async () => {
  const area = await openEditor()
  fireEvent.change(area, { target: { value: '{\n  "id": "x"\n  "nodes": {}\n}' } })
  const list = await screen.findByRole("list", { name: "Problemas por arreglar" })
  expect(within(list).getByRole("button", { name: "línea 3" })).toBeTruthy()
})

test("un incluido no ofrece editar JSON", async () => {
  await openFlows()
  await screen.findByRole("button", { name: /Duplicar para editar/ })
  expect(screen.queryByRole("button", { name: /Editar JSON/ })).toBeNull()
})
