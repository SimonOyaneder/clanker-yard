// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { AppDataProvider, type AppData, type ChatData } from "@/app-data"
import { ChatPanel } from "./chat-panel"
import { TooltipProvider } from "@/components/ui/tooltip"
import { createMemoryAppData } from "@/demo/memory-app-data"
import { CHAT_SCENARIOS } from "@/demo/seed-chats"
import { LiveProvider } from "@/hooks/use-live"
import { usePrChat } from "@/hooks/use-pr-chat"

const NOW = Date.parse("2026-11-18T12:00:00Z")
const scrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView")
const hasPointerCapture = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "hasPointerCapture")

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {}
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  HTMLElement.prototype.hasPointerCapture = () => false
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  if (scrollIntoView) Object.defineProperty(Element.prototype, "scrollIntoView", scrollIntoView)
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView")
  if (hasPointerCapture) Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", hasPointerCapture)
  else Reflect.deleteProperty(HTMLElement.prototype, "hasPointerCapture")
})

function Harness({ data, prId }: { data: ChatData; prId: string }) {
  return <ChatPanel controller={usePrChat(prId, data)} />
}

async function setup(index: number, change?: (data: AppData & ChatData) => void, loaded = true) {
  const data = createMemoryAppData(NOW)
  const prId = CHAT_SCENARIOS[index]!.prId
  const snapshot = await data.chat({ prId })
  change?.(data)
  render(
    <AppDataProvider value={data}>
      <TooltipProvider delayDuration={0}>
        <LiveProvider><Harness data={data} prId={prId} /></LiveProvider>
      </TooltipProvider>
    </AppDataProvider>,
  )
  if (loaded) await screen.findByText(snapshot.chat.model)
  return { data, prId, snapshot }
}

