import { ChatMessage, ChatProposal, Event, PrChat, RunId } from "@clanker/api"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createMemoryAppData } from "@/demo/memory-app-data"
import { CHAT_SCENARIOS, seedPrChats } from "@/demo/seed-chats"
import { buildOpenPrs } from "@/demo/seed-prs"

const NOW = Date.parse("2026-11-15T12:00:00Z")
const scenario = (id: typeof CHAT_SCENARIOS[number]["id"]) => CHAT_SCENARIOS.find((item) => item.id === id)!
const read = (data: ReturnType<typeof createMemoryAppData>, id: typeof CHAT_SCENARIOS[number]["id"]) => data.chat({ prId: scenario(id).prId })
const subscribe = async (data: ReturnType<typeof createMemoryAppData>, after = 0, controller = new AbortController()) => {
  const stream = await data.events(after, controller.signal)
  return { iterator: stream[Symbol.asyncIterator](), controller }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

test("los nueve escenarios reutilizan PRs y conservan el inventario y los esquemas", () => {
  const prs = buildOpenPrs(NOW)
  const before = structuredClone(prs)
  const seeds = seedPrChats(prs, NOW)
  expect(prs).toEqual(before)
  expect(new Set(CHAT_SCENARIOS.map((item) => item.prId)).size).toBe(9)
  expect(CHAT_SCENARIOS.map(({ prId }) => prs.find((pr) => pr.id === prId)?.state?.key)).toEqual([
    "dashboard#977", "ledger#424", "ledger#426", "ledger#427", "payments-api#391", "ledger#421", "payments-api#388", "payments-api#395", "dashboard#955",
  ])
  for (const seed of seeds) {
    expect(PrChat.parse(seed.chat)).toEqual(seed.chat)
    for (const message of seed.messages) expect(ChatMessage.parse(message)).toEqual(message)
    if (seed.proposal) expect(ChatProposal.parse(seed.proposal)).toEqual(seed.proposal)
  }
  const state = (id: typeof CHAT_SCENARIOS[number]["id"]) => seeds.find((seed) => seed.chat.prId === scenario(id).prId)!
  expect(state("empty")).toMatchObject({ messages: [], proposal: null })
  expect(state("streaming").chat.busy).toBe(true)
  expect(state("explanation").proposal).toBeNull()
  expect(state("draft").proposal?.status).toBe("draft")
  expect(state("applying").proposal?.status).toBe("applying")
  expect(state("stale").proposal?.status).toBe("stale")
  expect(state("applied").proposal?.result?.children.map((child) => child.status)).toEqual(["restacked", "conflict"])
  expect(state("expired")).toMatchObject({ chat: { canApply: false, runtime: "claude-sdk" }, messages: expect.arrayContaining([expect.objectContaining({ role: "system", text: expect.stringMatching(/sesión de Claude venció/) })]) })
  expect(state("unowned")).toMatchObject({ chat: { canApply: false }, proposal: { status: "draft" } })
})

test("send simula streaming, respeta la configuración y publica una propuesta sin tocar el snapshot anterior", async () => {
  const data = createMemoryAppData(NOW)
  const initial = await read(data, "empty")
  const started = await data.sendChat({ chatId: initial.chat.id, text: "Agrega una validación", runtime: "claude-sdk", model: "sonnet", effort: "medium" })
  expect(started).toMatchObject({ busy: true, runtime: "claude-sdk", model: "sonnet", effort: "medium" })
  expect(vi.getTimerCount()).toBe(0)
  const { controller } = await subscribe(data)
  await vi.advanceTimersByTimeAsync(2000)
  const partial = await read(data, "empty")
  expect(partial.messages.at(-1)).toMatchObject({ role: "assistant", text: "Estoy revisando el diff" })
  await vi.advanceTimersByTimeAsync(4000)
  const finished = await read(data, "empty")
  expect(finished.chat).toMatchObject({ busy: false, costMicros: 12_000 })
  expect(finished.proposal).toMatchObject({ status: "draft", rev: 1 })
  expect(initial.messages).toEqual([])
  expect(partial.chat.busy).toBe(true)
  expect(partial.messages.at(-1)?.text).toBe("Estoy revisando el diff")
  expect(started.busy).toBe(true)
  controller.abort()
})

test("pedir una explicación termina el turno sin crear propuesta", async () => {
  const data = createMemoryAppData(NOW)
  const { chat } = await read(data, "empty")
  await data.sendChat({ chatId: chat.id, text: "Explícame el PR sin modificar archivos" })
  const { controller } = await subscribe(data)
  await vi.advanceTimersByTimeAsync(6000)
  expect(await read(data, "empty")).toMatchObject({ chat: { busy: false }, proposal: null })
  controller.abort()
})

test("interrupt y reset detienen el turno y limpian mensajes y propuesta", async () => {
  const data = createMemoryAppData(NOW)
  const { chat } = await read(data, "streaming")
  const { controller } = await subscribe(data)
  expect(await data.interruptChat({ chatId: chat.id })).toMatchObject({ busy: false })
  const interrupted = await read(data, "streaming")
  expect(interrupted.messages.at(-1)).toMatchObject({ role: "system", text: expect.stringMatching(/interrumpida/) })
  await vi.advanceTimersByTimeAsync(6000)
  expect(await read(data, "streaming")).toEqual(interrupted)
  const draft = await read(data, "draft")
  expect(await data.resetChat({ chatId: draft.chat.id })).toMatchObject({ busy: false, costMicros: 0 })
  expect(await read(data, "draft")).toMatchObject({ messages: [], proposal: null })
  controller.abort()
})

test("chatProposal y discard validan la revisión y no mutan lecturas anteriores", async () => {
  const data = createMemoryAppData(NOW)
  const draft = await read(data, "draft")
  const input = { chatId: draft.chat.id, rev: draft.proposal!.rev }
  const diff = await data.chatProposal(input)
  expect(diff.patch).toContain("+    return if entries.none?")
  expect(diff.files).toEqual(draft.proposal!.files)
  diff.files[0]!.path = "mutated"
  expect((await data.chatProposal(input)).files[0]!.path).not.toBe("mutated")
  await expect(data.chatProposal({ ...input, rev: 2 })).rejects.toThrow(/propuesta cambió/)
  await data.discardProposal(input)
  expect((await read(data, "draft")).proposal?.status).toBe("discarded")
  expect(draft.proposal?.status).toBe("draft")
  await expect(data.applyProposal(input)).rejects.toThrow(/ya no/)
})

test("apply devuelve runId y el resultado de los hijos sin alterar las corridas de demo", async () => {
  const data = createMemoryAppData(NOW)
  const runs = await data.runs()
  const { chat } = await read(data, "applied")
  await data.sendChat({ chatId: chat.id, text: "Agrega la validación" })
  const { controller } = await subscribe(data)
  await vi.advanceTimersByTimeAsync(6000)
  const draft = await read(data, "applied")
  await expect(data.applyProposal({ chatId: chat.id, rev: 1 })).rejects.toThrow(/propuesta cambió/)
  const input = { chatId: chat.id, rev: draft.proposal!.rev }
  const { runId } = await data.applyProposal(input)
  expect(RunId.parse(runId)).toBe(runId)
  expect((await read(data, "applied")).proposal).toMatchObject({ status: "applying", runId })
  expect(await data.runs()).toEqual(runs)
  await expect(data.resetChat(input)).rejects.toThrow(/termine/)
  await expect(data.discardProposal(input)).rejects.toThrow(/termine/)
  await expect(data.sendChat({ chatId: chat.id, text: "otro" })).rejects.toThrow(/termine/)
  await vi.advanceTimersByTimeAsync(6000)
  const applied = await read(data, "applied")
  expect(applied.proposal).toMatchObject({ status: "applied", runId })
  expect(applied.proposal?.result?.children.map((child) => child.status)).toEqual(["restacked", "conflict"])
  expect(await data.runs()).toEqual(runs)
  expect(await data.openPrs()).toEqual(buildOpenPrs(NOW))
  controller.abort()
})

test("stale, login vencido y PR externo rechazan aplicar; el error no cambia configuración ni llama runtimes", async () => {
  const data = createMemoryAppData(NOW)
  for (const id of ["stale", "expired", "unowned"] as const) {
    const before = await read(data, id)
    await expect(data.applyProposal({ chatId: before.chat.id, rev: before.proposal!.rev })).rejects.toThrow()
    expect(await read(data, id)).toEqual(before)
  }
  const expired = await read(data, "expired")
  await expect(data.sendChat({ chatId: expired.chat.id, text: "Continuar", runtime: "claude-sdk", model: "opus" })).rejects.toThrow(expired.chat.applyReason)
  expect(await read(data, "expired")).toEqual(expired)
  const empty = await read(data, "empty")
  await expect(data.sendChat({ chatId: empty.chat.id, text: " " })).rejects.toThrow(/Escribe/)
  await expect(data.chat({ prId: "missing" })).rejects.toThrow(/No existe/)
  await expect(data.interruptChat({ chatId: "chat_00000000000000000000000999" })).rejects.toThrow(/No existe/)
})

test("los snapshots y las instancias están aislados", async () => {
  const data = createMemoryAppData(NOW)
  const other = createMemoryAppData(NOW)
  const draft = await read(data, "draft")
  draft.chat.model = "mutated"
  draft.messages[0]!.text = "mutated"
  draft.proposal!.items[0]!.change = "mutated"
  const fresh = await read(data, "draft")
  expect(fresh).toEqual(await read(other, "draft"))
  await data.discardProposal({ chatId: fresh.chat.id })
  expect((await read(other, "draft")).proposal?.status).toBe("draft")
})

test("reiniciar no reutiliza la revisión de una propuesta anterior", async () => {
  const data = createMemoryAppData(NOW)
  const before = await read(data, "draft")
  await data.resetChat({ chatId: before.chat.id })
  await data.sendChat({ chatId: before.chat.id, text: "Agrega la validación" })
  const { controller } = await subscribe(data)
  await vi.advanceTimersByTimeAsync(6000)
  expect((await read(data, "draft")).proposal?.rev).toBe(before.proposal!.rev + 1)
  await expect(data.applyProposal({ chatId: before.chat.id, rev: before.proposal!.rev })).rejects.toThrow(/propuesta cambió/)
  controller.abort()
})

test("los eventos tienen secuencia monotónica, ids y replay desde after", async () => {
  const data = createMemoryAppData(NOW)
  const { iterator, controller } = await subscribe(data)
  const { chat } = await read(data, "empty")
  await data.sendChat({ chatId: chat.id, text: "Agrega un test" })
  const first = (await iterator.next()).value!
  const second = (await iterator.next()).value!
  expect(Event.parse(first)).toMatchObject({ type: "chat.message", payload: { chatId: chat.id, prId: chat.prId } })
  expect(second).toMatchObject({ seq: first.seq + 1, type: "chat.turn_started" })
  first.payload.prId = "mutated"
  controller.abort()
  const replay = await subscribe(data, first.seq)
  expect((await replay.iterator.next()).value).toEqual(second)
  await vi.advanceTimersByTimeAsync(6000)
  let last = second.seq
  const events = []
  for (;;) {
    const event = (await replay.iterator.next()).value!
    expect(event.seq).toBeGreaterThan(last)
    last = event.seq
    events.push(event)
    if (event.type === "chat.turn_finished" && event.payload.chatId === chat.id) break
  }
  expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["chat.message", "chat.proposal", "chat.turn_finished", "chat.apply_finished"]))
  replay.controller.abort()
})

