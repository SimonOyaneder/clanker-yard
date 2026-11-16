import type { Decision, RunDetail, RunId } from "@clanker/api"
import { Hand } from "lucide-react"
import { useContext, useEffect } from "react"
import { useAppData } from "@/app-data"
import { Hint } from "@/components/common"
import { Button } from "@/components/ui/button"
import { useLiveQuery } from "@/hooks/use-live"
import { AppActionsContext } from "@/lib/app-context"
import { parksRun } from "@/lib/decisions"
import { tone } from "@/lib/format"
import { cn } from "@/lib/utils"
import { isTypingTarget, overlayOpen } from "@/lib/keys"

/** Las decisiones pendientes que tienen estacionada la corrida: una a lo más, porque un paso a la vez la avanza. */
function useParkingDecision(runId: RunId): Decision | undefined {
  const appData = useAppData()
  const pending = useLiveQuery(`run-decisions:${runId}`, () => appData.decisions({ runId, status: ["pending"] }))
  return pending.data?.find(parksRun)
}

// "Abrir decisión" lleva a la bandeja con la decisión a la vista. D lo hace sin el mouse.
function useOpenWithD(decision: Decision | undefined) {
  const open = useContext(AppActionsContext)?.openDecision
  useEffect(() => {
    if (!decision || !open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "d" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat) return
      if (isTypingTarget(e.target)) return
      if (overlayOpen()) return
      e.preventDefault()
      open(decision.id)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [decision, open])
}

// El aviso de una corrida estacionada: dice por qué espera, que no frena a nadie y lleva a la decisión.
export function ParkedCallout({ run }: { run: RunDetail }) {
  const open = useContext(AppActionsContext)?.openDecision
  const decision = useParkingDecision(run.id)
  useOpenWithD(run.status === "parked" ? decision : undefined)
  if (run.status !== "parked") return null
  return (
    <div role="status" className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-3 py-2 text-[13px]", tone.amber)}>
      <Hand className="size-4 flex-none" />
      <p className="min-w-0 flex-1">
        <span className="font-medium">{decision?.title ?? "Esta corrida espera una decisión."}</span> Está estacionada: no ocupa cupo en su carril y nada más espera. Al resolverla vuelve a la cola.
      </p>
      {decision && open ? (
        <Hint label="Abrir la decisión en la bandeja" keys="D" side="bottom">
          <Button size="sm" variant="secondary" onClick={() => open(decision.id)}>
            Abrir decisión
          </Button>
        </Hint>
      ) : null}
    </div>
  )
}

/** "Abrir decisión" en el panel de un paso cuya decisión estaciona la corrida. */
export function OpenDecisionButton({ runId, stepId }: { runId: RunId; stepId: string }) {
  const open = useContext(AppActionsContext)?.openDecision
  const decision = useParkingDecision(runId)
  if (!decision || !open || decision.stepRunId !== stepId) return null
  return (
    <Button size="xs" variant="secondary" onClick={() => open(decision.id)}>
      Abrir decisión
    </Button>
  )
}
