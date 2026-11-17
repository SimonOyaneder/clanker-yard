import type { ClaudeStatus, Connection } from "@clanker/api"
import { Bot, Copy, KeyRound, Loader2, Unplug, Undo2 } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { useAppData } from "@/app-data"
import { Hint, Pill } from "@/components/common"
import { ConfirmDisconnect, ConnectionCard } from "@/components/connections/connection-card"
import { TokenField } from "@/components/connections/token-field"
import { UsageBar } from "@/components/connections/usage-bar"
import { Button } from "@/components/ui/button"
import type { ClaudePlan } from "@/hooks/use-claude-plan"
import { copy } from "@/lib/clipboard"
import { claudeLook } from "@/lib/connections"
import { absolute, ago, tone } from "@/lib/format"
import { messageOf } from "@/lib/utils"

const details = (status: ClaudeStatus) => [status.version && `Claude Code ${status.version}`, status.plan && `plan ${status.plan}`].filter(Boolean).join(" · ")

// Claude corre con el login de la suscripción del `claude` instalado o con una API key. [Probar] hace una llamada mínima y lee el plan y su uso.
export function ClaudeCard({ connection, plan, onChanged }: { connection: Connection | undefined; plan: ClaudePlan; onChanged: () => void }) {
  const appData = useAppData()
  const [confirming, setConfirming] = useState(false)
  const [keyOpen, setKeyOpen] = useState(false)

  const { status } = plan
  const apiKey = connection?.account === "api-key"
  const look = claudeLook(connection, status)

  const saveKey = async (key: string) => {
    await appData.setClaudeApiKey(key)
    setKeyOpen(false)
    onChanged()
    toast.success("API key guardada: los agentes la usan desde el próximo paso")
    await plan.test("api-key")
  }
  const removeConnection = async () => {
    if (!connection) return
    try {
      await appData.disconnect({ provider: "claude", account: connection.account })
      plan.clear()
      onChanged()
      toast.success(apiKey ? "Volviste al login de la suscripción" : "Claude desconectado")
    } catch (e) {
      toast.error(messageOf(e))
    }
  }

  return (
    <>
      <ConnectionCard
        icon={<Bot className="size-4" />}
        title="Claude"
        account={connection ? (apiKey ? "API key" : "suscripción") : undefined}
        status={look}
        chips={
          status && details(status) ? (
            <Pill className={tone.neutral} hint="Lo que detectó la última prueba.">
              {details(status)}
            </Pill>
          ) : null
        }
        primary={
          <Hint label="Llamada mínima a Claude: gasta un poco de cuota" keys="⇧⌘T" side="top">
            <Button size="sm" onClick={() => void plan.test()} disabled={plan.testing}>
              {plan.testing ? <Loader2 className="animate-spin" /> : null}
              Probar
            </Button>
          </Hint>
        }
        menu={[
          { label: "Usar una API key", icon: <KeyRound />, onSelect: () => setKeyOpen(true), disabled: apiKey },
          { label: "Copiar versión", icon: <Copy />, onSelect: () => status?.version && copy(status.version, "la versión de Claude Code"), disabled: !status?.version },
          apiKey
            ? { label: "Volver a la suscripción", icon: <Undo2 />, onSelect: () => setConfirming(true), destructive: true }
            : { label: "Desconectar", icon: <Unplug />, onSelect: () => setConfirming(true), destructive: true, disabled: !connection },
        ]}
      >
        {status?.usage?.fiveHour || status?.usage?.sevenDay ? (
          <div className="flex flex-col gap-1.5">
            {status.usage.fiveHour ? <UsageBar label="5 h" window={status.usage.fiveHour} short /> : null}
            {status.usage.sevenDay ? <UsageBar label="7 días" window={status.usage.sevenDay} short={false} /> : null}
          </div>
        ) : null}
        {status?.message && status.state !== "ready" ? (
          <p role={status.state === "quota_exhausted" || status.state === "outdated" ? "status" : "alert"} className={status.state === "quota_exhausted" || status.state === "outdated" ? "text-amber-700 dark:text-amber-300" : "text-destructive"}>
            {status.message}
          </p>
        ) : null}
        {!status ? (
          <p className="text-muted-foreground">
            {connection ? "Pulsa Probar para ver el plan y cuánto va usado." : "Usa el login del Claude Code instalado: no se guarda nada. Pulsa Probar para detectarlo y ver el plan y su uso."}
          </p>
        ) : status.mode === "api-key" ? (
          <p className="text-muted-foreground">Los agentes gastan tu API key, no la suscripción: no hay barras de uso.</p>
        ) : null}
        {plan.error ? (
          <p role="alert" className="text-xs text-destructive">
            {plan.error}
          </p>
        ) : null}
        {plan.at ? (
          <span title={absolute(plan.at)} className="text-xs text-muted-foreground">
            Probado {ago(plan.at)}
          </span>
        ) : null}
        {keyOpen ? (
          <TokenField
            label="API key de Anthropic"
            placeholder="sk-ant-…"
            action="Guardar y usar"
            onSubmit={saveKey}
            help={<span className="text-xs text-muted-foreground">Se prueba antes de guardar y se guarda en el llavero, nunca en la base. Mientras exista, los agentes la usan en vez de la suscripción.</span>}
          />
        ) : null}
      </ConnectionCard>
      <ConfirmDisconnect
        title={confirming ? (apiKey ? "¿Volver a la suscripción?" : "¿Desconectar Claude?") : null}
        description={apiKey ? "Se borra la API key guardada y los agentes vuelven a usar el login del Claude Code instalado." : "Se olvida la cuenta de suscripción; el login del Claude Code instalado no se toca. Los pasos de agente esperan hasta que pruebes de nuevo."}
        action={apiKey ? "Volver" : "Desconectar"}
        onOpenChange={setConfirming}
        onConfirm={() => void removeConnection()}
      />
    </>
  )
}
