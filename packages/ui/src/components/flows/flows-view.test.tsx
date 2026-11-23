// @vitest-environment jsdom
import type { DefRecord } from "@clanker/api"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest"
import { App } from "@/App"
import type { AppData } from "@/app-data"
import { browserHost } from "@/browser-host"
import { createMemoryAppData } from "@/demo/memory-app-data"

// Cada test monta la app entera y recorre el editor: solos tardan 1 a 4 s, y con la suite en paralelo pasaban de los
// 5 s por defecto.
vi.setConfig({ testTimeout: 15_000 })

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
  const row = await waitFor(() => rowOf("de-issue-a-pr"))
  expect(within(row).getByText("incluido")).toBeTruthy()
  expect(within(row).getByText("v3")).toBeTruthy()
  expect(within(row).getByText(/Boundaries de engines, SOPORTE/)).toBeTruthy()
  fireEvent.click(within(row).getByRole("button"))
  expect(await screen.findByRole("group", { name: "Grafo del flujo de-issue-a-pr" })).toBeTruthy()
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
  await openFlows()
  const toggle = await screen.findByRole("button", { name: /Internos/ })
  expect(toggle.getAttribute("aria-expanded")).toBe("false")
  expect(screen.queryByRole("list", { name: "Flujos internos" })).toBeNull()
  fireEvent.click(toggle)
  expect(within(screen.getByRole("list", { name: "Flujos internos" })).getAllByText("interno")).toHaveLength(1)
})

test("sin flujos explica por qué y qué revisar", async () => {
  await openFlows({ defs: async () => [] })
  expect(await screen.findByText(/Todavía no hay flujos/)).toBeTruthy()
})

// Duplica el flujo incluido (queda uno tuyo, editable) y abre el editor, en el canvas.
async function openCanvas() {
  await openFlows()
  fireEvent.click(within(await waitFor(() => rowOf("de-issue-a-pr"))).getByRole("button"))
  fireEvent.click(await screen.findByRole("button", { name: /Duplicar para editar/ }))
  fireEvent.click(await screen.findByRole("button", { name: /^Editar$/ }))
  return await screen.findByRole("group", { name: /^Canvas del flujo/ })
}

const showJson = async () => {
  fireEvent.mouseDown(screen.getByRole("tab", { name: "JSON" }), { button: 0 })
  return (await screen.findByRole("textbox", { name: /en JSON/ })) as HTMLTextAreaElement
}
const showCanvas = async () => {
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Canvas" }), { button: 0 })
  await screen.findByRole("group", { name: /^Canvas del flujo/ })
}

// Lo mismo, y devuelve el textarea de la pestaña JSON.
async function openEditor() {
  await openCanvas()
  return await showJson()
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
  expect(screen.queryByRole("button", { name: /^Editar/ })).toBeNull()
})

const openStep = async (id: string) => {
  fireEvent.click(await screen.findByText(id, { selector: "span.font-mono" }))
  return await screen.findByRole("complementary", { name: `Propiedades de ${id}` })
}

test("sacarle el review de lore desde el canvas: se guarda con su diff y queda como versión nueva", async () => {
  await openCanvas()
  const panel = await openStep("rv-lore")
  fireEvent.click(within(panel).getByRole("button", { name: "Eliminar rv-lore" }))
  await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/cambios? por guardar/))

  fireEvent.click(screen.getByRole("button", { name: /^Guardar…/ }))
  const dialog = await screen.findByRole("alertdialog")
  expect(within(dialog).getByRole("list", { name: "Cambios" }).textContent).toContain("paso `rv-lore`")
  fireEvent.click(within(dialog).getByRole("button", { name: "Guardar versión nueva" }))
  expect(await screen.findByText("versión 2", { selector: "span.text-xs" })).toBeTruthy()
  expect(screen.queryByText("rv-lore", { selector: "span.font-mono" })).toBeNull()
})

test("la paleta explica cada tipo de paso y agregar uno lo deja elegido, suelto y marcado", async () => {
  await openCanvas()
  const palette = screen.getByRole("region", { name: "Paleta de pasos" })
  expect(within(palette).getByRole("button", { name: /gate/ }).getAttribute("title")).toBe("espera una decisión tuya")
  expect(within(palette).getByRole("button", { name: /agent/ }).getAttribute("title")).toMatch(/un agente hace una tarea/)
  fireEvent.click(within(palette).getByRole("button", { name: /gate/ }))
  const panel = await screen.findByRole("complementary", { name: "Propiedades de gate" })
  expect(within(panel).getByText("Cada opción es un botón de la decisión y una salida del paso.")).toBeTruthy()
})

