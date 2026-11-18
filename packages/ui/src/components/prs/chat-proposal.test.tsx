// @vitest-environment jsdom
import type { ChatProposal } from "@clanker/api"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ChatProposalCard, type ProposalCardProps, proposalApplyReason, proposalDiscardReason } from "./chat-proposal"

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const proposal: ChatProposal = {
  rev: 2,
  baseSha: "base-sha",
  summary: "Evitar aplicar dos veces la misma respuesta",
  status: "draft",
  items: [
    { id: "guard", change: "Agregar una comprobación antes de guardar", path: "src/answer.ts" },
    { id: "test", change: "Probar respuestas repetidas" },
  ],
  files: [
    { path: "src/answer.ts", additions: 8, deletions: 2 },
    { path: "assets/preview.png", additions: null, deletions: null },
  ],
}

function mount(overrides: Partial<ProposalCardProps> = {}) {
  const props: ProposalCardProps = {
    proposal,
    canApply: true,
    busy: false,
    pending: false,
    onView: vi.fn(),
    onApply: vi.fn(),
    onDiscard: vi.fn(),
    ...overrides,
  }
  const view = render(<TooltipProvider><ChatProposalCard {...props} /></TooltipProvider>)
  return { ...view, props }
}

test("muestra el resumen, los ítems y los archivos con líneas o formato binario", () => {
  mount()
  expect(screen.getByRole("region", { name: "Propuesta 2" })).toBeTruthy()
  expect(screen.getByText(proposal.summary)).toBeTruthy()
  const items = screen.getByRole("list", { name: "Cambios propuestos" })
  expect(within(items).getAllByRole("listitem")).toHaveLength(2)
  expect(within(items).getByText("src/answer.ts")).toBeTruthy()
  const files = screen.getByRole("list", { name: "Archivos de la propuesta" })
  expect(within(files).getByText("+8")).toBeTruthy()
  expect(within(files).getByText("−2")).toBeTruthy()
  expect(within(files).getByText("assets/preview.png")).toBeTruthy()
  expect(within(files).getByText("Binario")).toBeTruthy()
})

test.each([
  ["draft", "Por aplicar", true, true],
  ["applying", "Aplicando", false, false],
  ["applied", "Aplicada", false, false],
  ["discarded", "Descartada", false, false],
  ["stale", "Desactualizada", false, true],
  ["failed", "Falló", false, true],
] as const)("estado %s: controles consistentes con los motivos compartidos", (status, label, apply, discard) => {
  const { props } = mount({ proposal: { ...proposal, status } })
  expect(screen.getByText(label)).toBeTruthy()
  expect((screen.getByRole("button", { name: "Aplicar" }) as HTMLButtonElement).disabled).toBe(!apply)
  expect((screen.getByRole("button", { name: "Descartar" }) as HTMLButtonElement).disabled).toBe(!discard)
  expect((screen.getByRole("button", { name: "Ver cambios" }) as HTMLButtonElement).disabled).toBe(false)
  expect(proposalApplyReason(props) === null).toBe(apply)
  expect(proposalDiscardReason(props) === null).toBe(discard)
})