test("abort despierta next pendiente y limpia listeners y timers; reconectar retoma sin duplicar", async () => {
  const data = createMemoryAppData(NOW)
  const controller = new AbortController()
  const remove = vi.spyOn(controller.signal, "removeEventListener")
  expect(vi.getTimerCount()).toBe(0)
  const { iterator } = await subscribe(data, 0, controller)
  expect(vi.getTimerCount()).toBe(2)
  const pending = iterator.next()
  controller.abort()
  expect(await pending).toEqual({ done: true, value: undefined })
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function))
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(10_000)
  expect((await read(data, "streaming")).chat.busy).toBe(true)
  const next = await subscribe(data)
  expect(vi.getTimerCount()).toBe(2)
  await vi.advanceTimersByTimeAsync(6000)
  expect((await read(data, "streaming")).chat.busy).toBe(false)
  next.controller.abort()
  expect(vi.getTimerCount()).toBe(0)
})

test("una señal ya abortada termina sin registrar listeners ni crear timers", async () => {
  const data = createMemoryAppData(NOW)
  const controller = new AbortController()
  controller.abort()
  const add = vi.spyOn(controller.signal, "addEventListener")
  const { iterator } = await subscribe(data, 0, controller)
  expect(await iterator.next()).toEqual({ done: true, value: undefined })
  expect(add).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

test("return cierra el iterador incluso con next pendiente y no detiene otro suscriptor", async () => {
  const data = createMemoryAppData(NOW)
  const first = await subscribe(data)
  const second = await subscribe(data)
  const pending = first.iterator.next()
  await first.iterator.return!()
  expect(await pending).toEqual({ done: true, value: undefined })
  expect(vi.getTimerCount()).toBe(2)
  const waiting = second.iterator.next()
  await second.iterator.return!()
  expect(await waiting).toEqual({ done: true, value: undefined })
  expect(vi.getTimerCount()).toBe(0)
})
