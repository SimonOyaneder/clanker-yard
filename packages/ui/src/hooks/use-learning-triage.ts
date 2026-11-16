import type { Learning, LearningId } from "@clanker/api"
import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { useAppData } from "@/app-data"
import { UNDO_MS } from "@/hooks/use-decision-resolver"
import { capsOf, triageMessage, type TriageAction } from "@/lib/learnings"
import { messageOf } from "@/lib/undoable"

interface Entry {
  action: TriageAction
  /** El estado que tenía cuando se decidió: con otro estado en el core, la entrada ya no hace falta. */
  from: Learning["status"]
  batch: number
}

interface Batch {
  action: TriageAction
  ids: LearningId[]
  /** `true` cuando ya se mandó al core: ahí no hay vuelta atrás. */
  sent: boolean
}

/**
 * Aprobar, rechazar y retirar learnings con deshacer. El core no tiene "volver a `proposed`" (rechazar deja
 * `rejected` y aprobar deja `approved`, y cada uno emite su evento), así que la decisión se manda recién cuando
 * pasan `UNDO_MS` sin deshacerla (o al cerrar la vista). Mientras tanto `pending` dice cómo quedarán, para que la
 * lista los muestre ya en su pestaña nueva. Un lote es una decisión: Z deshace el último entero.
 */
export function useLearningTriage(learnings: Learning[] | undefined, reload: () => void) {
  const appData = useAppData()
  const [pending, setPending] = useState<ReadonlyMap<LearningId, Entry>>(new Map())
  const latest = useRef(pending)
  latest.current = pending
  const batches = useRef(new Map<number, Batch>())
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const nextBatch = useRef(0)

  const update = useCallback((fn: (next: Map<LearningId, Entry>) => void) => {
    const next = new Map(latest.current)
    fn(next)
    latest.current = next
    setPending(next)
  }, [])

  const send = useCallback(
    async (batchId: number) => {
      const batch = batches.current.get(batchId)
      if (!batch || batch.sent) return
      batch.sent = true
      update(() => {})
      clearTimeout(timers.current.get(batchId))
      timers.current.delete(batchId)
      const failed: LearningId[] = []
      let firstError = ""
      // Una por una: el core las aplica cada una en su transacción y así un fallo no deja el resto sin mandar.
      for (const id of batch.ids) {
        try {
          await (batch.action === "approve" ? appData.approveLearning(id) : appData.rejectLearning(id))
        } catch (e) {
          failed.push(id)
          firstError ||= messageOf(e)
        }
      }
      if (failed.length) {
        update((next) => failed.forEach((id) => next.delete(id)))
        toast.error(`No pude ${batch.action === "approve" ? "aprobar" : "rechazar"} ${failed.length === batch.ids.length ? (failed.length === 1 ? "el learning" : `los ${failed.length}`) : `${failed.length} de ${batch.ids.length}`}: ${firstError}`)
      }
      batches.current.delete(batchId)
      reload()
    },
    [appData, reload, update],
  )

  // Cuando el core ya muestra el estado nuevo (o cualquier otro), deja de hacer falta recordarlo.
  useEffect(() => {
    if (!learnings) return
    const stale = [...latest.current].filter(([id, entry]) => batches.current.get(entry.batch)?.sent !== false && learnings.find((l) => l.id === id)?.status !== entry.from)
    if (stale.length) update((next) => stale.forEach(([id]) => next.delete(id)))
  }, [learnings, update])

  const undoBatch = useCallback(
    (batchId: number): LearningId[] => {
      const batch = batches.current.get(batchId)
      if (!batch || batch.sent) return []
      clearTimeout(timers.current.get(batchId))
      timers.current.delete(batchId)
      batches.current.delete(batchId)
      update((next) => batch.ids.forEach((id) => next.delete(id)))
      toast.dismiss(`learning-batch-${batchId}`)
      return batch.ids
    },
    [update],
  )

  /** Decide sobre `targets` (los que no admiten la acción se saltan). Devuelve cuántos tomó. */
  const apply = useCallback(
    (action: TriageAction, targets: Learning[]): number => {
      const eligible = targets.filter((l) => !latest.current.has(l.id) && (action === "approve" ? capsOf(l).approve : capsOf(l).reject))
      if (eligible.length === 0) return 0
      const batch = nextBatch.current++
      batches.current.set(batch, { action, ids: eligible.map((l) => l.id), sent: false })
      update((next) => eligible.forEach((l) => next.set(l.id, { action, from: l.status, batch })))
      timers.current.set(
        batch,
        setTimeout(() => void send(batch), UNDO_MS),
      )
      toast(triageMessage(action, eligible), { id: `learning-batch-${batch}`, duration: UNDO_MS, action: { label: "Deshacer · Z", onClick: () => undoBatch(batch) } })
      return eligible.length
    },
    [send, update, undoBatch],
  )

  /** Devuelve a su lugar la última decisión que todavía no se mandó. `false` si no hay nada que deshacer. */
  const undo = useCallback((): boolean => {
    const last = [...batches.current].reverse().find(([, b]) => !b.sent)?.[0]
    return last !== undefined && undoBatch(last).length > 0
  }, [undoBatch])

  // Cerrar la vista no puede dejar decisiones sin mandar.
  const sendNow = useRef(send)
  sendNow.current = send
  useEffect(() => {
    const open = timers.current
    return () => {
      for (const id of [...open.keys()]) void sendNow.current(id)
    }
  }, [])

  const actions = new Map<LearningId, TriageAction>([...pending].map(([id, entry]) => [id, entry.action]))
  return { pending: actions, apply, undo, canUndo: [...pending.values()].some((e) => batches.current.get(e.batch)?.sent === false) }
}
