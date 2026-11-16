import type { Connection } from "@clanker/api"
import { AlertTriangle, Check, Copy, ExternalLink, GitBranch, KeyRound, Loader2, RefreshCw, Unplug, X } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { useAppData } from "@/app-data"
import { Pill } from "@/components/common"
import { ConfirmDisconnect, ConnectionCard } from "@/components/connections/connection-card"
import { TokenField } from "@/components/connections/token-field"
import { Button } from "@/components/ui/button"
import { useGitHubDeviceFlow } from "@/hooks/use-github-device-flow"
import { useLiveQuery } from "@/hooks/use-live"
import { connectionSignature } from "@/hooks/use-linear-login"
import { useNow } from "@/hooks/use-now"
import { useHost } from "@/host"
import { copy } from "@/lib/clipboard"
import { codeCountdown, expiryLabel, statusLook } from "@/lib/connections"
import { tone } from "@/lib/format"
import { cn } from "@/lib/utils"

// GitHub entra por la GitHub App (device flow: el core da un código y la cuenta aparece sola al aprobarlo en
// github.com) o con un PAT classic con `repo`: se pega y [Probar] lo valida contra GitHub (usuario, scope y una lectura por permiso).
export function GitHubCard({ connection, onChanged }: { connection: Connection | undefined; onChanged: () => void }) {
  const appData = useAppData()
  const host = useHost()
  const login = useGitHubDeviceFlow(connection, onChanged)
  const form = useLiveQuery("github-pat-form", () => appData.githubPatForm(), { live: false })
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const active = connection?.status === "active"
  const viaApp = connection?.auth === "app"
  // Sin instalar, la App conecta pero ningún repo es visible. Se pide una vez por conexión (no por evento: es una llamada a GitHub);
  // quien vuelve de instalarla la repite al volver a la ventana o con el botón.
  const installations = useLiveQuery(
    `github-installations:${connectionSignature(connection)}`,
    async () => (active && viaApp ? appData.githubInstallations() : null),
    { live: false },
  )
  const notInstalled = installations.data?.count === 0
  useEffect(() => {
    if (!notInstalled) return
    window.addEventListener("focus", installations.reload)
    return () => window.removeEventListener("focus", installations.reload)
  }, [notInstalled, installations.reload])
  const now = useNow(login.pending !== null)
  const showField = !login.pending && (!active || editing)
  const expiry = expiryLabel(connection)
  const createToken = () => form.data && host.openExternal(form.data.url)

  const probe = async (token: string) => {
    const connected = await appData.setGithubPat(token)
    setEditing(false)
    onChanged()
    toast.success(`GitHub conectado como @${connected.account}`)
  }
  const disconnect = async () => {
    if (!connection) return
    try {
      await appData.disconnect("github", connection.account)
      onChanged()
      toast.success("GitHub desconectado")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <>
      <ConnectionCard
        icon={<GitBranch className="size-4" />}
        title="GitHub"
        account={connection ? `@${connection.account}` : undefined}
        status={statusLook(connection)}
        chips={
          <>
            {connection ? (
              <Pill
                className={tone.neutral}
                hint={
                  viaApp
                    ? "Los agentes publican con la GitHub App: el token dura 8 horas y el core lo renueva solo. Para volver a un token personal, pega uno desde el menú."
                    : "Los agentes publican con un PAT classic que pegaste. Para cambiar a la GitHub App, pulsa Cambiar a la GitHub App: reemplaza este token."
                }
              >
                {viaApp ? "GitHub App" : "Token personal"}
              </Pill>
            ) : null}
            {expiry ? (
              <Pill
                className={connection?.status !== "active" ? tone.red : connection.expiresSoon ? tone.amber : tone.neutral}
                hint={viaApp ? "El refresh token de la GitHub App dura 6 meses y el core lo renueva solo con cada uso; si vence hay que volver a conectar." : "Un PAT classic vence en la fecha que elegiste al crearlo (si no lo hace, este aviso no aparece); hay que rotarlo a mano."}
              >
                {expiry}
              </Pill>
            ) : null}
          </>
        }
        primary={
          <>
            {active && !viaApp && !editing && !login.pending ? (
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                {connection?.expiresSoon ? "Rotar token" : "Reconectar"}
              </Button>
            ) : null}
            <Button size="sm" variant={active ? "outline" : "default"} disabled={login.pending !== null} onClick={() => void login.start()}>
              {login.pending ? <Loader2 className="animate-spin" /> : null}
              {viaApp ? "Reconectar" : active ? "Cambiar a la GitHub App" : "Conectar con la GitHub App"}
            </Button>
          </>
        }
        menu={[
          { label: "Crear token con los permisos marcados", icon: <ExternalLink />, onSelect: createToken, disabled: !form.data },
          { label: viaApp ? "Cambiar a un token personal" : "Pegar un token nuevo", icon: <KeyRound />, onSelect: () => setEditing(true), disabled: !connection },
          { label: "Copiar cuenta", icon: <Copy />, onSelect: () => connection && copy(connection.account, "la cuenta de GitHub"), disabled: !connection },
          { label: "Desconectar", icon: <Unplug />, onSelect: () => setConfirming(true), destructive: true, disabled: !connection },
        ]}
      >
        {login.pending ? (
          <div className="flex flex-col gap-2">
            <p>
              Escribe este código en <span className="font-mono text-foreground">{login.pending.verificationUri}</span> y aprueba la GitHub App. Al aprobar, la cuenta aparece acá sola.
            </p>
            <p className="font-mono text-4xl font-semibold tracking-widest" aria-label="Código de GitHub">
              {login.pending.userCode}
            </p>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
              <Loader2 className="size-3 animate-spin" /> Esperando la aprobación en GitHub · el código vence en {codeCountdown(login.pending.expiresAt, now)}
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={login.open}>
                <Copy /> Copiar y abrir GitHub
              </Button>
              <Button size="sm" variant="ghost" onClick={login.dismiss}>
                Cancelar
              </Button>
            </div>
          </div>
        ) : viaApp && connection ? (
          <div className="flex flex-col gap-2">
            <p className={connection.status === "active" ? "text-muted-foreground" : "text-destructive"}>{appStatusText(connection)}</p>
            {notInstalled ? (
              <div role="alert" className="flex flex-col gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5">
                <p className="flex items-center gap-1.5 font-medium text-amber-800 dark:text-amber-300">
                  <AlertTriangle className="size-3.5" /> La GitHub App no está instalada
                </p>
                <p className="text-muted-foreground">
                  La cuenta conectó, pero sin instalar la App el token no ve ningún repo y las listas salen vacías. Instálala en tu cuenta y elige los repos (docs/github-app.md, paso 3).
                </p>
                <div className="flex gap-2">
                  {installations.data?.installUrl ? (
                    <Button size="xs" onClick={() => host.openExternal(installations.data!.installUrl!)}>
                      <ExternalLink /> Instalar la GitHub App
                    </Button>
                  ) : null}
                  <Button size="xs" variant="outline" onClick={installations.reload}>
                    <RefreshCw /> Volver a revisar
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : connection ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">Scope comprobado al probar el token, más una lectura de prueba de cada permiso sobre un repo visible</span>
            <ul className="flex flex-wrap gap-1.5">
              {form.data?.scopes.map((scope) => {
                const granted = connection.scopes.includes(scope)
                return (
                  <li key={scope}>
                    <Pill className={granted ? tone.green : tone.red} hint={granted ? `El token tiene el scope ${scope}.` : `Al token le falta el scope ${scope}: crea uno nuevo con el formulario ya marcado.`}>
                      {granted ? <Check className="size-3" /> : <X className="size-3" />}
                      {scope}
                    </Pill>
                  </li>
                )
              })}
            </ul>
          </div>
        ) : (
          <p className="text-muted-foreground">Los agentes publican en GitHub con tu cuenta. Conecta la GitHub App (escribes un código en github.com) o crea un token classic con el scope repo ya marcado, pégalo y pruébalo.</p>
        )}
        {login.failure ? (
          <div role="alert" className="flex items-center gap-2 text-xs text-destructive">
            <p className="flex-1">{login.failure.message}</p>
            {login.failure.reason !== "failed" ? (
              <Button size="xs" variant="outline" onClick={() => void login.start()}>
                Intentar de nuevo
              </Button>
            ) : null}
          </div>
        ) : null}
        {showField ? (
          <TokenField
            label="Personal access token (classic)"
            placeholder="ghp_…"
            action="Probar"
            onSubmit={probe}
            help={
              <button type="button" onClick={createToken} disabled={!form.data} className={cn("flex w-fit items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50")}>
                <ExternalLink className="size-3" /> Crear el token con el scope ya marcado
              </button>
            }
          />
        ) : null}
      </ConnectionCard>
      <ConfirmDisconnect
        title={confirming ? "¿Desconectar GitHub?" : null}
        description="Se borra el token guardado (la autorización de la GitHub App sigue en tu cuenta de GitHub hasta que la revoques allá). Los pasos que publican (push, PRs, comentarios) esperan hasta que pegues uno nuevo; los agentes y los checks siguen."
        onOpenChange={setConfirming}
        onConfirm={() => void disconnect()}
      />
    </>
  )
}

function appStatusText(connection: Connection): string {
  switch (connection.status) {
    case "active":
      return "Conectado con la GitHub App: el token dura 8 horas y el core lo renueva solo, y cada renovación estira el refresh token 6 meses. Los agentes publican con tu cuenta y solo ven los repos donde instalaste la App."
    case "revoked":
      return "GitHub rechazó la renovación del token de la GitHub App (la revocaste o pasaron 6 meses sin uso). Lo que publica (push, PRs, comentarios) espera hasta que vuelvas a conectarla."
    case "expired":
      return "El refresh token de la GitHub App venció (dura 6 meses). Lo que publica (push, PRs, comentarios) espera hasta que vuelvas a conectarla."
  }
}
