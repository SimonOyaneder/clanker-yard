import { ClaudeStatus, type ClaudeMode, type Connection } from "@clanker/api"
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react"
import { useAppData } from "@/app-data"
import { readPref, writePref } from "@/lib/prefs"
import { messageOf } from "@/lib/utils"

/** Cada cuánto se repite la llamada mínima que lee el uso del plan: gasta un poco de cuota, así que va espaciada. */
export const PLAN_REFRESH_MS = 10 * 60_000

export interface ClaudePlan {
  /** Lo que dijo la última prueba; `null` si nunca se probó. */
  status: ClaudeStatus | null
  /** ms epoch de esa prueba. */
  at: number | null
  testing: boolean
  /** Por qué falló la última llamada al core (no el estado de Claude, que va en `status`). */
  error: string | null
  /** Prueba Claude y deja el resultado para el pie de la barra lateral y la tarjeta. `null` si la llamada falló. */
  test(mode?: ClaudeMode): Promise<ClaudeStatus | null>
  /** Olvida la última prueba (al desconectar Claude). */
  clear(): void
}

const stored = (): { status: ClaudeStatus; at: number } | null => {
  const raw = readPref<{ status?: unknown; at?: unknown } | null>("claudePlan", null)
  const status = ClaudeStatus.safeParse(raw?.status)
  return status.success && typeof raw?.at === "number" ? { status: status.data, at: raw.at } : null
}

// La última prueba de Claude, compartida entre la tarjeta de Conexiones y el pie de la barra lateral. Con
// Claude conectado la repite sola cada `PLAN_REFRESH_MS` para que la barra de uso no se quede vieja; un
// intento fallido también espera ese plazo. `onChanged` relee las conexiones, que una prueba concluyente cambia.
export function useClaudePlan(connections: Connection[] | undefined, onChanged: () => void): ClaudePlan {
  const appData = useAppData()
  const [last, setLast] = useState(stored)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastTry = useRef(0)
  const busy = useRef(false)

  const test = useCallback(
    async (mode?: ClaudeMode) => {
      if (busy.current) return null
      busy.current = true
      lastTry.current = Date.now()
      setTesting(true)
      setError(null)
      try {
        const status = await appData.testClaude(mode)
        const next = { status, at: Date.now() }
        setLast(next)
        writePref("claudePlan", next)
        onChanged()
        return status
      } catch (e) {
        setError(messageOf(e))
        return null
      } finally {
        busy.current = false
        setTesting(false)
      }
    },
    [appData, onChanged],
  )

  const clear = useCallback(() => {
    setLast(null)
    writePref("claudePlan", null)
  }, [])

  const active = connections?.some((c) => c.provider === "claude" && c.status === "active") ?? false
  const refreshIfStale = useEffectEvent(() => {
    if (active && Date.now() - Math.max(last?.at ?? 0, lastTry.current) >= PLAN_REFRESH_MS) void test()
  })
  useEffect(() => {
    refreshIfStale()
    const timer = setInterval(refreshIfStale, 60_000)
    return () => clearInterval(timer)
  }, [active])

  return { status: last?.status ?? null, at: last?.at ?? null, testing, error, test, clear }
}
