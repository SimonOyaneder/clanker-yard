// @vitest-environment jsdom
import type { ClankerProject } from "@clanker/api"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import { AppDataProvider } from "@/app-data"
import { ProjectSummaryTab } from "@/components/summary/summary-view"
import { TooltipProvider } from "@/components/ui/tooltip"
import { type SummaryControls, useSummaryControls } from "@/hooks/use-summary-controls"
import { AppActionsContext, type AppActions } from "@/lib/app-context"
import { costUsd } from "@/lib/format"
import { createMemoryAppData } from "@/demo/memory-app-data"

const NOW = Date.parse("2026-11-15T12:00:00Z")

afterEach(cleanup)

// El Resumen con los controles reales de `App` (los atajos T, O y F) sobre los datos de ejemplo.
function Harness({ project, onControls }: { project: ClankerProject; onControls?: (c: SummaryControls) => void }) {
  const controls = useSummaryControls(true)
  onControls?.(controls)
  return <ProjectSummaryTab project={project} controls={controls} onOpenOperation={() => {}} />
}

async function setup() {
  const data = createMemoryAppData(NOW)
  const [project] = await data.projects()
  const actions = { openExternal: vi.fn() }
  render(
    <AppDataProvider value={data}>
      <AppActionsContext.Provider value={actions as unknown as AppActions}>
        <TooltipProvider>
          <Harness project={project!} />
        </TooltipProvider>
      </AppActionsContext.Provider>
    </AppDataProvider>,
  )
  const all = await data.projectMetrics(project!.id, {})
  await screen.findByRole("region", { name: "Métricas" })
  return { data, project: project!, all }
}

const tile = (label: string) => within(screen.getByRole("region", { name: "Métricas" })).getByText(label).parentElement!
const text = (el: HTMLElement) => el.textContent ?? ""
const card = (name: string) => screen.getByRole("region", { name })

test("las tarjetas de arriba son los totales de projects.summary y las barras por rol los suman", async () => {
  const { all } = await setup()

  expect(text(tile("Gasto total"))).toContain(costUsd(all.summary.costMicros))
  expect(text(tile("Corridas cerradas"))).toContain(String(all.summary.runs))
  expect(all.summary.runs).toBe(7)
  const roleBars = within(card("Gasto por rol")).getAllByRole("img")
  expect(roleBars).toHaveLength(all.summary.byRole.length)
  // Cada barra dice rol y gasto exacto, de mayor a menor.
  expect(roleBars.map((b) => b.getAttribute("aria-label"))).toEqual(all.summary.byRole.map((r) => expect.stringContaining(`${r.role}: ${costUsd(r.costMicros)}`)))
  // El gráfico por día cubre cada día de corrido y sus gastos suman el total.
  expect(all.byDay.reduce((n, d) => n + d.costMicros, 0)).toBe(all.summary.costMicros)
  expect(within(card("Gasto por día")).getAllByRole("button").length).toBeGreaterThanOrEqual(all.byDay.length)
})

test("filtrar por origen cambia los números pero cada rol conserva su color", async () => {
  await setup()
  const colorOf = (role: string) => within(card("Gasto por rol")).getByRole("img", { name: new RegExp(`^${role}:`) }).querySelector("span > span")!.className
  const devColor = colorOf("dev")
  const reviewColor = colorOf("review-bugs")
  expect(devColor).toMatch(/bg-viz-\d/)
  expect(reviewColor).not.toBe(devColor)

  fireEvent.click(screen.getByRole("radio", { name: "Yard" }))
  await waitFor(() => expect(text(tile("Corridas cerradas"))).toContain("3"))
  // Sin las importadas ya no está techlead, y el color de dev y de review no se movió.
  expect(within(card("Gasto por rol")).queryByRole("img", { name: /^techlead:/ })).toBeNull()
  expect(colorOf("dev")).toBe(devColor)
  expect(colorOf("review-bugs")).toBe(reviewColor)
  expect(within(card("Gasto por paso del flujo")).getAllByRole("img").map((b) => b.getAttribute("aria-label"))).toEqual([
    "implement: $4.70, 3 visitas",
    "plan: $1.20, 3 visitas",
    "reviews: $1.20, 3 visitas",
    "fix: $1.10, 1 visita",
  ])
})

test("las corridas importadas no tienen pasos: el corte lo dice y dice qué cambiar", async () => {
  await setup()

  fireEvent.click(screen.getByRole("radio", { name: "Importadas" }))

  await waitFor(() => expect(text(tile("Corridas cerradas"))).toContain("4"))
  expect(text(card("Gasto por paso del flujo"))).toMatch(/no guardan sus pasos.*Cambia el origen/)
})

test("un rango personalizado acota por días locales y uno sin cierres ofrece volver a todo el historial", async () => {
  await setup()

  // jsdom no mide ni hace scroll: Radix Select los pide al abrirse.
  Element.prototype.scrollIntoView = () => {}
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Rango de fechas" }), { key: "Enter" })
  fireEvent.click(await screen.findByRole("option", { name: "Personalizado" }))
  fireEvent.change(screen.getByLabelText("Desde"), { target: { value: "2026-11-08" } })
  fireEvent.change(screen.getByLabelText("Hasta"), { target: { value: "2026-11-15" } })
  await waitFor(() => expect(text(tile("Corridas cerradas"))).toContain("3"))

  fireEvent.change(screen.getByLabelText("Desde"), { target: { value: "2026-01-01" } })
  fireEvent.change(screen.getByLabelText("Hasta"), { target: { value: "2026-01-02" } })
  expect(await screen.findByText(/No cerró ninguna corrida con este rango/)).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Ver todo el historial" }))
  await waitFor(() => expect(text(tile("Corridas cerradas"))).toContain("7"))
})

test("T cambia todos los gráficos a su tabla accesible, con los mismos números", async () => {
  const { all } = await setup()

  fireEvent.keyDown(document.body, { key: "t" })

  const table = await within(card("Gasto por rol")).findByRole("table")
  const rows = within(table).getAllByRole("row").slice(1)
  expect(rows.map((r) => within(r).getAllByRole("cell").map((c) => c.textContent))).toEqual(all.summary.byRole.map((r) => [r.role, expect.any(String), costUsd(r.costMicros)]))
  expect(within(card("Gasto por día")).getByRole("table")).toBeTruthy()
  fireEvent.keyDown(document.body, { key: "t" })
  await waitFor(() => expect(within(card("Gasto por rol")).queryByRole("table")).toBeNull())
})

test("rondas por issue: la issue con más vueltas primero, con su costo", async () => {
  const { all } = await setup()

  const rows = within(card("Rondas por issue")).getAllByRole("row").slice(1)
  expect(rows).toHaveLength(all.byIssue.length)
  // La que más vueltas dio (review 3 + bot 3 + ci 2 en la importada) abre la tabla.
  expect(text(rows[0]!)).toMatch(/review 3 · bot 3 · ci 2/)
})
