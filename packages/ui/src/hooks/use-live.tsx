import type { Event } from "@clanker/api"
import { createContext, type ReactNode, useCallback, useContext, useEffect, useEffectEvent, useRef, useState } from "react"
import { useEvents } from "@/hooks/use-events"
import { messageOf } from "@/lib/utils"

interface Live {
  /** Sube cada vez que llegan eventos del core: quien lo lea vuelve a pedir lo suyo. */
  revision: number
  connected: boolean
  /** Hace que todas las consultas vivas vuelvan a pedir sus datos ahora. */
  refresh: () => void
  /** Recibe cada evento que llega desde ahora (no el relleno de antes de suscribirse). Devuelve cómo dejar de recibir. */
  subscribe: (listener: (event: Event) => void) => () => void
}

const LiveContext = createContext<Live>({ revision: 0, connected: false, refresh: () => {}, subscribe: () => () => {} })

// Agrupa los eventos que llegan juntos (el relleno inicial trae cientos) en un solo cambio de `revision`.
const COALESCE_MS = 120

export function LiveProvider({ children }: { children: ReactNode }) {
  const [revision, setRevision] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const listeners = useRef(new Set<(event: Event) => void>())
  const connected = useEvents((event) => {
    for (const listener of listeners.current) listener(event)
    // La salida de una prueba de receta es un log, no un cambio de lo que muestran las consultas: sin esto
    // cada línea haría releer todo.
    if (event.type === "recipe.test_output") return
    timer.current ??= setTimeout(() => {
      timer.current = undefined
      setRevision((r) => r + 1)
    }, COALESCE_MS)
  })
  useEffect(() => () => clearTimeout(timer.current), [])
  // Al conectar (y al volver tras una caída) todo se relee: lo que se pidió con el core caído o
  // levantándose quedó en error, y si no llegan eventos nuevos nada más lo vuelve a pedir.
  useEffect(() => {
    if (connected) setRevision((r) => r + 1)
  }, [connected])
  const refresh = useCallback(() => setRevision((r) => r + 1), [])
  const subscribe = useCallback((listener: (event: Event) => void) => {
    listeners.current.add(listener)
    return () => void listeners.current.delete(listener)
  }, [])
  return <LiveContext.Provider value={{ revision, connected, refresh, subscribe }}>{children}</LiveContext.Provider>
}

export const useLive = () => useContext(LiveContext)

// Una consulta al core que se repite sola cuando llegan eventos. `key` dice qué se pide: al cambiar,
// los datos anteriores dejan de mostrarse. Mientras recarga conserva lo último que llegó.
// Con `live: false` solo se repite al cambiar `key` o al llamar `reload` (lo que el core no anuncia por eventos).
export function useLiveQuery<T>(key: string, fetcher: () => Promise<T>, opts: { live?: boolean } = {}) {
  const { revision } = useLive()
  const watched = opts.live === false ? 0 : revision
  const [reloads, setReloads] = useState(0)
  const [state, setState] = useState<{ key: string; data?: T; error?: string }>({ key })
  const load = useEffectEvent(fetcher)

  useEffect(() => {
    let current = true
    load().then(
      (data) => current && setState({ key, data }),
      (e: unknown) => current && setState((s) => ({ key, data: s.key === key ? s.data : undefined, error: messageOf(e) })),
    )
    return () => {
      current = false
    }
  }, [key, watched, reloads])

  const reload = useCallback(() => setReloads((n) => n + 1), [])
  const mine = state.key === key
  return {
    data: mine ? state.data : undefined,
    error: mine ? (state.error ?? null) : null,
    reload,
  }
}
