// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { toast } from "sonner"
import { afterEach, beforeAll, expect, test, vi } from "vitest"
import { AppDataProvider, type AppData } from "@/app-data"
import { LiveProvider } from "@/hooks/use-live"
import { AppSettingsView } from "@/components/app-settings/app-settings-view"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppActionsContext, type AppActions } from "@/lib/app-context"
import { HostProvider, type Host } from "@/host"
import { createMemoryAppData } from "@/demo/memory-app-data"

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }))

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

async function setup(overrides: Partial<AppData> = {}, host: Partial<Host> = {}) {
  const data = { ...createMemoryAppData(Date.parse("2026-11-15T12:00:00Z")), ...overrides }
  const actions = { setLanes: vi.fn() }
  render(
    <AppDataProvider value={data}>
      <HostProvider value={{ openExternal: vi.fn(), openInEditor: vi.fn(), ...host } as unknown as Host}>
        <AppActionsContext.Provider value={actions as unknown as AppActions}>
          <TooltipProvider>
            <LiveProvider>
              <AppSettingsView />
            </LiveProvider>
          </TooltipProvider>
        </AppActionsContext.Provider>
      </HostProvider>
    </AppDataProvider>,
  )
  await screen.findByRole("region", { name: "Carriles" })
  return { data, actions }
}

const save = () => fireEvent.click(screen.getByRole("button", { name: /Guardar cambios/ }))

test("cada sección dice en una línea para qué sirve, y el pack se explica sin jerga", async () => {
  await setup()

  for (const name of ["Carriles", "Packs", "Proyectos nuevos", "Avanzado"]) {
    const section = screen.getByRole("region", { name })
    expect(within(section).getByRole("heading", { name }).nextElementSibling?.textContent?.length).toBeGreaterThan(30)
  }
  expect(within(screen.getByRole("region", { name: "Packs" })).getByText(/reglas y convenciones de tu organización: bot de review, CI, estilo de PRs/)).toBeTruthy()
  const nav = screen.getByRole("navigation", { name: "Secciones de Ajustes" })
  expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual(["Carriles", "Packs", "Proyectos nuevos", "Avanzado"])
})

test("los carriles usan el mismo control que Operación y cambian la capacidad al instante", async () => {
  const { actions } = await setup()
  const lanes = screen.getByRole("region", { name: "Carriles" })

  fireEvent.click(within(lanes).getByRole("button", { name: "Subir la capacidad del carril dev" }))

  expect(actions.setLanes).toHaveBeenCalledWith("dev", 5, 4)
  expect(within(lanes).getByLabelText("Capacidad del carril mantenimiento").textContent).toBe("2")
})

test("lista los packs con versión, alcance y origen; el de la app no se quita", async () => {
  await setup()
  const packs = screen.getByRole("region", { name: "Packs" })

  expect(within(packs).getByText("base")).toBeTruthy()
  expect(within(packs).getByText("v2")).toBeTruthy()
  expect(within(packs).getByText("Incluido")).toBeTruthy()
  expect(within(packs).getByText("GitHub: base-org")).toBeTruthy()
  expect(within(packs).getByText("Tracker: base")).toBeTruthy()

  fireEvent.pointerDown(within(packs).getByRole("button", { name: "Acciones de base" }), { button: 0, ctrlKey: false })
  await screen.findByRole("menu")
  expect(screen.queryByRole("menuitem", { name: "Quitar" })).toBeNull()
})

test("avisa de la org con repos sin pack y el aviso se va al instalar uno que la cubre", async () => {
  await setup()
  const packs = screen.getByRole("region", { name: "Packs" })
  expect(within(packs).getByRole("status").textContent).toContain("api, web, infra de la org acme no tienen un pack")

  fireEvent.change(within(packs).getByLabelText("Carpeta del pack"), { target: { value: "/code/acme-pack" } })
  fireEvent.click(within(packs).getByRole("button", { name: "Instalar" }))

  await waitFor(() => expect(within(packs).queryByRole("status")).toBeNull())
  expect(within(packs).getByText("Instalado")).toBeTruthy()
  expect(toast.success).toHaveBeenCalledWith("acme v1 instalado: rige desde ya")
})

test("con selector nativo instalar elige la carpeta y un pack inválido muestra qué arreglar", async () => {
  const pickDirectory = vi.fn().mockResolvedValue("/code/roto")
  const installPack = vi.fn().mockRejectedValue(new Error("El pack en /code/roto es inválido, pack.json:\n  activate: falta el alcance"))
  await setup({ installPack }, { pickDirectory })
  const packs = screen.getByRole("region", { name: "Packs" })

  fireEvent.click(within(packs).getByRole("button", { name: /Instalar desde una carpeta/ }))

  await waitFor(() => expect(installPack).toHaveBeenCalledWith("/code/roto"))
  expect((await within(packs).findByRole("alert")).textContent).toContain("activate: falta el alcance")
})

test("quitar un pack instalado pide confirmación y lo saca de la lista", async () => {
  await setup()
  const packs = screen.getByRole("region", { name: "Packs" })
  fireEvent.change(within(packs).getByLabelText("Carpeta del pack"), { target: { value: "/code/acme-pack" } })
  fireEvent.click(within(packs).getByRole("button", { name: "Instalar" }))
  fireEvent.pointerDown(await within(packs).findByRole("button", { name: "Acciones de acme" }), { button: 0, ctrlKey: false })

  fireEvent.click(await screen.findByRole("menuitem", { name: "Quitar" }))
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Quitar" }))

  await waitFor(() => expect(within(packs).queryByRole("button", { name: "Acciones de acme" })).toBeNull())
  expect(within(packs).getByRole("button", { name: "Acciones de base" })).toBeTruthy()
  // Sin el pack, la org vuelve a quedar sin cubrir.
  expect(within(packs).getByRole("status")).toBeTruthy()
})

test("cambiar los defaults de proyectos nuevos manda solo lo que cambió y el toast lo deshace", async () => {
  const { data } = await setup()
  const setProjectDefaults = vi.spyOn(data, "setProjectDefaults")
  const defaults = screen.getByRole("region", { name: "Proyectos nuevos" })

  fireEvent.change(within(defaults).getByLabelText("Corridas a la vez"), { target: { value: "0" } })
  expect(within(defaults).getByRole("alert").textContent).toContain("entero de 1 en adelante")
  expect((screen.getByRole("button", { name: /Guardar cambios/ }) as HTMLButtonElement).disabled).toBe(true)

  fireEvent.change(within(defaults).getByLabelText("Corridas a la vez"), { target: { value: "3" } })
  fireEvent.change(within(defaults).getByLabelText("Tope de gasto por corrida (USD)"), { target: { value: "5" } })
  save()

  await waitFor(() => expect(setProjectDefaults).toHaveBeenCalledWith({ parallel: 3, maxCostUsd: 5 }))
})

test("avanzado muestra la carpeta de datos y el client_id de Linear, solo lectura, con dónde cambiarlos", async () => {
  await setup()
  const advanced = screen.getByRole("region", { name: "Avanzado" })

  expect(within(advanced).getByText("/Users/ana/Library/Application Support/Clanker Yard")).toBeTruthy()
  expect(within(advanced).getByText("60358f9aaddae2ba3a9c09e1419c2579")).toBeTruthy()
  expect(within(advanced).getByText(/CLANKER_LINEAR_CLIENT_ID/)).toBeTruthy()
  expect(within(advanced).queryAllByRole("textbox")).toHaveLength(0)
})
