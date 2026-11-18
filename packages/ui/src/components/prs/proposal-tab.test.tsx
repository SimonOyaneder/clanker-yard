// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { AppDataProvider } from "@/app-data"
import { createMemoryAppData } from "@/demo/memory-app-data"
import { CHAT_SCENARIOS } from "@/demo/seed-chats"
import { LiveProvider } from "@/hooks/use-live"
import { ProposalTab } from "./proposal-tab"

const NOW = Date.parse("2026-11-18T12:00:00Z")
const hasPointerCapture = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "hasPointerCapture")
beforeEach(() => {
  HTMLElement.prototype.hasPointerCapture = () => false
  Element.prototype.scrollIntoView = () => {}
})
afterEach(() => {
  cleanup()
  if (hasPointerCapture) Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", hasPointerCapture)
})

test("muestra el diff de la propuesta vigente, cambia de modo y pide solo lo del turno contra la rev anterior", async () => {
  const data = createMemoryAppData(NOW)
  const { chat, proposal } = await data.chat({ prId: CHAT_SCENARIOS[3]!.prId })
  const read = vi.spyOn(data, "chatProposal")
  const onMode = vi.fn()
  const view = (rev: number) => (
    <AppDataProvider value={data}>
      <LiveProvider><ProposalTab chatId={chat.id} proposal={{ ...proposal!, rev }} mode="unified" onMode={onMode} /></LiveProvider>
    </AppDataProvider>
  )
  const { rerender } = render(view(1))

  expect((await screen.findAllByRole("table")).length).toBe(2)
  expect(read).toHaveBeenLastCalledWith({ chatId: chat.id, rev: 1 })
  expect(screen.getByRole("checkbox", { name: "Solo lo de este turno" })).toHaveProperty("disabled", true)
  fireEvent.click(screen.getByRole("radio", { name: "Lado a lado" }))
  expect(onMode).toHaveBeenCalledWith("split")

  rerender(view(2))
  await waitFor(() => expect(read).toHaveBeenLastCalledWith({ chatId: chat.id, rev: 2 }))
  fireEvent.click(screen.getByRole("checkbox", { name: "Solo lo de este turno" }))
  await waitFor(() => expect(read).toHaveBeenLastCalledWith({ chatId: chat.id, rev: 2, since: 1 }))
})
