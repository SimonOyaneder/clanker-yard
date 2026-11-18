import type { CodexStatus, Connection } from "@clanker/api"
import { Copy, Loader2, SquareTerminal, Unplug } from "lucide-react"
import { toast } from "sonner"
import { useAppData } from "@/app-data"
import { Hint, Pill } from "@/components/common"
import { ConfirmDisconnect, ConnectionCard } from "@/components/connections/connection-card"
import { CodexUsageBars, renewal } from "@/components/connections/plan-usage"
import { Button } from "@/components/ui/button"
import type { CodexPlan } from "@/hooks/use-codex-plan"
import { copy } from "@/lib/clipboard"
import { codexLook } from "@/lib/connections"
import { absolute, ago, tone } from "@/lib/format"
import { messageOf } from "@/lib/utils"

const details = (status: CodexStatus) => [status.version && `Codex ${status.version}`, status.plan && `plan ${status.plan}`].filter(Boolean).join(" · ")

/** Los estados que se arreglan del lado de la persona: el mensaje del core dice qué hacer (instalar, `codex login`, actualizar). */
const warning = (state: CodexStatus["state"]) => state === "quota_exhausted" || state === "outdated"

interface Props {
  connection: Connection | undefined
  plan: CodexPlan
  /** El diálogo de desconectar: lo abre el menú de la tarjeta o la paleta ⌘K. */
  confirming: boolean
  onConfirmingChange: (open: boolean) => void
  onChanged: () => void
}

// Codex corre con el login de la suscripción de ChatGPT del `codex` instalado. [Conectar] / [Probar] lee la sesión, el plan
// y el uso sin llamar al modelo, así que no gasta cuota.
export function CodexCard({ connection, plan, confirming, onConfirmingChange, onChanged }: Props) {
  const appData = useAppData()
  const { status } = plan
  const look = codexLook(connection, status)

  const removeConnection = async () => {
    if (!connection) return
    try {
      await appData.disconnect({ provider: "codex", account: connection.account })
      onChanged()
      toast.success("Codex desconectado: tu sesión de Codex sigue iniciada")
    } catch (e) {
      toast.error(messageOf(e))
    }
  }

  return (
    <>
      <ConnectionCard
        icon={<SquareTerminal className="size-4" />}
        title="Codex"
        account={connection ? "suscripción" : undefined}
        status={look}
        chips={
          status && details(status) ? (
            <Pill className={tone.neutral} hint="Lo que detectó la última prueba.">
              {details(status)}
            </Pill>
          ) : null
        }
        primary={
          <Hint label="Lee la sesión, el plan y el uso de Codex: no gasta cuota" keys="⇧⌘X" side="top">
            <Button size="sm" onClick={() => void plan.test()} disabled={plan.testing}>
              {plan.testing ? <Loader2 className="animate-spin" /> : null}
              {connection ? "Probar" : "Conectar"}
            </Button>
          </Hint>
        }
        menu={[
          { label: "Copiar versión", icon: <Copy />, onSelect: () => status?.version && copy(status.version, "la versión de Codex"), disabled: !status?.version },
          { label: "Desconectar", icon: <Unplug />, onSelect: () => onConfirmingChange(true), destructive: true, disabled: !connection },
        ]}
      >
        {status ? <CodexUsageBars status={status} /> : null}
        {status?.state === "quota_exhausted" && status.resetsAt ? (
          <p role="status" className="text-amber-700 dark:text-amber-300">
            Se agotó la cuota del plan: los pasos de agente con Codex esperan hasta que se renueve {renewal(status.resetsAt)}.
          </p>
        ) : status?.message && status.state !== "ready" ? (
          <p role={warning(status.state) ? "status" : "alert"} className={warning(status.state) ? "text-amber-700 dark:text-amber-300" : "text-destructive"}>
            {status.message}
          </p>
        ) : null}
        {!status ? (
          <p className="text-muted-foreground">
            {connection
              ? "Pulsa Probar para ver el plan y cuánto va usado."
              : "Usa el login del Codex instalado (`codex login` con tu cuenta de ChatGPT): no se guarda nada. Pulsa Conectar para detectarlo y ver el plan y su uso."}
          </p>
        ) : status.state === "ready" && !status.usage?.windows.length ? (
          <p className="text-muted-foreground">Codex no informó ventanas de uso para este plan.</p>
        ) : null}
        {plan.error ? (
          <p role="alert" className="text-xs text-destructive">
            {plan.error}
          </p>
        ) : null}
        {plan.at ? (
          <span title={absolute(plan.at)} className="text-xs text-muted-foreground">
            Actualizado {ago(plan.at)}
          </span>
        ) : null}
      </ConnectionCard>
      <ConfirmDisconnect
        title={confirming && connection ? "¿Desconectar Codex?" : null}
        description="Se olvida la cuenta de suscripción; la sesión del Codex instalado no se cierra (para eso, `codex logout`). Los pasos de agente con Codex esperan hasta que lo conectes de nuevo."
        onOpenChange={onConfirmingChange}
        onConfirm={() => void removeConnection()}
      />
    </>
  )
}
