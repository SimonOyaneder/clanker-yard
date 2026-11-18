import type { Event } from "@clanker/api"
import { describe, expect, test } from "vitest"
import { followEvents } from "./follow-events"

const event = (seq: number): Event => ({ seq, ts: 1_700_000_000_000 + seq, type: "run.started", origin: "core", payload: {} })
const LOG = [1, 2, 3, 4, 5, 6].map(event)

// Una conexión que entrega `events` y después se corta con `ending` ("throw") o termina limpio ("end");
// con "open" se queda abierta hasta que se aborta la señal, como un stream sin eventos nuevos.
function connection(events: Event[], ending: "throw" | "end" | "open", signal: AbortSignal): AsyncIterable<Event> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events
      if (ending === "throw") throw new Error("se cortó la conexión")
      if (ending === "open") await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
    },
  }
}

// Corre `followEvents` hasta recibir `count` eventos; devuelve lo recibido y los `after` con que se abrió.
async function run(opts: { count: number; open: (after: number, attempt: number, signal: AbortSignal) => Promise<AsyncIterable<Event>> }) {
  const received: number[] = []
  const opened: number[] = []
  const connections: boolean[] = []
  let done!: () => void
  const finished = new Promise<void>((resolve) => (done = resolve))

  const stop = followEvents({
    open: (after, signal) => {
      opened.push(after)
      return opts.open(after, opened.length - 1, signal)
    },
    onEvent: (e) => {
      received.push(e.seq)
      if (received.length === opts.count) done()
    },
    onConnection: (c) => connections.push(c),
    wait: async () => {},
  })
  await finished
  stop()
  return { received, opened, connections }
}

describe("followEvents", () => {
  test("sin after parte desde start (sin historial) y una caída retoma desde el último entregado", async () => {
    const opened: number[] = []
    const received: number[] = []
    let starts = 0
    let done!: () => void
    const finished = new Promise<void>((resolve) => (done = resolve))
    const stop = followEvents({
      start: async () => (starts++, 4),
      open: async (after, signal) => {
        opened.push(after)
        return opened.length === 1 ? connection([event(5)], "throw", signal) : connection(LOG.filter((e) => e.seq > after), "open", signal)
      },
      onEvent: (e) => {
        received.push(e.seq)
        if (received.length === 2) done()
      },
      wait: async () => {},
    })
    await finished
    stop()
    expect(opened).toEqual([4, 5])
    expect(received).toEqual([5, 6])
    expect(starts).toBe(1)
  })

  test("tras una caída retoma desde el último seq entregado: no pierde ni repite", async () => {
    const { received, opened } = await run({
      count: 6,
      open: async (after, attempt, signal) =>
        attempt === 0
          ? connection(LOG.slice(0, 3), "throw", signal)
          : connection(
              LOG.filter((e) => e.seq > after),
              "open",
              signal,
            ),
    })

    expect(received).toEqual([1, 2, 3, 4, 5, 6])
    expect(opened).toEqual([0, 3])
  })

  test("descarta los eventos repetidos si el stream reconectado vuelve a mandar los últimos", async () => {
    const { received } = await run({
      count: 6,
      open: async (_after, attempt, signal) =>
        attempt === 0 ? connection(LOG.slice(0, 4), "end", signal) : connection(LOG.slice(1), "open", signal),
    })

    expect(received).toEqual([1, 2, 3, 4, 5, 6])
  })

  test("sigue reconectando cuando el core no responde y avisa cuándo hay conexión", async () => {
    const { received, opened, connections } = await run({
      count: 2,
      open: async (_after, attempt, signal) => {
        if (attempt < 2) throw new Error("core caído")
        return connection(LOG.slice(0, 2), "open", signal)
      },
    })

    expect(received).toEqual([1, 2])
    expect(opened).toEqual([0, 0, 0])
    expect(connections).toEqual([false, false, true])
  })

  test("empieza después de `after` y deja de reconectar al parar", async () => {
    const opened: number[] = []
    const received: number[] = []
    let stop = () => {}
    const stopped = new Promise<void>((resolve) => {
      stop = followEvents({
        after: 4,
        open: async (after, signal) => {
          opened.push(after)
          return connection(
            LOG.filter((e) => e.seq > after),
            "end",
            signal,
          )
        },
        onEvent: (e) => received.push(e.seq),
        // El stream terminó y el cliente va a esperar para reconectar: ahí se para.
        wait: async () => {
          stop()
          resolve()
        },
      })
    })
    await stopped

    expect(received).toEqual([5, 6])
    expect(opened).toEqual([4])
  })
})
