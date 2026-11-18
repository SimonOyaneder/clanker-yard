// @vitest-environment jsdom
import type { Breaker } from "@clanker/api"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { AppDataProvider, type AppData, type ChatData } from "@/app-data"
import { applyPlan, ChatPanel } from "./chat-panel"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "sonner"
import { createMemoryAppData } from "@/demo/memory-app-data"
import { CHAT_SCENARIOS } from "@/demo/seed-chats"
import { UNDO_MS } from "@/hooks/use-decision-resolver"
import { LiveProvider } from "@/hooks/use-live"
import { usePrChat } from "@/hooks/use-pr-chat"
import type { OpenPr } from "@/lib/prs/prs"

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

function Harness({ data, pr, children }: { data: AppData; pr: OpenPr; children: OpenPr[] }) {
  return <ChatPanel controller={usePrChat(pr.id, data)} pr={pr} prChildren={children} />
}

async function setup(index: number, change?: (data: AppData & ChatData) => void, loaded = true) {
  const data = createMemoryAppData(NOW)
  const prId = CHAT_SCENARIOS[index]!.prId
  const snapshot = await data.chat({ prId })
  const prs = (await data.openPrs()) as OpenPr[]
  const pr = prs.find((p) => p.id === prId)!
  change?.(data)
  render(
    <AppDataProvider value={data}>
      <TooltipProvider delayDuration={0}>
        <LiveProvider><Harness data={data} pr={pr} children={prs.filter((p) => p.parents.includes(prId))} /></LiveProvider>
        <Toaster />
      </TooltipProvider>
    </AppDataProvider>,
  )
  if (loaded) await screen.findByRole("combobox", { name: "Runtime y modelo del chat" })
  return { data, prId, snapshot, pr }
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
  expect(screen.getByRole("combobox", { name: "Runtime y modelo del chat" }).textContent).toContain(snapshot.chat.model)
  if (snapshot.chat.busy) {
    expect(screen.getByRole("button", { name: /Interrumpir turno/ })).toHaveProperty("disabled", false)
    expect(screen.queryByRole("button", { name: /Enviar mensaje/ })).toBeNull()
  } else {
    const send = screen.getByRole("button", { name: /Enviar mensaje/ })
    expect(send).toHaveProperty("disabled", true)
    fireEvent.focus(send.parentElement!)
    expect((await screen.findByRole("tooltip")).textContent).toContain(index === 4 ? "Espera a que termine la aplicación." : "Escribe un mensaje para enviar.")
    fireEvent.blur(send.parentElement!)
    const input = screen.getByRole("textbox", { name: "Mensaje para el chat" })
    fireEvent.change(input, { target: { value: "Revisa este cambio" } })
    expect(send).toHaveProperty("disabled", index === 4)
    if (index === 4) {
      const sendChat = vi.spyOn(data, "sendChat")
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
  if (index === 4) expect(screen.getByRole("status", { name: "Progreso de la aplicación" })).toBeTruthy()
  if (index === 5) {
    expect(screen.getByText(/Actualizado sobre la nueva punta/)).toBeTruthy()
    expect(screen.getAllByText(/conflicto/i).length).toBeGreaterThan(0)
    expect(await screen.findByText("acme/ledger#424")).toBeTruthy()
  }
  if (index === 6) expect(screen.getByRole("button", { name: "Rehacer sobre el PR actual" })).toBeTruthy()
})

test("los ejemplos del estado vacío llenan el composer", async () => {
  await setup(0)
  fireEvent.click(screen.getByRole("button", { name: "Agrega un test para el caso borde que falta." }))
  expect(screen.getByRole("textbox", { name: "Mensaje para el chat" })).toHaveProperty("value", "Agrega un test para el caso borde que falta.")
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

test("el turno llega en vivo y Esc en el composer lo interrumpe", async () => {
  const { data, snapshot } = await setup(1)
  const interrupt = vi.spyOn(data, "interruptChat")
  const before = snapshot.messages.findLast((message) => message.role === "assistant")!.text
  expect(screen.getByText(before)).toBeTruthy()
  await waitFor(() => expect(screen.queryByText(before, { exact: true })).toBeNull(), { timeout: 5000 })
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Mensaje para el chat" }), { key: "Escape" })
  await waitFor(() => expect(interrupt).toHaveBeenCalledWith({ chatId: snapshot.chat.id }))
  expect(await screen.findByRole("button", { name: /Enviar mensaje/ })).toBeTruthy()
})

test("con el breaker del runtime abierto el composer queda apagado y dice por qué", async () => {
  const breaker: Breaker = { scope: "runtime:opencode", label: "runtime:opencode", cause: "quota_exhausted", reason: "Se agotó la cuota de opencode.", openedAt: NOW, probes: 1, nextProbeAt: NOW + 60_000, decisionId: "dec_01M7QQ00000000000000000000" }
  await setup(0, (data) => {
    vi.spyOn(data, "breakers").mockResolvedValue([breaker])
  })
  fireEvent.change(screen.getByRole("textbox", { name: "Mensaje para el chat" }), { target: { value: "Hola" } })
  const send = screen.getByRole("button", { name: /Enviar mensaje/ })
  await waitFor(() => expect(send).toHaveProperty("disabled", true))
  fireEvent.focus(send.parentElement!)
  expect((await screen.findByRole("tooltip")).textContent).toContain("El runtime opencode está en pausa: Se agotó la cuota de opencode.")
})

test("cambiar el runtime manda el modelo elegido con el próximo mensaje", async () => {
  const { data, snapshot } = await setup(0, (data) => {
    vi.spyOn(data, "agentOptions").mockResolvedValue({
      runtimes: [
        { id: "claude-sdk", label: "Claude", about: "Claude Code", available: true, models: [{ id: "sonnet", label: "Sonnet", about: "Equilibrado" }], efforts: [] },
        { id: "opencode", label: "opencode", about: "opencode", available: true, models: [{ id: "openai/gpt-6.1-terra", label: "GPT 6.1 Terra", about: "Rápido" }], efforts: [] },
        { id: "codex", label: "Codex", about: "Codex", available: false, models: [{ id: "gpt-5.5", label: "GPT 5.5", about: "Codex" }], efforts: [] },
      ],
    })
  })
  const send = vi.spyOn(data, "sendChat")
  fireEvent.click(screen.getByRole("combobox", { name: "Runtime y modelo del chat" }))
  expect(screen.queryByRole("option", { name: "GPT 5.5" })).toBeNull()
  fireEvent.click(await screen.findByRole("option", { name: "Sonnet" }))
  fireEvent.change(screen.getByRole("textbox", { name: "Mensaje para el chat" }), { target: { value: "Sigue" } })
  fireEvent.click(screen.getByRole("button", { name: /Enviar mensaje/ }))
  await waitFor(() => expect(send).toHaveBeenCalledWith({ chatId: snapshot.chat.id, text: "Sigue", runtime: "claude-sdk", model: "sonnet" }))
})

test("aplicar abre un diálogo con lo concreto y Enter lo confirma", async () => {
  const { data, snapshot } = await setup(3)
  const apply = vi.spyOn(data, "applyProposal")
  fireEvent.keyDown(window, { key: "Enter", metaKey: true, shiftKey: true })
  const dialog = await screen.findByRole("alertdialog")
  expect(within(dialog).getByText(/fixups de los commits del PR, se squashean y se pushean con lease/)).toBeTruthy()
  expect(within(dialog).getByText(/checks de la receta/)).toBeTruthy()
  expect(apply).not.toHaveBeenCalled()
  fireEvent.keyDown(dialog, { key: "Enter" })
  await waitFor(() => expect(apply).toHaveBeenCalledWith({ chatId: snapshot.chat.id, rev: snapshot.proposal!.rev }))
})

test("el texto del diálogo de aplicar dice dónde queda el cambio: remoto, con council o local, y qué hijos se restackean", () => {
  const remote = { id: "a", local: null, parents: [], state: { threads: { councilEver: false }, key: "acme/web#1" } } as unknown as OpenPr
  const council = { ...remote, state: { ...remote.state, threads: { councilEver: true } } } as unknown as OpenPr
  const local = { id: "l", local: { branch: "cla-2", base: "cla-1", title: "Local" }, parents: ["a"], state: null } as unknown as OpenPr
  const stacked = { id: "b", local: null, parents: ["a"], state: { key: "acme/web#2" } } as unknown as OpenPr
  const combined = { id: "c", local: null, parents: ["a", "d"], state: { key: "acme/web#3" } } as unknown as OpenPr

  expect(applyPlan(remote, [stacked, combined])).toMatchObject({
    where: "Los cambios salen como fixups de los commits del PR, se squashean y se pushean con lease.",
    children: ["acme/web#2 (apilado)", "acme/web#3 (base combinada)"],
  })
  expect(applyPlan(council, []).where).toBe("Los cambios salen como commits fixup! visibles y se pushean sin forzar: el PR tuvo threads de council y su historia no se reescribe.")
  expect(applyPlan(local, [{ ...local, id: "m", parents: ["l"], local: { branch: "cla-3", base: "cla-2", title: "Hijo" } } as unknown as OpenPr])).toMatchObject({
    where: "Los cambios quedan como commits del PR local, en esta máquina: nada se pushea hasta que el PR se publique.",
    children: ["cla-3 (apilado), local"],
  })
})

test("descartar y reiniciar esperan unos segundos con Deshacer antes de llegar al core", async () => {
  const { data, snapshot } = await setup(3)
  const discard = vi.spyOn(data, "discardProposal")
  const reset = vi.spyOn(data, "resetChat")
  vi.useFakeTimers({ shouldAdvanceTime: true })
  fireEvent.keyDown(window, { code: "KeyD", altKey: true })
  fireEvent.click(await screen.findByRole("button", { name: "Deshacer" }))
  await act(() => vi.advanceTimersByTimeAsync(UNDO_MS + 100))
  expect(discard).not.toHaveBeenCalled()

  fireEvent.keyDown(window, { code: "KeyD", altKey: true })
  await act(() => vi.advanceTimersByTimeAsync(UNDO_MS + 100))
  await waitFor(() => expect(discard).toHaveBeenCalledWith({ chatId: snapshot.chat.id }))

  fireEvent.keyDown(window, { code: "KeyR", altKey: true })
  await act(() => vi.advanceTimersByTimeAsync(UNDO_MS + 100))
  await waitFor(() => expect(reset).toHaveBeenCalledWith({ chatId: snapshot.chat.id }))
})

test("un error al cargar el chat permite reintentar y no deja enviar a un chat desconocido", async () => {
  const { data } = await setup(0, (data) => {
    vi.spyOn(data, "chat").mockRejectedValue(new Error("No pude cargar el chat. Vuelve a intentar."))
  }, false)
  expect((await screen.findByRole("alert")).textContent).toContain("No pude cargar el chat.")
  fireEvent.change(screen.getByRole("textbox", { name: "Mensaje para el chat" }), { target: { value: "Hola" } })
  const send = screen.getByRole("button", { name: /Enviar mensaje/ })
  expect(send).toHaveProperty("disabled", true)
  fireEvent.focus(send.parentElement!)
  expect((await screen.findByRole("tooltip")).textContent).toContain("Reintenta cargar el chat.")
  fireEvent.blur(send.parentElement!)
  vi.mocked(data.chat).mockRestore()
  fireEvent.click(screen.getByRole("button", { name: "Reintentar" }))
  expect(await screen.findByRole("combobox", { name: "Runtime y modelo del chat" })).toBeTruthy()
})