test.each([
  { index: 0, label: "vacío", applyReason: null, discardReason: null },
  { index: 1, label: "turno en curso", applyReason: null, discardReason: null },
  { index: 2, label: "explicación", applyReason: null, discardReason: null },
  { index: 3, label: "propuesta lista", applyReason: null, discardReason: null },
  { index: 4, label: "aplicando", applyReason: "La propuesta se está aplicando. Espera el resultado.", discardReason: "La propuesta se está aplicando. Espera el resultado." },
  { index: 5, label: "aplicada", applyReason: "Los cambios se aplicaron al PR. El resultado de sus hijos se muestra por separado.", discardReason: "Los cambios se aplicaron al PR. El resultado de sus hijos se muestra por separado." },
  { index: 6, label: "stale", applyReason: "El PR cambió desde que se preparó esta propuesta. Pide una nueva propuesta antes de aplicar.", discardReason: null },
  { index: 7, label: "login vencido", applyReason: "La sesión de Claude venció. Vuelve a conectar Claude en Conexiones y reintenta.", discardReason: null },
  { index: 8, label: "PR ajeno", applyReason: "Este PR no lo abrió Clanker Yard. Puedes conversar y revisar propuestas, pero no aplicarlas.", discardReason: null },
])("el escenario $label muestra las acciones del estado y sus restricciones", async ({ index, applyReason, discardReason }) => {
  const { data, snapshot } = await setup(index)
  expect(screen.getByText(snapshot.chat.runtime)).toBeTruthy()
  if (snapshot.chat.busy) {
    expect(screen.getByRole("button", { name: "Interrumpir turno" })).toHaveProperty("disabled", false)
    expect(screen.queryByRole("button", { name: "Enviar mensaje" })).toBeNull()
  } else {
    const send = screen.getByRole("button", { name: "Enviar mensaje" })
    expect(send).toHaveProperty("disabled", true)
    fireEvent.focus(send.parentElement!)
    expect((await screen.findByRole("tooltip")).textContent).toContain(index === 4 ? "Espera a que termine la aplicación." : "Escribe un mensaje para enviar.")
    fireEvent.blur(send.parentElement!)
    const input = screen.getByRole("textbox", { name: "Mensaje para el chat" })
    fireEvent.change(input, { target: { value: "Revisa este cambio" } })
    expect(send).toHaveProperty("disabled", index === 4)
    if (index === 4) {
      const sendChat = vi.spyOn(data, "sendChat")
      fireEvent.focus(send.parentElement!)
      expect((await screen.findByRole("tooltip")).textContent).toContain("Espera a que termine la aplicación.")
      fireEvent.blur(send.parentElement!)
      fireEvent.click(send)
      fireEvent.keyDown(input, { key: "Enter", metaKey: true })
      expect(sendChat).not.toHaveBeenCalled()
    }
  }
  if (snapshot.proposal) {
    expect(screen.getByText(snapshot.proposal.summary)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Ver cambios" })).toHaveProperty("disabled", false)
    for (const [label, reason] of [["Aplicar", applyReason], ["Descartar", discardReason]] as const) {
      const button = screen.getByRole("button", { name: label })
      expect(button).toHaveProperty("disabled", reason !== null)
      if (reason) {
        const trigger = screen.getByRole("group", { name: label })
        fireEvent.focus(trigger)
        expect((await screen.findByRole("tooltip")).textContent).toContain(reason)
        fireEvent.blur(trigger)
        fireEvent.click(button)
        expect(screen.queryByRole("alertdialog")).toBeNull()
      }
    }
  } else {
    expect(screen.queryByRole("button", { name: "Aplicar" })).toBeNull()
  }
  if (index === 0) expect(screen.getByText("¿Qué quieres revisar de este PR?")).toBeTruthy()
  if (index === 5) {
    expect(screen.getByText(/Actualizado sobre la nueva punta/)).toBeTruthy()
    expect(screen.getAllByText(/conflicto/i).length).toBeGreaterThan(0)
    expect(await screen.findByText("acme/ledger#424")).toBeTruthy()
    expect(screen.getByText("acme/ledger#427")).toBeTruthy()
  }
  if (index === 7) expect(screen.getByRole("status").textContent).toMatch(/login|sesión/i)
})

test("⌘Enter envía una sola vez, Enter deja escribir y el texto se conserva si falla", async () => {
  const { data, snapshot } = await setup(0)
  const send = vi.spyOn(data, "sendChat").mockRejectedValueOnce(new Error("Sesión vencida: inicia sesión y vuelve a intentar."))
  const input = screen.getByRole("textbox", { name: "Mensaje para el chat" })
  fireEvent.change(input, { target: { value: "Explica este cambio" } })
  fireEvent.keyDown(input, { key: "Enter" })
  expect(send).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: "Enter", metaKey: true })
  fireEvent.keyDown(input, { key: "Enter", metaKey: true })
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Sesión vencida"))
  expect(send.mock.calls).toEqual([[{ chatId: snapshot.chat.id, text: "Explica este cambio" }]])
  expect(input).toHaveProperty("value", "Explica este cambio")
  fireEvent.keyDown(input, { key: "Enter", metaKey: true })
  await waitFor(() => expect(input).toHaveProperty("value", ""))
  expect(send).toHaveBeenCalledTimes(2)
})

test("el texto llega por eventos y se puede interrumpir el turno", async () => {
  const { data, snapshot } = await setup(1)
  const interrupt = vi.spyOn(data, "interruptChat")
  const before = snapshot.messages.findLast((message) => message.role === "assistant")!.text
  expect(screen.getByText(before)).toBeTruthy()
  await waitFor(() => expect(screen.queryByText(before, { exact: true })).toBeNull(), { timeout: 5000 })
  fireEvent.click(screen.getByRole("button", { name: "Interrumpir turno" }))
  await waitFor(() => expect(interrupt).toHaveBeenCalledWith({ chatId: snapshot.chat.id }))
  expect(await screen.findByRole("button", { name: "Enviar mensaje" })).toBeTruthy()
})

