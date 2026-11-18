import type { CodexStatus, Connection } from "@clanker/api"
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react"
import { useAppData } from "@/app-data"
import { useLiveQuery } from "@/hooks/use-live"
import { messageOf } from "@/lib/utils"

/** Cada cuánto se vuelve a leer el uso de Codex: leerlo no gasta cuota (no llama al modelo), así que va seguido. */
export const CODEX_REFRESH_MS = 2 * 60_000

export interface CodexPlan {
  /** Lo último que el core sabe de Codex (`connections.codexStatus`); `null` si nunca se probó o si Codex no está conectado. */
  status: CodexStatus | null
  /** ms epoch en que la UI leyó ese dato fresco (una prueba o un `connection.usage`); `null` si solo hay lo que el core guardaba al abrir. */
  at: number | null
  /** `true` si hay una cuenta `codex`, en cualquier estado. */
  connected: boolean
  testing: boolean
  /** Por qué falló la última llamada al core (no el estado de Codex, que va en `status`). */
  error: string | null
  /** Prueba Codex (conecta la cuenta si responde) y deja el resultado para la tarjeta y la barra lateral. `null` si la llamada falló. */
  test(): Promise<CodexStatus | null>
}

// El estado de Codex, compartido entre la tarjeta de Conexiones y la barra lateral. Lo que trae una corrida llega con
// `connection.usage` y se relee sin lanzar nada; con Codex conectado además se prueba al montar y cada `CODEX_REFRESH_MS`.
// `onChanged` relee las conexiones, que una prueba concluyente cambia.
export function useCodexPlan(connections: Connection[] | undefined, onChanged: () => void): CodexPlan {
  const appData = useAppData()
  // La primera lectura es lo que el core guardaba (sin hora: puede ser de hace horas); cada una después viene de un
  // `connection.usage` y es dato fresco.
  const reads = useRef(0)
  const stored = useLiveQuery(
    "codexStatus",
    async () => {
      const status = await appData.codexStatus()
      return { status, at: reads.current++ === 0 ? null : Date.now() }
    },
    { on: ["connection.usage"] },
  )
  const [tested, setTested] = useState<{ status: CodexStatus; at: number } | null>(null)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastTry = useRef(0)
  const busy = useRef(false)

  const test = useCallback(async () => {
    if (busy.current) return null
    busy.current = true
    lastTry.current = Date.now()
    setTesting(true)
    setError(null)
    try {
      const status = await appData.testCodex()
      setTested({ status, at: Date.now() })
      onChanged()
      return status
    } catch (e) {
      setError(messageOf(e))
      return null
    } finally {
      busy.current = false
      setTesting(false)
    }
  }, [appData, onChanged])

  const account = connections?.find((c) => c.provider === "codex")
  const active = account?.status === "active"
  const refreshIfDue = useEffectEvent(() => {
    if (active && Date.now() - lastTry.current >= CODEX_REFRESH_MS) void test()
  })
  useEffect(() => {
    refreshIfDue()
    const timer = setInterval(refreshIfDue, 30_000)
    return () => clearInterval(timer)
  }, [active])

  // Gana lo más nuevo entre la última prueba y la última lectura del core.
  const fromCore = stored.data?.status ? { status: stored.data.status, at: stored.data.at } : null
  const latest = tested && (fromCore?.at == null || tested.at >= fromCore.at) ? tested : fromCore
  const status = account ? (latest?.status ?? null) : null
  return { status, at: account ? (latest?.at ?? null) : null, connected: account !== undefined, testing, error, test }
}
