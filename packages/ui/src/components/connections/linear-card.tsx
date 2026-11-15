import type { Connection } from "@clanker/api"
import { Copy, ExternalLink, Layers, Loader2, Unplug } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { useAppData } from "@/app-data"
import { Hint, Pill } from "@/components/common"
import { ConfirmDisconnect, ConnectionCard } from "@/components/connections/connection-card"
import { Button } from "@/components/ui/button"
import type { LinearLogin } from "@/hooks/use-linear-login"
import { useHost } from "@/host"
import { copy } from "@/lib/clipboard"
import { expiryLabel, statusLook } from "@/lib/connections"
import { tone } from "@/lib/format"

// Linear entra por OAuth en el navegador: el core devuelve el link, lo abre el host y la cuenta aparece sola.
export function LinearCard({ connection, login, onChanged }: { connection: Connection | undefined; login: LinearLogin; onChanged: () => void }) {
  const appData = useAppData()
  const host = useHost()
  const [confirming, setConfirming] = useState(false)

  const disconnect = async () => {
    if (!connection) return
    try {
      await appData.disconnect("linear", connection.account)
      onChanged()
      toast.success("Linear desconectado")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  const expiry = expiryLabel(connection)
  const label = connection ? "Reconectar" : "Conectar con Linear"
  return (
    <>
      <ConnectionCard
        icon={<Layers className="size-4" />}
        title="Linear"
        account={connection?.account}
        status={statusLook(connection)}
        chips={
          expiry ? (
            <Pill className={connection?.status === "active" ? tone.neutral : tone.red} hint="El refresh token dura 30 días desde su último uso y se renueva solo mientras el core lo usa; si vence hay que volver a conectar.">
              {expiry}
            </Pill>
          ) : null
        }
        primary={
          <Hint label={label} keys="⇧⌘L" side="top">
            <Button size="sm" variant={connection?.status === "active" ? "outline" : "default"} disabled={login.pending !== null} onClick={() => void login.start()}>
              {login.pending ? <Loader2 className="animate-spin" /> : null}
              {label}
            </Button>
          </Hint>
        }
        menu={[
          { label: "Copiar workspace", icon: <Copy />, onSelect: () => connection && copy(connection.account, "el workspace de Linear"), disabled: !connection },
          { label: "Desconectar", icon: <Unplug />, onSelect: () => setConfirming(true), destructive: true, disabled: !connection },
        ]}
      >
        {login.pending ? (
          <div className="flex flex-col gap-1.5">
            <p>Esperando que apruebes en el navegador. Al aprobar, la cuenta aparece acá sola.</p>
            <div className="flex gap-2">
              <Button size="xs" variant="outline" onClick={() => login.pending && host.openExternal(login.pending.url)}>
                <ExternalLink /> Abrir de nuevo
              </Button>
              <Button size="xs" variant="outline" onClick={() => login.pending && copy(login.pending.url, "el link de Linear")}>
                <Copy /> Copiar link
              </Button>
            </div>
          </div>
        ) : connection && connection.status !== "active" ? (
          <p className="text-destructive">La conexión con el workspace {connection.account} dejó de valer: la cola de issues no se actualiza, pero las corridas en curso siguen. Reconecta para retomarla.</p>
        ) : connection ? (
          <p className="text-muted-foreground">
            Workspace <span className="font-mono text-foreground">{connection.account}</span> con permisos de {connection.scopes.join(" y ") || "lectura"}. Los agentes comentan como tú, con el prefijo [clanker].
          </p>
        ) : (
          <p className="text-muted-foreground">Abre Linear en el navegador, apruebas y vuelves solo. Con esto el core lee la cola de issues y las mueve de estado.</p>
        )}
        {login.error ? (
          <p role="alert" className="text-xs text-destructive">
            {login.error}
          </p>
        ) : null}
      </ConnectionCard>
      <ConfirmDisconnect
        title={confirming ? "¿Desconectar Linear?" : null}
        description="Se borra el token y la cuenta de este equipo; no se revoca en Linear (hazlo desde su configuración si quieres). La cola de issues deja de actualizarse; las corridas en curso siguen."
        onOpenChange={setConfirming}
        onConfirm={() => void disconnect()}
      />
    </>
  )
}