test.each([
  { busy: true, pending: false, canApply: true, viewEnabled: true },
  { busy: false, pending: true, canApply: true, viewEnabled: false },
  { busy: false, pending: false, canApply: false, viewEnabled: true },
])("respeta busy=$busy, pending=$pending y canApply=$canApply", ({ viewEnabled, ...overrides }) => {
  const { props } = mount(overrides)
  expect((screen.getByRole("button", { name: "Aplicar" }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole("button", { name: "Descartar" }) as HTMLButtonElement).disabled).toBe(overrides.busy || overrides.pending)
  expect((screen.getByRole("button", { name: "Ver cambios" }) as HTMLButtonElement).disabled).toBe(!viewEnabled)
  fireEvent.click(screen.getByRole("button", { name: "Aplicar" }))
  expect(props.onApply).not.toHaveBeenCalled()
})

test("delega las acciones sin llamar a AppData ni abrir una confirmación propia", () => {
  const { props } = mount()
  fireEvent.click(screen.getByRole("button", { name: "Ver cambios" }))
  fireEvent.click(screen.getByRole("button", { name: "Aplicar" }))
  fireEvent.click(screen.getByRole("button", { name: "Descartar" }))
  expect(props.onView).toHaveBeenCalledOnce()
  expect(props.onApply).toHaveBeenCalledOnce()
  expect(props.onDiscard).toHaveBeenCalledOnce()
  expect(screen.queryByRole("alertdialog")).toBeNull()
})

test("Aplicar deshabilitado tiene un Hint real, foco en su wrapper y descripción accesible", async () => {
  const reason = "Este PR tiene cambios de otra persona."
  mount({ canApply: false, applyReason: reason })
  const button = screen.getByRole("button", { name: "Aplicar" })
  const trigger = screen.getByRole("group", { name: "Aplicar" })
  expect(trigger.tabIndex).toBe(0)
  expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toBe(reason)
  fireEvent.focus(trigger)
  const tooltip = await screen.findByRole("tooltip")
  expect(tooltip.textContent).toContain(reason)
  expect(tooltip.textContent).toContain("⌥A")
  expect(trigger.getAttribute("aria-describedby")).toBe(tooltip.id)
})

test.each(["Ver cambios", "Descartar"])("%s pendiente explica por qué está deshabilitado al enfocar", async (label) => {
  mount({ pending: true })
  const trigger = screen.getByRole("group", { name: label })
  expect(trigger.tabIndex).toBe(0)
  fireEvent.focus(trigger)
  const tooltip = await screen.findByRole("tooltip")
  expect(tooltip.textContent).toContain("Hay una operación pendiente. Espera a que termine.")
  expect(trigger.getAttribute("aria-describedby")).toBe(tooltip.id)
})

test("el Hint de estado explica que una propuesta desactualizada necesita reemplazo", async () => {
  mount({ proposal: { ...proposal, status: "stale" } })
  fireEvent.focus(screen.getByText("Desactualizada"))
  const tooltip = await screen.findByRole("tooltip")
  expect(tooltip.textContent).toContain("El PR cambió desde que se preparó esta propuesta.")
  expect(tooltip.textContent).toContain("Pide una nueva propuesta antes de aplicar.")
})

test("el menú contextual usa las mismas restricciones y permite consultar propuestas aplicadas", () => {
  const { props } = mount({ proposal: { ...proposal, status: "applied" } })
  fireEvent.contextMenu(screen.getByRole("region", { name: "Propuesta 2" }))
  const menu = screen.getByRole("menu")
  expect(within(menu).getByRole("menuitem", { name: /Aplicar/ }).getAttribute("aria-disabled")).toBe("true")
  expect(within(menu).getByRole("menuitem", { name: /Descartar/ }).getAttribute("aria-disabled")).toBe("true")
  fireEvent.click(within(menu).getByRole("menuitem", { name: /Ver cambios/ }))
  expect(props.onView).toHaveBeenCalledOnce()
  expect(props.onApply).not.toHaveBeenCalled()
  expect(props.onDiscard).not.toHaveBeenCalled()
})

test("el menú contextual delega aplicar y descartar cuando están disponibles", () => {
  const { props } = mount()
  const card = screen.getByRole("region", { name: "Propuesta 2" })
  fireEvent.contextMenu(card)
  fireEvent.click(screen.getByRole("menuitem", { name: /Aplicar/ }))
  expect(props.onApply).toHaveBeenCalledOnce()
  fireEvent.contextMenu(card)
  fireEvent.click(screen.getByRole("menuitem", { name: /Descartar/ }))
  expect(props.onDiscard).toHaveBeenCalledOnce()
})

test("distingue hijos restackeados, actualizados, con conflicto y omitidos", () => {
  mount({
    childNames: new Map([["child-restacked", "demo#12"]]),
    proposal: {
      ...proposal,
      status: "applied",
      result: {
        sha: "applied-sha",
        children: [
          { prId: "child-restacked", status: "restacked", head: "new-child-head" },
          { prId: "child-uptodate", status: "uptodate" },
          { prId: "child-conflict", status: "conflict", files: ["src/conflict.ts", "src/other.ts"], failures: "No se pudo reaplicar el commit." },
          { prId: "child-skipped", status: "skipped", reason: "Tiene comentarios de revisión pendientes." },
        ],
      },
    },
  })
  const result = screen.getByLabelText("Resultado de la propuesta")
  expect(within(result).getByTitle("applied-sha").textContent).toBe("applied-s")
  expect(within(result).getByTitle("new-child-head").textContent).toBe("new-child")
  expect(result.textContent).toContain("demo#12")
  expect(result.textContent).toContain("Ya estaba actualizado. No necesitó cambios.")
  expect(result.textContent).toContain("Conflicto al actualizar la base.")
  const files = screen.getByRole("list", { name: "Archivos en conflicto de child-conflict" })
  expect(within(files).getByText("src/conflict.ts")).toBeTruthy()
  expect(within(files).getByText("src/other.ts")).toBeTruthy()
  expect(result.textContent).toContain("No se pudo reaplicar el commit.")
  expect(result.textContent).toContain("No se actualizó: Tiene comentarios de revisión pendientes.")
})

test("sin archivos indica cómo pedir cambios, sin inventar un resultado", () => {
  mount({ proposal: { ...proposal, items: [], files: [] } })
  expect(screen.getByText("No hay archivos en esta propuesta. Pide al agente los cambios que necesitas.")).toBeTruthy()
  expect(screen.queryByLabelText("Resultado de la propuesta")).toBeNull()
})
