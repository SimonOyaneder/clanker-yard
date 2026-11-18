// @vitest-environment jsdom
import type { CodexStatus, Connection } from "@clanker/api"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest"
import { AppDataProvider } from "@/app-data"
import { CodexCard } from "@/components/connections/codex-card"
import { CodexPlanUsage } from "@/components/connections/plan-usage"
import { TooltipProvider } from "@/components/ui/tooltip"
import { createMemoryAppData } from "@/demo/memory-app-data"
import { CODEX_REFRESH_MS, type CodexPlan } from "@/hooks/use-codex-plan"

const NOW = new Date(2026, 10, 18, 12, 0).getTime()
const HOUR = 3_600_000

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Element.prototype.hasPointerCapture = () => false
})
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const FIVE_HOURS = { id: "codex:primary", windowMins: 300, usedPercent: 23, resetsAt: NOW + 3 * HOUR }
const WEEK = { id: "codex:secondary", windowMins: 10_080, usedPercent: 61, resetsAt: NOW + 4 * 24 * HOUR }

const plan = (status: CodexStatus | null, fields: Partial<CodexPlan> = {}): CodexPlan => ({
  status,
  at: NOW,
  connected: true,
  testing: false,
  error: null,
  test: vi.fn(() => Promise.resolve(status)),
  ...fields,
})

const renderUsage = (p: CodexPlan) =>
  render(
    <TooltipProvider>
      <CodexPlanUsage plan={p} />
    </TooltipProvider>,
  )

const meters = () => screen.queryAllByRole("meter", { name: /^Uso del plan de Codex/ })

test("una ventana: una barra rotulada por su duración", () => {
  renderUsage(plan({ state: "ready", usage: { windows: [FIVE_HOURS] } }))
  expect(screen.getByRole("region", { name: "Uso del plan de Codex" })).toBeTruthy()
  expect(meters()).toHaveLength(1)
  expect(meters()[0]!.getAttribute("aria-label")).toBe("Uso del plan de Codex, ventana de 5 h")
  expect(meters()[0]!.getAttribute("aria-valuenow")).toBe("23")
})

test("dos ventanas: 5 h y 7 días, en el orden que trae el core", () => {
  renderUsage(plan({ state: "ready", usage: { windows: [FIVE_HOURS, WEEK] } }))
  expect(meters().map((m) => [m.getAttribute("aria-label"), m.getAttribute("aria-valuenow")])).toEqual([
    ["Uso del plan de Codex, ventana de 5 h", "23"],
    ["Uso del plan de Codex, ventana de 7 días", "61"],
  ])
})

test("sin ventanas no se muestra nada", () => {
  const { container } = renderUsage(plan({ state: "ready", usage: { windows: [] } }))
  expect(container.textContent).toBe("")
  renderUsage(plan(null))
  expect(screen.queryByRole("region", { name: "Uso del plan de Codex" })).toBeNull()
})

test("cuota agotada dice cuándo se renueva", () => {
  const exhausted = { ...FIVE_HOURS, usedPercent: 100 }
  renderUsage(plan({ state: "quota_exhausted", resetsAt: exhausted.resetsAt, usage: { windows: [exhausted, WEEK] } }))
  const region = screen.getByRole("region", { name: "Uso del plan de Codex" })
  expect(within(region).getByText("Cuota agotada · se renueva a las 15:00")).toBeTruthy()
  expect(meters()[0]!.getAttribute("aria-valuenow")).toBe("100")
})

test("un dato que el refresco no renovó se marca viejo", () => {
  renderUsage(plan({ state: "ready", usage: { windows: [FIVE_HOURS] } }, { at: NOW - 3 * CODEX_REFRESH_MS }))
  expect(screen.getByText(/^dato de /)).toBeTruthy()
  cleanup()
  renderUsage(plan({ state: "ready", usage: { windows: [FIVE_HOURS] } }, { at: null }))
  expect(screen.getByText("dato guardado")).toBeTruthy()
  cleanup()
  renderUsage(plan({ state: "ready", usage: { windows: [FIVE_HOURS] } }))
  expect(screen.queryByText(/^dato /)).toBeNull()
})

test("el botón de actualizar vuelve a leer el uso", () => {
  const p = plan({ state: "ready", usage: { windows: [FIVE_HOURS] } })
  renderUsage(p)
  fireEvent.click(screen.getByRole("button", { name: "Actualizar el uso del plan de Codex" }))
  expect(p.test).toHaveBeenCalledOnce()
})

const account: Connection = { provider: "codex", account: "subscription", scopes: ["plan:plus"], status: "active" }

function renderCard(p: CodexPlan, connection: Connection | undefined, confirming = false) {
  const data = createMemoryAppData(NOW)
  const disconnect = vi.spyOn(data, "disconnect")
  const onConfirmingChange = vi.fn()
  render(
    <AppDataProvider value={data}>
      <TooltipProvider>
        <CodexCard connection={connection} plan={p} confirming={confirming} onConfirmingChange={onConfirmingChange} onChanged={vi.fn()} />
      </TooltipProvider>
    </AppDataProvider>,
  )
  return { disconnect, onConfirmingChange }
}

test("la tarjeta sin cuenta ofrece conectar y dice qué hacer", () => {
  const p = plan(null, { connected: false })
  renderCard(p, undefined)
  const card = screen.getByRole("group", { name: "Codex" })
  expect(within(card).getByText("sin configurar")).toBeTruthy()
  expect(within(card).getByText(/codex login/)).toBeTruthy()
  fireEvent.click(within(card).getByRole("button", { name: "Conectar" }))
  expect(p.test).toHaveBeenCalledOnce()
})

test("la tarjeta con login vencido muestra el chip y el paso a seguir del core", () => {
  renderCard(plan({ state: "login_expired", message: "La sesión de Codex venció o fue rechazada: ejecuta `codex login` y vuelve a probar." }), { ...account, status: "expired" })
  const card = screen.getByRole("group", { name: "Codex" })
  expect(within(card).getByText("sesión vencida")).toBeTruthy()
  expect(within(card).getByRole("alert").textContent).toContain("codex login")
})

test("la tarjeta con la cuota agotada dice cuándo se renueva, con la hora local", () => {
  renderCard(plan({ state: "quota_exhausted", resetsAt: NOW + 3 * HOUR, message: "Se reinicia el 2026-11-18T18:00:00.000Z.", usage: { windows: [{ ...FIVE_HOURS, usedPercent: 100 }] } }), account)
  const card = screen.getByRole("group", { name: "Codex" })
  expect(within(card).getByRole("status").textContent).toContain("se renueve a las 15:00")
  expect(card.textContent).not.toContain("T18:00")
})

test("desconectar avisa que la sesión de Codex sigue iniciada", () => {
  const { disconnect } = renderCard(plan({ state: "ready", version: "0.169.1", plan: "plus", usage: { windows: [FIVE_HOURS, WEEK] } }), account, true)
  const dialog = screen.getByRole("alertdialog", { name: "¿Desconectar Codex?" })
  expect(dialog.textContent).toContain("no se cierra")
  fireEvent.click(within(dialog).getByRole("button", { name: "Desconectar" }))
  expect(disconnect).toHaveBeenCalledWith({ provider: "codex", account: "subscription" })
  expect(screen.getByText("Codex 0.169.1 · plan plus")).toBeTruthy()
})
