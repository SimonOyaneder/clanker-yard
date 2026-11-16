import { type Connection, type GitHubDeviceFlow, LoginFailure } from "@clanker/api"
import { useCallback, useEffect, useEffectEvent, useState } from "react"
import { toast } from "sonner"
import { useAppData } from "@/app-data"
import { useLive } from "@/hooks/use-live"
import { connectionSignature } from "@/hooks/use-linear-login"
import { useHost } from "@/host"
import { copy } from "@/lib/clipboard"
import { messageOf } from "@/lib/utils"

export interface GitHubDeviceLogin {
  /** El código para escribir en github.com mientras se espera la aprobación, con el momento (ms de esta ventana) en que vence. */
  pending: (GitHubDeviceFlow & { expiresAt: number }) | null
  /** Por qué no se conectó: el core avisa (`connection.login_failed`) apenas GitHub rechaza, sin esperar a que venza el código. */
  failure: { reason: LoginFailure; message: string } | null
  /** Pide el código al core, lo copia y abre github.com/login/device; la cuenta aparece sola por `connection.changed`. */
  start(): Promise<void>
  /** Copia el código y abre github.com otra vez. */
  open(): void
  /** Deja de mostrar el código. El core no se entera: sigue sondeando hasta que el código venza o se inicie otro flujo. */
  dismiss(): void
}

// El device flow es de dos tiempos: el core devuelve el código y la aprobación llega después, desde github.com.
// Termina cuando la conexión cambia respecto de como estaba al empezar, cuando el core avisa que GitHub lo
// rechazó (cancelado, vencido) o, si ese aviso se perdió, cuando se cumple el plazo del código.
export function useGitHubDeviceFlow(connection: Connection | undefined, onChanged: () => void): GitHubDeviceLogin {
  const appData = useAppData()
  const host = useHost()
  const { subscribe } = useLive()
  const [pending, setPending] = useState<{ flow: GitHubDeviceFlow; expiresAt: number; before: string } | null>(null)
  const [failure, setFailure] = useState<GitHubDeviceLogin["failure"]>(null)

  const openGitHub = useCallback(
    (flow: GitHubDeviceFlow) => {
      copy(flow.userCode, "el código de GitHub")
      host.openExternal(flow.verificationUri)
    },
    [host],
  )

  const start = useCallback(async () => {
    setFailure(null)
    try {
      const flow = await appData.startGithubDeviceFlow()
      openGitHub(flow)
      setPending({ flow, expiresAt: Date.now() + flow.expiresIn * 1000, before: connectionSignature(connection) })
      onChanged()
    } catch (e) {
      setFailure({ reason: "failed", message: messageOf(e) })
    }
  }, [appData, openGitHub, connection, onChanged])

  const rejected = useEffectEvent((payload: Record<string, unknown>) => {
    if (!pending || payload.provider !== "github") return
    setPending(null)
    setFailure({ reason: LoginFailure.catch("failed").parse(payload.reason), message: String(payload.message) })
  })
  useEffect(() => subscribe((event) => event.type === "connection.login_failed" && rejected(event.payload)), [subscribe])

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
        setFailure({ reason: "expired", message: "El código venció sin que lo aprobaras. Vuelve a pulsar Conectar con la GitHub App." })
      },
      Math.max(0, pending.expiresAt - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [pending, done, connection])

  const dismiss = useCallback(() => setPending(null), [])

  return { pending: pending && { ...pending.flow, expiresAt: pending.expiresAt }, failure, start, open: () => pending && openGitHub(pending.flow), dismiss }
}
