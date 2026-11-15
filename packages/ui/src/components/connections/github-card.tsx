import type { Connection } from "@clanker/api"
import { Check, Copy, ExternalLink, GitBranch, KeyRound, Loader2, Unplug, X } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { useAppData } from "@/app-data"
import { Pill } from "@/components/common"
import { ConfirmDisconnect, ConnectionCard } from "@/components/connections/connection-card"
import { TokenField } from "@/components/connections/token-field"
import { Button } from "@/components/ui/button"
import { useGitHubDeviceFlow } from "@/hooks/use-github-device-flow"
import { useLiveQuery } from "@/hooks/use-live"
import { useHost } from "@/host"
import { copy } from "@/lib/clipboard"
import { expiryLabel, statusLook } from "@/lib/connections"
import { tone } from "@/lib/format"
import { cn } from "@/lib/utils"

// GitHub entra por la GitHub App (device flow: el core da un código y la cuenta aparece sola al aprobarlo en
// github.com) o con un fine-grained PAT: se pega y [Probar] lo valida contra GitHub (usuario y una lectura por permiso).
export function GitHubCard({ connection, onChanged }: { connection: Connection | undefined; onChanged: () => void }) {
  const appData = useAppData()
  const host = useHost()
  const login = useGitHubDeviceFlow(connection, onChanged)
  const form = useLiveQuery("github-pat-form", () => appData.githubPatForm(), { live: false })
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const active = connection?.status === "active"
  const viaApp = connection?.auth === "app"
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
          expiry ? (
            <Pill
              className={connection?.status !== "active" ? tone.red : connection.expiresSoon ? tone.amber : tone.neutral}
              hint={viaApp ? "El refresh token de la GitHub App dura 6 meses y el core lo renueva solo con cada uso; si vence hay que volver a conectar." : "Los fine-grained PAT vencen en la fecha que elegiste al crearlos; hay que rotarlos a mano."}
            >
              {expiry}
            </Pill>
          ) : null
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
              {viaApp ? "Reconectar" : "Conectar con la GitHub App"}
            </Button>
          </>
        }
        menu={[
          { label: "Crear token con los permisos marcados", icon: <ExternalLink />, onSelect: createToken, disabled: !form.data },
          { label: "Pegar un token nuevo", icon: <KeyRound />, onSelect: () => setEditing(true), disabled: !connection },
          { label: "Copiar cuenta", icon: <Copy />, onSelect: () => connection && copy(connection.account, "la cuenta de GitHub"), disabled: !connection },
          { label: "Desconectar", icon: <Unplug />, onSelect: () => setConfirming(true), destructive: true, disabled: !connection },
        ]}
      >
        {login.pending ? (
          <div className="flex flex-col gap-1.5">
            <p>
              Escribe este código en <span className="font-mono text-foreground">{login.pending.verificationUri}</span> y aprueba la GitHub App. Al aprobar, la cuenta aparece acá sola.
            </p>
            <p className="font-mono text-2xl font-semibold tracking-widest" aria-label="Código de GitHub">
              {login.pending.userCode}
            </p>
            <div className="flex gap-2">
              <Button size="xs" variant="outline" onClick={() => login.pending && host.openExternal(login.pending.verificationUri)}>
                <ExternalLink /> Abrir de nuevo
              </Button>
              <Button size="xs" variant="outline" onClick={() => login.pending && copy(login.pending.userCode, "el código de GitHub")}>
                <Copy /> Copiar código
              </Button>
              <Button size="xs" variant="ghost" onClick={login.dismiss}>
                Cancelar
              </Button>
            </div>
          </div>
        ) : viaApp && connection ? (
          <p className={connection.status === "active" ? "text-muted-foreground" : "text-destructive"}>
            {connection.status === "active"
              ? "Conectado con la GitHub App: el token dura 8 horas y el core lo renueva solo. Los agentes publican con tu cuenta y solo ven los repos donde instalaste la App."
              : "GitHub rechazó la renovación del token de la GitHub App. Lo que publica (push, PRs, comentarios) espera hasta que vuelvas a conectarla."}
          </p>
        ) : connection ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">Permisos comprobados con una lectura de prueba sobre un repo visible</span>
            <ul className="flex flex-wrap gap-1.5">
              {form.data?.permissions.map((p) => {
                const granted = connection.scopes.includes(p.name)
                return (
                  <li key={p.name}>
                    <Pill className={granted ? tone.green : tone.red} hint={granted ? `El token puede usar ${p.label}.` : `Al token le falta ${p.label} (${p.access}): crea uno nuevo con el formulario ya marcado.`}>
                      {granted ? <Check className="size-3" /> : <X className="size-3" />}
                      {p.label} · {p.access}
                    </Pill>
                  </li>
                )
              })}
            </ul>
          </div>
        ) : (
          <p className="text-muted-foreground">Los agentes publican en GitHub con tu cuenta. Conecta la GitHub App (escribes un código en github.com) o crea un token con los permisos ya marcados, pégalo y pruébalo.</p>
        )}
        {login.error ? (
          <p role="alert" className="text-xs text-destructive">
            {login.error}
          </p>
        ) : null}
        {showField ? (
          <TokenField
            label="Fine-grained personal access token"
            placeholder="github_pat_…"
            action="Probar"
            onSubmit={probe}
            help={
              <button type="button" onClick={createToken} disabled={!form.data} className={cn("flex w-fit items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50")}>
                <ExternalLink className="size-3" /> Crear el token con los permisos ya marcados
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