test("Ver cambios usa el patch de la revisión y aplicar requiere confirmación", async () => {
  const { data, snapshot } = await setup(3)
  const diff = vi.spyOn(data, "chatProposal")
  const apply = vi.spyOn(data, "applyProposal")
  fireEvent.click(screen.getByRole("button", { name: "Ver cambios" }))
  const dialog = await screen.findByRole("dialog")
  await waitFor(() => expect(diff).toHaveBeenCalledWith({ chatId: snapshot.chat.id, rev: snapshot.proposal!.rev }))
  expect(within(dialog).getByText("Estos cambios son del borrador, no del diff actual del PR.")).toBeTruthy()
  expect((await within(dialog).findAllByRole("table")).length).toBeGreaterThan(0)
  fireEvent.keyDown(dialog, { key: "Escape" })
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  fireEvent.click(screen.getByRole("button", { name: "Aplicar" }))
  expect(apply).not.toHaveBeenCalled()
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Aplicar" }))
  await waitFor(() => expect(apply).toHaveBeenCalledWith({ chatId: snapshot.chat.id, rev: snapshot.proposal!.rev }))
})

test("un error al cargar el chat permite reintentar y no deja enviar a un chat desconocido", async () => {
  const { data, snapshot } = await setup(0, (data) => {
    vi.spyOn(data, "chat").mockRejectedValue(new Error("No pude cargar el chat. Vuelve a intentar."))
  }, false)
  expect((await screen.findByRole("alert")).textContent).toContain("No pude cargar el chat.")
  fireEvent.change(screen.getByRole("textbox", { name: "Mensaje para el chat" }), { target: { value: "Hola" } })
  const send = screen.getByRole("button", { name: "Enviar mensaje" })
  expect(send).toHaveProperty("disabled", true)
  fireEvent.focus(send.parentElement!)
  expect((await screen.findByRole("tooltip")).textContent).toContain("Reintenta cargar el chat.")
  fireEvent.blur(send.parentElement!)
  vi.mocked(data.chat).mockRestore()
  fireEvent.click(screen.getByRole("button", { name: "Reintentar" }))
  expect(await screen.findByText(snapshot.chat.model)).toBeTruthy()
})

test("un error al abrir los cambios conserva la propuesta y se reintenta dentro del diálogo", async () => {
  await setup(3, (data) => {
    vi.spyOn(data, "chatProposal").mockRejectedValueOnce(new Error("No pude leer el patch. Vuelve a intentar."))
  })
  fireEvent.click(screen.getByRole("button", { name: "Ver cambios" }))
  const dialog = await screen.findByRole("dialog")
  expect((await within(dialog).findByRole("alert")).textContent).toContain("No pude leer el patch.")
  fireEvent.click(within(dialog).getByRole("button", { name: "Reintentar" }))
  expect((await within(dialog).findAllByRole("table")).length).toBeGreaterThan(0)
})

test("descartar y reiniciar desde sus atajos piden confirmación", async () => {
  const { data, snapshot } = await setup(3)
  const discard = vi.spyOn(data, "discardProposal")
  const reset = vi.spyOn(data, "resetChat")
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Mensaje para el chat" }), { code: "KeyD", altKey: true })
  expect(screen.queryByRole("alertdialog")).toBeNull()
  fireEvent.keyDown(window, { code: "KeyD", altKey: true })
  const discardDialog = await screen.findByRole("alertdialog")
  expect(discard).not.toHaveBeenCalled()
  fireEvent.click(within(discardDialog).getByRole("button", { name: "Descartar" }))
  await waitFor(() => expect(discard).toHaveBeenCalledWith({ chatId: snapshot.chat.id }))
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
  fireEvent.keyDown(window, { code: "KeyR", altKey: true })
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Reiniciar" }))
  await waitFor(() => expect(reset).toHaveBeenCalledWith({ chatId: snapshot.chat.id }))
  expect(await screen.findByText("¿Qué quieres revisar de este PR?")).toBeTruthy()
})
