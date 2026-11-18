import type { Event } from "@clanker/api"

export interface FollowEvents {
  /** Abre el stream con los eventos de `seq > after`. */
  open(after: number, signal: AbortSignal): Promise<AsyncIterable<Event>>
  /** Cada evento una vez, en orden de `seq`. No debe lanzar. */
  onEvent(event: Event): void
  /** `true` cuando hay un stream abierto, `false` cuando se cayó y espera para reconectar. */
  onConnection?(connected: boolean): void
  /** Desde dónde seguir. Sin él se lee con `start` al conectar por primera vez (y si no, 0: todo el historial). */
  after?: number
  /** El `seq` desde el que seguir cuando no hay `after`; se reintenta como una conexión fallida. */
  start?(signal: AbortSignal): Promise<number>
  /** Espera antes de reconectar tras `failures` intentos seguidos sin conectar; debe resolver al abortarse `signal`. */
  wait?(failures: number, signal: AbortSignal): Promise<void>
}

const backoff = (failures: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.min(500 * 2 ** failures, 10_000))
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true })
  })

/**
 * Sigue los eventos del core y se reconecta solo. Cada reconexión retoma desde el último `seq` entregado
 * y descarta lo que no sea posterior, así que una caída ni pierde ni repite eventos. Devuelve cómo parar.
 */
export function followEvents(opts: FollowEvents): () => void {
  const abort = new AbortController()
  const { signal } = abort
  const wait = opts.wait ?? backoff
  let last = opts.after

  void (async () => {
    let failures = 0
    while (!signal.aborted) {
      try {
        last ??= opts.start ? await opts.start(signal) : 0
        const stream = await opts.open(last, signal)
        opts.onConnection?.(true)
        failures = 0
        for await (const event of stream) {
          if (signal.aborted) break
          if (event.seq <= last) continue
          last = event.seq
          opts.onEvent(event)
        }
      } catch {
        // Cualquier corte (red, core reiniciando, error del stream) se reintenta; el motivo no cambia qué hacer.
      }
      if (signal.aborted) break
      opts.onConnection?.(false)
      await wait(failures++, signal)
    }
  })()

  return () => abort.abort()
}
