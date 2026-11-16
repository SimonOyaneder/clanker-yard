// @vitest-environment jsdom
import type { Repo } from "@clanker/api"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest"
import { AppDataProvider, type AppData } from "@/app-data"
import { PrsView } from "@/components/prs/prs-view"
import { PrCommandsProvider } from "@/components/prs/pr-commands"
import { TooltipProvider } from "@/components/ui/tooltip"
import { HostProvider, type Host } from "@/host"
import { openPrsOf } from "@/lib/prs"
import { createMemoryAppData } from "@/memory-app-data"

const NOW = Date.parse("2026-11-15T12:00:00Z")

// xyflow monta con un ResizeObserver y un DOMMatrixReadOnly: jsdom no mide el DOM.
beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.DOMMatrixReadOnly = class {
    m22 = 1
  } as unknown as typeof DOMMatrixReadOnly
})
beforeEach(() => localStorage.setItem("cc.prs.mode", JSON.stringify("list")))
afterEach(() => {
  cleanup()
  localStorage.clear()
})

async function setup() {
  const data = createMemoryAppData(NOW)
  const prs = openPrsOf(await data.openPrs())
  const spies = {
    setPrHold: vi.spyOn(data, "setPrHold"),
    mergePr: vi.spyOn(data, "mergePr"),
    requestPrReview: vi.spyOn(data, "requestPrReview"),
    rebasePr: vi.spyOn(data, "rebasePr"),
  } satisfies Partial<Record<keyof AppData, unknown>>
  const host = { openExternal: vi.fn() } as unknown as Host
  render(
    <AppDataProvider value={data}>
      <HostProvider value={host}>
        <TooltipProvider>
          <PrCommandsProvider prs={prs} projects={[]} onOpenRun={() => {}}>
            <PrsView prs={prs} unread={0} issueKeys={new Map()} loaded error={null} registered={[]} onOpenConnections={() => {}} onRefresh={() => {}} />
          </PrCommandsProvider>
        </TooltipProvider>
      </HostProvider>
    </AppDataProvider>,
  )
  return { data, host, spies, prs }
}

const rowOf = (title: string) => screen.getByText(title).closest("li")!

test("cada PR muestra lo que el pack dice: riesgo alto, en cola, la cola falló y la base combinada", async () => {
  await setup()

  expect(within(rowOf("Renombrar Payments::Ledger a Payments::Posting")).getByText("Riesgo alto")).toBeTruthy()
  expect(within(rowOf("Arreglar el scroll del listado de cuentas")).getByText("En cola")).toBeTruthy()
  expect(within(rowOf("Migrar el job de conciliación")).getByText("Cola falló")).toBeTruthy()
  expect(within(rowOf("Cerrar la conciliación con el nuevo nombre")).getByText("Base combinada")).toBeTruthy()
  expect(within(rowOf("Migrar los tooltips a Radix")).getByText("Hold")).toBeTruthy()
  expect(within(rowOf("Prohibir imports cruzados entre engines")).getByText("Listo para merge")).toBeTruthy()
  // Sin la señal, el chip dice lo que el pack declaró para ese caso.
  expect(within(rowOf("Probar el nuevo índice de entradas en staging")).getByText("Sin riesgo")).toBeTruthy()
})

test("filtrar por un nivel de señal deja los PRs de ese nivel y su stack atenuado", async () => {
  await setup()

  fireEvent.click(within(screen.getByRole("group", { name: "Señales" })).getByRole("button", { name: /Riesgo alto/ }))

  expect(screen.queryByText("Arreglar el scroll del listado de cuentas")).toBeNull()
  expect(screen.getByText("Renombrar Payments::Ledger a Payments::Posting")).toBeTruthy()
  expect(screen.getByText("Cerrar la conciliación con el nuevo nombre")).toBeTruthy()
})

test("marcar hold desde el menú contextual lo manda al core y quitarlo también", async () => {
  const { spies, prs } = await setup()
  const pr = prs.find((p) => p.state.key === "ledger#421")!

  fireEvent.contextMenu(screen.getByText("Prohibir imports cruzados entre engines"))
  fireEvent.click(await screen.findByRole("menuitem", { name: /Marcar hold/ }))

  await waitFor(() => expect(spies.setPrHold).toHaveBeenCalledWith(pr.ref, true))
})

