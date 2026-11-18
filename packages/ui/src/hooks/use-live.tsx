import type { Event } from "@clanker/api"
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { useEvents } from "@/hooks/use-events"
import type { LiveTrigger } from "@/lib/live-triggers"
import { replaceEqualDeep } from "@/lib/replace-equal-deep"
import { messageOf } from "@/lib/utils"

export type { LiveTrigger }

/** Los tipos de una tanda de eventos, o `null` cuando todo se relee (al conectar o con `refresh`). */
type Batch = ReadonlySet<string> | null

interface Live {
  connected: boolean
  /** Hace que todas las consultas vivas vuelvan a pedir sus datos ahora. */
  refresh: () => void
  /** Recibe cada evento que llega desde ahora (no el relleno de antes de suscribirse). Devuelve cómo dejar de recibir. */
  subscribe: (listener: (event: Event) => void) => () => void
  /** Recibe cada tanda de eventos agrupada. Devuelve cómo dejar de recibir. */
  onBatch: (listener: (batch: Batch) => void) => () => void
}

const noop = () => () => {}
const LiveContext = createContext<Live>({ connected: false, refresh: () => {}, subscribe: noop, onBatch: noop })

// Agrupa los eventos que llegan juntos en una sola tanda.
const COALESCE_MS = 120

export function LiveProvider({ children }: { children: ReactNode }) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const pending = useRef(new Set<string>())
  const listeners = useRef(new Set<(event: Event) => void>())
  const batchListeners = useRef(new Set<(batch: Batch) => void>())
  const emit = useCallback((batch: Batch) => {
    for (const listener of batchListeners.current) listener(batch)
  }, [])
  const connected = useEvents((event) => {
    for (const listener of listeners.current) listener(event)
    // La salida de una prueba de receta es un log, no un cambio de lo que muestran las consultas: sin esto
    // cada línea haría releer todo.
    if (event.type === "recipe.test_output") return
    pending.current.add(event.type)
    timer.current ??= setTimeout(() => {
      timer.current = undefined
      const batch = pending.current
      pending.current = new Set()
      emit(batch)
    }, COALESCE_MS)
  })
  useEffect(() => () => clearTimeout(timer.current), [])
  // Al conectar (y al volver tras una caída) todo se relee: lo que se pidió con el core caído o
  // levantándose quedó en error, y si no llegan eventos nuevos nada más lo vuelve a pedir.
  useEffect(() => {
    if (connected) emit(null)
  }, [connected, emit])
  const refresh = useCallback(() => emit(null), [emit])
  const subscribe = useCallback((listener: (event: Event) => void) => {
    listeners.current.add(listener)
    return () => void listeners.current.delete(listener)
  }, [])
  const onBatch = useCallback((listener: (batch: Batch) => void) => {
    batchListeners.current.add(listener)
    return () => void batchListeners.current.delete(listener)
  }, [])
  // Estable salvo cuando cambia la conexión: quien solo usa `refresh` o `subscribe` no se re-renderiza con cada evento.
  const value = useMemo(() => ({ connected, refresh, subscribe, onBatch }), [connected, refresh, subscribe, onBatch])
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>
}

export const useLive = () => useContext(LiveContext)

const touches = (batch: Batch, on: readonly string[] | undefined) =>
  batch === null || on === undefined || on.some((t) => (t.endsWith(".*") ? [...batch].some((type) => type.startsWith(t.slice(0, -1))) : batch.has(t)))

/**
 * Un contador que sube con cada tanda de eventos que toca `on` (o con todas, sin `on`): sirve de dependencia de un
 * efecto que debe repetirse en vivo. `enabled: false` lo deja quieto.
 */
export function useLiveTick(on?: readonly LiveTrigger[], enabled = true): number {
  const { onBatch } = useLive()
  const [tick, setTick] = useState(0)
  const onKey = on?.join(" ")
  useEffect(() => {
    if (!enabled) return
    const triggers = onKey?.split(" ")
    return onBatch((batch) => {
      if (touches(batch, triggers)) setTick((n) => n + 1)
    })
  }, [enabled, onKey, onBatch])
  return tick
}

interface LiveQueryOptions {
  /** Con `false` solo se repite al cambiar `key` o al llamar `reload` (lo que el core no anuncia por eventos). */
  live?: boolean
  /** Los eventos que cambian lo que trae: solo esos la releen. Sin él, cualquier evento. */
  on?: readonly LiveTrigger[]
}

// Una consulta al core que se repite sola cuando llegan eventos. `key` dice qué se pide: al cambiar,
// los datos anteriores dejan de mostrarse. Mientras recarga conserva lo último que llegó.
// Nunca hay dos pedidos de la misma `key` a la vez: lo que llega mientras uno está en vuelo se pide una vez al terminar.
// Lo que vuelve igual conserva la identidad de lo anterior (`replaceEqualDeep`): un refresco sin cambios no invalida memos.
export function useLiveQuery<T>(key: string, fetcher: () => Promise<T>, opts: LiveQueryOptions = {}) {
  const tick = useLiveTick(opts.on, opts.live !== false)
  const [reloads, setReloads] = useState(0)
  const [state, setState] = useState<{ key: string; data?: T; error?: string }>({ key })
  const fetcherRef = useRef(fetcher)
  useEffect(() => {
    fetcherRef.current = fetcher
  })
  // `gen` invalida lo que esté en vuelo al cambiar `key` o desmontar.
  const flight = useRef({ gen: 0, running: false, again: false })

  const start = useCallback((forKey: string) => {
    const f = flight.current
    if (f.running) {
      f.again = true
      return
    }
    f.running = true
    const gen = f.gen
    fetcherRef
      .current()
      .then(
        (data) => {
          if (f.gen === gen) setState((s) => ({ key: forKey, data: s.key === forKey ? replaceEqualDeep(s.data, data) : data }))
        },
        (e: unknown) => {
          if (f.gen === gen) setState((s) => ({ key: forKey, data: s.key === forKey ? s.data : undefined, error: messageOf(e) }))
        },
      )
      .finally(() => {
        if (f.gen !== gen) return
        f.running = false
        if (f.again) {
          f.again = false
          start(forKey)
        }
      })
  }, [])

  useEffect(() => {
    const f = flight.current
    f.gen++
    f.running = false
    f.again = false
    start(key)
    return () => {
      f.gen++
    }
  }, [key, start])

  // Solo cuando sube un disparador: el primer pedido lo hace el efecto de `key` (y en StrictMode este efecto corre dos veces).
  const seen = useRef({ tick, reloads })
  useEffect(() => {
    if (seen.current.tick === tick && seen.current.reloads === reloads) return
    seen.current = { tick, reloads }
    start(key)
    // Solo los disparadores: `key` lo cubre el efecto de arriba.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, reloads])

  const reload = useCallback(() => setReloads((n) => n + 1), [])
  const mine = state.key === key
  return {
    data: mine ? state.data : undefined,
    error: mine ? (state.error ?? null) : null,
    reload,
  }
}
