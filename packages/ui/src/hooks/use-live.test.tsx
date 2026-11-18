// @vitest-environment jsdom
import type { Event, EventType } from "@clanker/api"
import { act, renderHook } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, test, vi } from "vitest"
import { type AppData, AppDataProvider } from "@/app-data"
import { createMemoryAppData } from "@/demo/memory-app-data"
import { LiveProvider, useLiveQuery } from "./use-live"

const WAIT = { timeout: 3000 }

// Un stream de eventos que la prueba alimenta a mano.
function liveEvents() {
  const queue: Event[] = []
  let wake: (() => void) | undefined
  let seq = 0
  return {
    push(type: EventType) {
      queue.push({ seq: ++seq, ts: 0, type, origin: "core", payload: {} })
      wake?.()
    },
    events: async (_after: number, signal: AbortSignal): Promise<AsyncIterable<Event>> => ({
      async *[Symbol.asyncIterator]() {
        while (!signal.aborted) {
          const next = queue.shift()
          if (next) yield next
          else await new Promise<void>((resolve) => ((wake = resolve), signal.addEventListener("abort", () => resolve(), { once: true })))
        }
      },
    }),
  }
}

function setup() {
  const stream = liveEvents()
  const appData: AppData = { ...createMemoryAppData(0), events: stream.events }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AppDataProvider value={appData}>
      <LiveProvider>{children}</LiveProvider>
    </AppDataProvider>
  )
  return { stream, wrapper }
}

describe("useLiveQuery", () => {
  test("solo se relee con los eventos de `on`, y lo que vuelve igual conserva su identidad", async () => {
    const { stream, wrapper } = setup()
    let calls = 0
    const { result } = renderHook(() => useLiveQuery("prs", async () => (calls++, [{ id: "a" }]), { on: ["pr.*"] }), { wrapper })
    // Montar y conectar: el primer pedido y el de la conexión.
    await vi.waitFor(() => expect(calls).toBe(2), WAIT)
    const first = result.current.data

    stream.push("agent.activity")
    stream.push("step.started")
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(calls).toBe(2)

    stream.push("pr.changed")
    await vi.waitFor(() => expect(calls).toBe(3), WAIT)
    expect(result.current.data).toBe(first)
  })

  test("nunca hay dos pedidos a la vez: lo que llega en vuelo se pide una vez al terminar", async () => {
    const { wrapper } = setup()
    let calls = 0
    let inFlight = 0
    let maxInFlight = 0
    const pending: (() => void)[] = []
    const fetcher = () => {
      calls++
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      return new Promise<number>((resolve) => pending.push(() => (inFlight--, resolve(calls))))
    }
    const { result } = renderHook(() => useLiveQuery("x", fetcher, { live: false }), { wrapper })
    await vi.waitFor(() => expect(calls).toBe(1), WAIT)

    act(() => {
      result.current.reload()
      result.current.reload()
      result.current.reload()
    })
    expect(calls).toBe(1)

    await act(async () => pending.shift()!())
    await vi.waitFor(() => expect(calls).toBe(2), WAIT)
    await act(async () => pending.shift()!())
    await vi.waitFor(() => expect(result.current.data).toBe(2), WAIT)
    expect(calls).toBe(2)
    expect(maxInFlight).toBe(1)
  })
})
