import { createContext, type ReactNode, useCallback, useContext, useEffect, useEffectEvent, useRef, useState } from "react"
import { useEvents } from "@/hooks/use-events"

interface Live {
  /** Sube cada vez que llegan eventos del core: quien lo lea vuelve a pedir lo suyo. */
  revision: number
  connected: boolean
  /** Hace que todas las consultas vivas vuelvan a pedir sus datos ahora. */
  refresh: () => void
}

const LiveContext = createContext<Live>({ revision: 0, connected: false, refresh: () => {} })

// Agrupa los eventos que llegan juntos (el relleno inicial trae cientos) en un solo cambio de `revision`.
const COALESCE_MS = 120

export function LiveProvider({ children }: { children: ReactNode }) {
  const [revision, setRevision] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const connected = useEvents(() => {
    timer.current ??= setTimeout(() => {
      timer.current = undefined
      setRevision((r) => r + 1)
    }, COALESCE_MS)
  })
  useEffect(() => () => clearTimeout(timer.current), [])
  const refresh = useCallback(() => setRevision((r) => r + 1), [])
  return <LiveContext.Provider value={{ revision, connected, refresh }}>{children}</LiveContext.Provider>
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
      (e: unknown) => current && setState((s) => ({ key, data: s.key === key ? s.data : undefined, error: e instanceof Error ? e.message : String(e) })),
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
