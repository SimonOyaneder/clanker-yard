import type { Connection, GitHubDeviceFlow } from "@clanker/api"
import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { useAppData } from "@/app-data"
import { connectionSignature } from "@/hooks/use-linear-login"
import { useHost } from "@/host"

export interface GitHubDeviceLogin {
  /** El código para escribir en github.com mientras se espera la aprobación. */
  pending: GitHubDeviceFlow | null
  error: string | null
  /** Pide el código al core y abre github.com/login/device; la cuenta aparece sola por `connection.changed`. */
  start(): Promise<void>
  /** Deja de mostrar el código. El core no se entera: sigue sondeando hasta que el código venza o se inicie otro flujo. */
  dismiss(): void
}

// El device flow es de dos tiempos: el core devuelve el código y la aprobación llega después, desde github.com.
// Se da por terminado cuando la conexión cambia respecto de como estaba al empezar, o se rinde al vencer el código.
export function useGitHubDeviceFlow(connection: Connection | undefined, onChanged: () => void): GitHubDeviceLogin {
  const appData = useAppData()
  const host = useHost()
  const [pending, setPending] = useState<{ flow: GitHubDeviceFlow; before: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const start = useCallback(async () => {
    setError(null)
    try {
      const flow = await appData.startGithubDeviceFlow()
      host.openExternal(flow.verificationUri)
      setPending({ flow, before: connectionSignature(connection) })
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
      toast.success(`GitHub conectado como @${connection?.account} con la GitHub App`)
      return
    }
    const timer = setTimeout(
      () => {
        setPending(null)
        setError("El código venció o se canceló en GitHub. Vuelve a pulsar Conectar con la GitHub App.")
      },
      pending.flow.expiresIn * 1000,
    )
    return () => clearTimeout(timer)
  }, [pending, done, connection])

  const dismiss = useCallback(() => setPending(null), [])

  return { pending: pending && pending.flow, error, start, dismiss }
}