test("cambiar un campo del panel cambia el mismo JSON", async () => {
  await openCanvas()
  const panel = await openStep("checks")
  fireEvent.change(within(panel).getByLabelText("Rondas máximas de fail"), { target: { value: "5" } })
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("1 cambio por guardar"))
  const area = await showJson()
  expect((JSON.parse(area.value) as { nodes: { checks: { on: { fail: { maxRounds: number } } } } }).nodes.checks.on.fail.maxRounds).toBe(5)
  await showCanvas()
})

test("un agente puede correr con otra entrada del perfil, y vaciarla vuelve a la del rol", async () => {
  await openCanvas()
  const panel = await openStep("plan")
  fireEvent.change(within(panel).getByLabelText("Entrada del perfil"), { target: { value: "dev-opencode" } })
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("1 cambio por guardar"))
  const area = await showJson()
  expect((JSON.parse(area.value) as { nodes: { plan: { profileRole?: string } } }).nodes.plan.profileRole).toBe("dev-opencode")

  await showCanvas()
  fireEvent.change(within(await openStep("plan")).getByLabelText("Entrada del perfil"), { target: { value: "" } })
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Sin cambios"))
})

test("un problema del core se marca en el nodo y en la lista, y lleva al paso", async () => {
  const area = await openEditor()
  const flow = JSON.parse(area.value) as { nodes: Record<string, { role?: string }> }
  flow.nodes.plan!.role = "no-existe"
  fireEvent.change(area, { target: { value: JSON.stringify(flow, null, 2) } })
  await showCanvas()
  expect(await screen.findByLabelText("1 problema en plan")).toBeTruthy()
  const bar = await screen.findByRole("button", { name: /1 error/ })
  expect(bar.getAttribute("aria-expanded")).toBe("false")
  fireEvent.click(bar)
  const list = await screen.findByRole("list", { name: "Problemas por arreglar" })
  expect((screen.getByRole("button", { name: /^Guardar…/ }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(within(list).getByRole("button", { name: /no existe el rol "no-existe"/ }))
  expect(within(await screen.findByRole("complementary", { name: "Propiedades de plan" })).getByRole("list", { name: "Problemas de este paso" })).toBeTruthy()
})

test("abrir el canvas no cambia el flujo ni le agrega un layout: las posiciones viven fuera del body", async () => {
  await openCanvas()
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Sin cambios"))
  const area = await showJson()
  expect(area.value).not.toContain("layout")
})

const openTab = async (name: RegExp, slug: string) => {
  fireEvent.mouseDown(await screen.findByRole("tab", { name }), { button: 0 })
  await screen.findByText(slug, { selector: "span.font-mono" })
}

test("un perfil se explica en una línea y su resumen sale de sus roles", async () => {
  await openFlows()
  await openTab(/Perfiles/, "medio")
  expect(screen.getAllByText(/más potente = mejor, pero más caro/).length).toBeGreaterThan(0)
  fireEvent.click(within(rowOf("medio")).getByRole("button"))
  expect(await screen.findByText("dev sonnet medium · reviews sonnet, haiku")).toBeTruthy()
})

test("crear un perfil propio con el dev en opus y los reviews en haiku, y verlo antes de guardar", async () => {
  const data = await openFlows()
  await openTab(/Perfiles/, "medio")
  fireEvent.click(screen.getByRole("button", { name: /Nuevo perfil/ }))
  const dialog = await screen.findByRole("dialog")
  fireEvent.change(within(dialog).getByLabelText("Nombre"), { target: { value: "dev-opus" } })
  fireEvent.click(within(dialog).getByRole("button", { name: "Crear perfil" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  expect((await data.defs("profile")).some((d) => d.slug === "dev-opus" && d.scope === "user")).toBe(true)

  fireEvent.click(await screen.findByRole("button", { name: /^Editar$/ }))
  fireEvent.change(await screen.findByLabelText("Modelo de dev"), { target: { value: "opus" } })
  fireEvent.change(screen.getByLabelText("Modelo de review-bugs"), { target: { value: "haiku" } })
  fireEvent.change(screen.getByLabelText("Esfuerzo de review-tests"), { target: { value: "" } })
  expect(screen.getByLabelText("Resumen").textContent).toBe("dev opus medium · reviews haiku")

  fireEvent.click(screen.getByRole("button", { name: /^Guardar…/ }))
  const review = await screen.findByRole("alertdialog")
  const changes = within(review).getByRole("list", { name: "Cambios" }).textContent
  expect(changes).toContain("campo `roles.dev.model` (cambia)")
  expect(changes).toContain("campo `roles.review-tests.effort` (se quita)")
  fireEvent.click(within(review).getByRole("button", { name: "Guardar versión nueva" }))

  expect(await screen.findByText("versión 2", { selector: "span.text-xs" })).toBeTruthy()
  const saved = (await data.defs("profile")).find((d) => d.slug === "dev-opus")!
  expect(saved.body).toMatchObject({ roles: { dev: { model: "opus", effort: "medium" }, "review-bugs": { model: "haiku" }, "review-tests": { model: "haiku" } } })
})

test("pasar un rol a opencode cambia sus modelos a los de opencode y guarda el runtime solo donde no es Claude", async () => {
  const data = await openFlows()
  await openTab(/Perfiles/, "medio")
  fireEvent.click(screen.getByRole("button", { name: /Nuevo perfil/ }))
  const dialog = await screen.findByRole("dialog")
  fireEvent.change(within(dialog).getByLabelText("Nombre"), { target: { value: "mixto" } })
  fireEvent.click(within(dialog).getByRole("button", { name: "Crear perfil" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

  fireEvent.click(await screen.findByRole("button", { name: /^Editar$/ }))
  fireEvent.change(await screen.findByLabelText("Runtime de review-bugs"), { target: { value: "opencode" } })
  const model = screen.getByLabelText("Modelo de review-bugs") as HTMLSelectElement
  expect(model.value).toBe("openai/gpt-6.1-terra")
  expect([...model.options].map((o) => o.value)).toEqual(["openai/gpt-6-luna", "openai/gpt-6.1-terra", "openai/gpt-6.1-sol", "opencode/big-pickle"])
  fireEvent.change(model, { target: { value: "opencode/big-pickle" } })

  fireEvent.click(screen.getByRole("button", { name: /^Guardar…/ }))
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Guardar versión nueva" }))
  expect(await screen.findByText("versión 2", { selector: "span.text-xs" })).toBeTruthy()
  const saved = (await data.defs("profile")).find((d) => d.slug === "mixto")!.body as { roles: Record<string, { runtime?: string; model: string }> }
  expect(saved.roles["review-bugs"]).toMatchObject({ runtime: "opencode", model: "opencode/big-pickle" })
  expect(saved.roles.dev?.runtime).toBeUndefined()
})

test("el nombre de un perfil nuevo no puede repetir uno existente", async () => {
  await openFlows()
  await openTab(/Perfiles/, "medio")
  fireEvent.click(screen.getByRole("button", { name: /Nuevo perfil/ }))
  const dialog = await screen.findByRole("dialog")
  fireEvent.change(within(dialog).getByLabelText("Nombre"), { target: { value: "medio" } })
  expect(within(dialog).getByText(/Ya existe "medio"/)).toBeTruthy()
  expect((within(dialog).getByRole("button", { name: "Crear perfil" }) as HTMLButtonElement).disabled).toBe(true)
})

test("un rol tuyo se edita con su prompt, herramientas y paquetes de contexto; los modos quedan como estaban", async () => {
  const data = await openFlows()
  await openTab(/Roles/, "dev")
  fireEvent.click(within(rowOf("dev")).getByRole("button"))
  fireEvent.click(await screen.findByRole("button", { name: /Duplicar para editar/ }))
  fireEvent.click(await screen.findByRole("button", { name: /^Editar$/ }))

  fireEvent.change(await screen.findByLabelText(/Instrucciones base/), { target: { value: "Eres quien implementa, con tests." } })
  fireEvent.click(screen.getByLabelText("Puede usar todas"))
  fireEvent.change(screen.getByLabelText(/Nunca estas/), { target: { value: "Bash" } })
  fireEvent.click(screen.getByLabelText(/^commits/))
  fireEvent.click(screen.getByRole("button", { name: /^Guardar…/ }))

  const review = await screen.findByRole("alertdialog")
  expect(within(review).getByRole("list", { name: "Cambios" }).textContent).toContain("campo `prompt` (cambia)")
  fireEvent.click(within(review).getByRole("button", { name: "Guardar versión nueva" }))
  await screen.findByText("versión 2", { selector: "span.text-xs" })

  const saved = (await data.defs("role")).find((d) => d.slug === "dev" && d.scope === "user")!
  expect(saved.body).toMatchObject({ prompt: "Eres quien implementa, con tests.", tools: { deny: ["Bash"] }, context: [{ kind: "pack", id: "commits" }], modes: { implement: { outcomes: ["ok"] } } })
})

test("Editar JSON sigue ahí como alternativa avanzada en perfiles y roles", async () => {
  await openFlows()
  await openTab(/Perfiles/, "medio")
  fireEvent.click(await screen.findByRole("button", { name: /Duplicar para editar/ }))
  expect(await screen.findByRole("button", { name: /Editar JSON \(avanzado\)/ })).toBeTruthy()
})

test("Exportar al repo explica .clanker/, deja elegir el repo y abre el PR en draft con su link", async () => {
  const exported: Parameters<AppData["exportDefToRepo"]>[0][] = []
  const data = await openFlows({ exportDefToRepo: async (input) => (exported.push(input), { url: "https://github.com/acme/api/pull/7", number: 7, branch: "clanker/export-flow-x", path: ".clanker/flows/x.json" }) })
  // Lo incluido no se exporta: primero se duplica para tener uno propio.
  expect(screen.queryByRole("button", { name: /Exportar al repo/ })).toBeNull()
  fireEvent.click(await screen.findByRole("button", { name: /Duplicar para editar/ }))
  fireEvent.click(await screen.findByRole("button", { name: /Exportar al repo/ }))

  const dialog = await screen.findByRole("dialog")
  expect(within(dialog).getByText(/es la configuración que viaja con el repo: cualquiera que lo registre la recibe/)).toBeTruthy()
  expect(within(dialog).getByText(/^\.clanker\/flows\/[a-z-]+\.json$/)).toBeTruthy()
  await waitFor(() => expect((within(dialog).getByLabelText("Repo") as HTMLSelectElement).options.length).toBe(3))
  fireEvent.change(within(dialog).getByLabelText("Repo"), { target: { value: (await data.repos())[1]!.repo.id } })
  fireEvent.click(within(dialog).getByRole("button", { name: "Abrir PR en draft" }))

  expect(await within(dialog).findByText(/Abrí el PR #7 en draft en acme\/web/)).toBeTruthy()
  expect(exported).toEqual([{ kind: "flow", id: (await data.defs("flow")).find((d) => d.scope === "user")!.id, repoId: (await data.repos())[1]!.repo.id }])
})

test("si el core rechaza la exportación, el motivo queda en el diálogo", async () => {
  await openFlows({ exportDefToRepo: () => Promise.reject(new Error("de-issue-a-pr.json ya está igual en main de api: no hay nada que exportar.")) })
  fireEvent.click(await screen.findByRole("button", { name: /Duplicar para editar/ }))
  fireEvent.click(await screen.findByRole("button", { name: /Exportar al repo/ }))
  const dialog = await screen.findByRole("dialog")
  await waitFor(() => expect((within(dialog).getByRole("button", { name: "Abrir PR en draft" }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(within(dialog).getByRole("button", { name: "Abrir PR en draft" }))
  expect((await within(dialog).findByRole("alert")).textContent).toContain("no hay nada que exportar")
})

test("una def del repo dice de qué repo, archivo y commit viene", async () => {
  const data = createMemoryAppData()
  const [repoRow] = await data.repos()
  const flow = (await data.defs("flow"))[0]!
  const fromRepo: DefRecord = { ...flow, id: "def_repo_1", slug: "del-repo", scope: "repo", repoId: repoRow!.repo.id, source: "repo:.clanker/flows/del-repo.json@0123456789ab" }
  await openFlows({ defs: async (kind, opts) => [...(await data.defs(kind, opts)), ...(kind === "flow" ? [fromRepo] : [])] })

  fireEvent.click(within(await waitFor(() => rowOf("del-repo"))).getByRole("button"))

  expect(await screen.findByText(/Del repo api/)).toBeTruthy()
  expect(screen.getByText(".clanker/flows/del-repo.json", { selector: "span.font-mono" })).toBeTruthy()
  expect(screen.getByText("0123456", { selector: "span.font-mono" })).toBeTruthy()
})

test("al editar un flujo la vista es solo el editor: sin lista ni historial, con propiedades solo al elegir un paso y pantalla completa", async () => {
  await openCanvas()
  // jsdom no aplica las clases: la lista sigue montada pero escondida.
  const listColumn = () => screen.getByRole("list", { name: /^Flujos$/, hidden: true }).parentElement!
  expect(listColumn().className).toContain("hidden")
  expect(screen.queryByText("Historial de versiones")).toBeNull()
  expect(screen.queryByRole("complementary")).toBeNull()

  const panel = await openStep("checks")
  fireEvent.click(screen.getByRole("button", { name: "Cerrar propiedades" }))
  expect(panel.isConnected).toBe(false)

  fireEvent.click(screen.getByRole("button", { name: "Pantalla completa" }))
  expect(screen.getByRole("button", { name: "Salir de pantalla completa" })).toBeTruthy()
  fireEvent.keyDown(document.body, { key: "Escape" })
  expect(screen.getByRole("button", { name: "Pantalla completa" })).toBeTruthy()
  expect(screen.getByRole("button", { name: /^Guardar…/ })).toBeTruthy()

  fireEvent.click(screen.getByRole("button", { name: "Cancelar" }))
  expect(await screen.findByText("Historial de versiones")).toBeTruthy()
  expect(listColumn().className).not.toContain("hidden")
})
