// @vitest-environment jsdom
import type { ClankerProject, Connection } from "@clanker/api"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeAll, expect, test, vi } from "vitest"
import { AppDataProvider } from "@/app-data"
import { LinearCard, projectsOfAccount } from "@/components/connections/linear-card"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { LinearLogin } from "@/hooks/use-linear-login"
import { HostProvider, type Host } from "@/host"
import { createMemoryAppData } from "@/demo/memory-app-data"

const NOW = Date.parse("2026-11-15T12:00:00Z")

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Element.prototype.hasPointerCapture = () => false
})
afterEach(cleanup)

const connection = (account: string): Connection => ({ provider: "linear", account, scopes: ["read", "write"], status: "active", expiresAt: NOW + 86_400_000 })
const project = (name: string, trackerAccount: string | null, tracker: ClankerProject["tracker"] = "linear") => ({ id: `prj_${name}`, name, tracker, trackerAccount }) as unknown as ClankerProject

function setup(connections: Connection[], projects: ClankerProject[]) {
  const data = createMemoryAppData(NOW)
  const disconnect = vi.spyOn(data, "disconnect")
  const login: LinearLogin = { pending: null, error: null, start: vi.fn(() => Promise.resolve()) }
  const onChanged = vi.fn()
  render(
    <AppDataProvider value={data}>
      <HostProvider value={{ openExternal: vi.fn() } as unknown as Host}>
        <TooltipProvider>
          <LinearCard connections={connections} projects={projects} login={login} onChanged={onChanged} />
        </TooltipProvider>
      </HostProvider>
    </AppDataProvider>,
  )
  return { disconnect, login, onChanged }
}

test("lista cada workspace con su Reconectar y 'Conectar otro workspace' lanza el mismo OAuth", () => {
  const { login } = setup([connection("acme"), connection("clanker-yard")], [])

  expect(screen.getAllByRole("group", { name: "Linear" })).toHaveLength(2)
  expect(screen.getAllByText("acme").length).toBeGreaterThan(0)
  expect(screen.getAllByText("clanker-yard").length).toBeGreaterThan(0)
  expect(screen.getAllByRole("button", { name: "Reconectar" })).toHaveLength(2)

  fireEvent.click(screen.getByRole("button", { name: "Conectar otro workspace" }))
  fireEvent.click(screen.getAllByRole("button", { name: "Reconectar" })[0]!)
  expect(login.start).toHaveBeenCalledTimes(2)
})

test("sin workspaces ofrece conectar y no el botón de otro workspace", () => {
  setup([], [])

  expect(screen.getByRole("button", { name: "Conectar con Linear" })).toBeTruthy()
  expect(screen.queryByRole("button", { name: "Conectar otro workspace" })).toBeNull()
})

test("desconectar un workspace que usan proyectos avisa cuáles se quedan sin tracker, y solo desconecta esa cuenta", async () => {
  const { disconnect, onChanged } = setup([connection("acme"), connection("clanker-yard")], [project("Pagos", "acme"), project("Yard MVP", "clanker-yard"), project("Local", null, "local")])

  fireEvent.keyDown(within(screen.getAllByRole("group", { name: "Linear" })[0]!).getByRole("button", { name: /Más acciones/ }), { key: "Enter" })
  fireEvent.click(await screen.findByRole("menuitem", { name: /Desconectar/ }))

  const dialog = await screen.findByRole("alertdialog")
  expect(dialog.textContent).toContain("Se quedan sin tracker: Pagos.")
  expect(dialog.textContent).not.toContain("Yard MVP")
  fireEvent.click(within(dialog).getByRole("button", { name: "Desconectar" }))

  await waitFor(() => expect(disconnect).toHaveBeenCalledWith({ provider: "linear", account: "acme" }))
  await waitFor(() => expect(onChanged).toHaveBeenCalled())
})

test("con una sola cuenta, los proyectos que aún no fijaron la suya cuentan como de ella; con varias no", () => {
  const projects = [project("Viejo", null), project("Pagos", "acme")]

  expect(projectsOfAccount(projects, "acme", 1).map((p) => p.name)).toEqual(["Viejo", "Pagos"])
  expect(projectsOfAccount(projects, "acme", 2).map((p) => p.name)).toEqual(["Pagos"])
})
