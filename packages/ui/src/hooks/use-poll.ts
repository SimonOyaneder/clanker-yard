import { useCallback, useEffect, useRef, useState } from "react"
import type { Result } from "@/types"

// Pide datos al proceso main cada `ms` (más lento con la ventana oculta). `refresh` pide al tiro.
// `hiddenMs`: cada cuánto con la ventana oculta (por defecto 5 veces más lento).
export function usePoll<T>(fetcher: () => Promise<Result<T>>, deps: unknown[], ms = 2000, hiddenMs = ms * 5) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const tickRef = useRef<() => void>(() => {})

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    setData(null)
    setError(null)
    const tick = async () => {
      if (timer) clearTimeout(timer)
      try {
        const r = await fetcher()
        if (!alive) return
        if (r.ok) {
          setData(r.data)
          setError(null)
          setUpdatedAt(Date.now())
        } else {
          setError(r.error)
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      }
      if (alive) timer = setTimeout(tick, document.hidden ? hiddenMs : ms)
    }
    tickRef.current = () => void tick()
    void tick()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
    // `fetcher` cambia en cada render: quien llama decide con `deps` cuándo hay que volver a pedir.
  }, deps)

  const refresh = useCallback(() => tickRef.current(), [])
  return { data, error, updatedAt, refresh }
}