test("mergear confirma antes, nombra el comando del pack y solo entonces lo pide al core", async () => {
  const { spies, prs } = await setup()
  const pr = prs.find((p) => p.state.key === "ledger#421")!

  fireEvent.contextMenu(screen.getByText("Prohibir imports cruzados entre engines"))
  fireEvent.click(await screen.findByRole("menuitem", { name: /^Mergear…/ }))

  const dialog = await screen.findByRole("alertdialog")
  expect(within(dialog).getByText("¿Mergear ledger#421?")).toBeTruthy()
  expect(within(dialog).getByText("merge please")).toBeTruthy()
  expect(spies.mergePr).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole("button", { name: "Mergear" }))
  await waitFor(() => expect(spies.mergePr).toHaveBeenCalledWith(pr.ref))
})

test("un PR que no está listo muestra mergear apagado y el menú ofrece review del bot, rebase y la corrida solo si aplican", async () => {
  await setup()

  fireEvent.contextMenu(screen.getByText("Pantalla de resumen del pago"))

  expect((await screen.findByRole("menuitem", { name: /^Mergear…/ })).getAttribute("aria-disabled")).toBe("true")
  expect(screen.getByRole("menuitem", { name: /Pedir review del bot/ })).toBeTruthy()
  // No lo abrió el sistema: nunca se rebasea ni hay corrida que ver.
  expect(screen.queryByRole("menuitem", { name: /Rebasear/ })).toBeNull()
  expect(screen.queryByRole("menuitem", { name: /Ver corrida/ })).toBeNull()
})

test("los atajos actúan sobre el PR enfocado: B pide la review del bot y H marca hold", async () => {
  const { spies, prs } = await setup()
  const pr = prs.find((p) => p.state.key === "ledger#424")!

  fireEvent.focus(within(rowOf("Agregar checks de boundaries a CI")).getByRole("button"))
  fireEvent.keyDown(document.body, { key: "b" })
  await waitFor(() => expect(spies.requestPrReview).toHaveBeenCalledWith(pr.ref))
  fireEvent.keyDown(document.body, { key: "h" })
  await waitFor(() => expect(spies.setPrHold).toHaveBeenCalledWith(pr.ref, true))
})

test("sin PRs abiertos el estado vacío dice qué esperar", async () => {
  render(
    <AppDataProvider value={createMemoryAppData(NOW)}>
      <HostProvider value={{ openExternal: vi.fn() } as unknown as Host}>
        <TooltipProvider>
          <PrCommandsProvider prs={[]} projects={[]} onOpenRun={() => {}}>
            <PrsView prs={[]} unread={2} issueKeys={new Map()} loaded error={null} registered={[]} onOpenConnections={() => {}} onRefresh={() => {}} />
          </PrCommandsProvider>
        </TooltipProvider>
      </HostProvider>
    </AppDataProvider>,
  )

  expect(screen.getByText(/Watch todavía está leyendo tus PRs/)).toBeTruthy()
})

function renderEmpty(repos: Repo[], onOpenConnections = () => {}) {
  render(
    <AppDataProvider value={createMemoryAppData(NOW)}>
      <HostProvider value={{ openExternal: vi.fn() } as unknown as Host}>
        <TooltipProvider>
          <PrCommandsProvider prs={[]} projects={[]} onOpenRun={() => {}}>
            <PrsView prs={[]} unread={0} issueKeys={new Map()} loaded error={null} registered={repos} onOpenConnections={onOpenConnections} onRefresh={() => {}} />
          </PrCommandsProvider>
        </TooltipProvider>
      </HostProvider>
    </AppDataProvider>,
  )
}

const repo = (name: string, remote: string | null): Repo => ({ id: `repo_${name}` as Repo["id"], name, path: `/code/${name}`, remote, defaultBranch: "main", mergeStrategy: null })

test("sin repos registrados el vacío pide registrar uno y lleva a Conexiones", () => {
  const onOpenConnections = vi.fn()
  renderEmpty([], onOpenConnections)

  expect(screen.getByText(/Registra un repo en/)).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Conexiones" }))
  expect(onOpenConnections).toHaveBeenCalled()
})

test("con repos registrados y sin PRs el vacío dice en cuáles buscó y que Watch revisa cada pocos minutos", () => {
  renderEmpty([repo("api", "acme/api"), repo("local", null)])

  expect(screen.getByText(/acme\/api, local/)).toBeTruthy()
  expect(screen.getByText(/cada pocos minutos/)).toBeTruthy()
})
