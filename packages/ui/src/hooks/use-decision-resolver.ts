import type { Decision, DecisionId } from "@clanker/api"
import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { useAppData } from "@/app-data"
import { optionLabel } from "@/lib/decisions"
import { messageOf } from "@/lib/utils"

/** Lo que dura el aviso con "Deshacer": la corrida no parte hasta que pasa. */
export const UNDO_MS = 5000

interface Resolving {
  option: string
  /** `true` cuando ya se mandó al core: ahí no hay vuelta atrás. */
  sent: boolean
}


/**
 * Resolver con deshacer. El core no tiene "reabrir": resolver reencola la corrida de inmediato. Así que
 * la respuesta se manda al core recién cuando pasan `UNDO_MS` sin que se deshaga (o al cerrar la app), y
 * mientras tanto la decisión sale de las pendientes y un aviso ofrece Z para devolverla.
 */
export function useDecisionResolver(decisions: Decision[], reload: () => void) {
  const appData = useAppData()
  const [resolving, setResolving] = useState<ReadonlyMap<DecisionId, Resolving>>(new Map())
  const timers = useRef(new Map<DecisionId, ReturnType<typeof setTimeout>>())
  const latest = useRef(resolving)
  latest.current = resolving

  const update = useCallback((fn: (next: Map<DecisionId, Resolving>) => void) => {
    const next = new Map(latest.current)
    fn(next)
    latest.current = next
    setResolving(next)
  }, [])

  const send = useCallback(
    (id: DecisionId) => {
      const entry = latest.current.get(id)
      if (!entry || entry.sent) return
      clearTimeout(timers.current.get(id))
      timers.current.delete(id)
      update((next) => next.set(id, { ...entry, sent: true }))
      appData.resolveDecision(id, entry.option).then(reload, (e: unknown) => {
        update((next) => next.delete(id))
        toast.error(messageOf(e))
        reload()
      })
    },
    [appData, reload, update],
  )

  // Cuando el core ya la muestra resuelta, deja de hacer falta recordarla.
  useEffect(() => {
    const stale = [...latest.current].filter(([id, entry]) => entry.sent && decisions.some((d) => d.id === id && d.status !== "pending"))
    if (stale.length) update((next) => stale.forEach(([id]) => next.delete(id)))
  }, [decisions, update])

  /** Devuelve a las pendientes la última que se resolvió y todavía no se mandó (o `id`). `null` si no hay nada que deshacer. */
  const undo = useCallback(
    (id?: DecisionId): DecisionId | null => {
      const target = id ?? [...latest.current].reverse().find(([, entry]) => !entry.sent)?.[0]
      const entry = target && latest.current.get(target)
      if (!target || !entry || entry.sent) return null
      clearTimeout(timers.current.get(target))
      timers.current.delete(target)
      update((next) => next.delete(target))
      toast.dismiss(target)
      return target
    },
    [update],
  )

  const resolve = useCallback(
    (decision: Decision, option: string) => {
      if (latest.current.has(decision.id)) return
      const label = optionLabel(decision, option)
      update((next) => next.set(decision.id, { option, sent: false }))
      timers.current.set(
        decision.id,
        setTimeout(() => send(decision.id), UNDO_MS),
      )
      toast(`${decision.title}: ${label}`, { id: decision.id, duration: UNDO_MS, action: { label: "Deshacer · Z", onClick: () => undo(decision.id) } })
    },
    [send, update, undo],
  )

  // Cerrar la vista no puede dejar respuestas sin mandar.
  const sendNow = useRef(send)
  sendNow.current = send
  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const id of [...pending.keys()]) sendNow.current(id)
    }
  }, [])

  return { resolving, resolve, undo, canUndo: [...resolving.values()].some((e) => !e.sent) }
}
