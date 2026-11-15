import type { Connection } from "@clanker/api"
import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { useAppData } from "@/app-data"
import { useHost } from "@/host"

/** El core deja de esperar la aprobación a los 5 minutos (`LINEAR_LOGIN_TIMEOUT_MS`). */
const LOGIN_WAIT_MS = 5 * 60_000

/** Lo que cambia cuando el login termina: la cuenta nueva, o la misma con otro vencimiento. */
export const connectionSignature = (c: Connection | undefined) => (c ? `${c.account}:${c.status}:${c.expiresAt ?? ""}` : "")

export interface LinearLogin {
  /** El link con que se inició el login, mientras se espera la aprobación. */
  pending: { url: string } | null
  error: string | null
  /** Pide el link al core y lo abre en el navegador; la cuenta aparece sola por `connection.changed`. */
  start(): Promise<void>
}

// El login de Linear es de dos tiempos: el core devuelve el link y la aprobación llega después, desde el
// navegador. Se da por terminado cuando la conexión cambia respecto de como estaba al empezar.
export function useLinearLogin(connection: Connection | undefined, onChanged: () => void): LinearLogin {
  const appData = useAppData()
  const host = useHost()
  const [pending, setPending] = useState<{ url: string; before: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const start = useCallback(async () => {
    setError(null)
    try {
      const url = await appData.linearAuth()
      host.openExternal(url)
      setPending({ url, before: connectionSignature(connection) })
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [appData, host, connection, onChanged])

  const done = pending !== null && connectionSignature(connection) !== pending.before
  useEffect(() => {
    if (!pending) return
    if (done) {
      setPending(null)
      toast.success(`Linear conectado${connection ? ` a ${connection.account}` : ""}`)
      return
    }
    const timer = setTimeout(() => {
      setPending(null)
      setError("Venció el plazo para aprobar en el navegador. Vuelve a pulsar Conectar con Linear.")
    }, LOGIN_WAIT_MS)
    return () => clearTimeout(timer)
  }, [pending, done, connection])

  return { pending: pending && { url: pending.url }, error, start }
}
