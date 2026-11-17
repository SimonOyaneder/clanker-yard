import { isEventOf, type DecisionId, type DecisionKind } from "@clanker/api"
import { useEffect, useRef } from "react"
import { useLive } from "@/hooks/use-live"
import { type MenuAction, useHost } from "@/host"

// Estas decisiones avisan con una notificación nativa: alguien las tiene que atender. Las notas no entran a la bandeja: viven en su corrida y su PR.
const NOTIFY_KINDS: ReadonlySet<DecisionKind> = new Set(["gate", "needs_human", "alert"])

/** Lo que hace la app con cada acción del menú nativo, y adónde lleva una notificación. */
export interface HostBridge {
  /** Una acción del menú nativo (sus accelerators). */
  onMenu(action: MenuAction): void
  openDecision(id: DecisionId): void
  selectProject(slug: string): void
}

/**
 * Lo que la app recibe del host y le manda: el menú nativo, los clicks en una notificación (solo abren la
 * decisión o el proyecto, nunca aprueban) y la notificación de una decisión nueva que alguien tiene que atender
 * si la ventana no está a la vista. Lee siempre lo último de `bridge`, así no se resuscribe en cada render.
 */
export function useHostBridge(bridge: HostBridge): void {
  const host = useHost()
  const live = useLive()
  const latest = useRef(bridge)
  latest.current = bridge

  useEffect(() => {
    const offMenu = host.onMenu((action) => latest.current.onMenu(action))
    const offNav = host.onNavigate((target) =>
      "decisionId" in target ? latest.current.openDecision(target.decisionId as DecisionId) : latest.current.selectProject(target.slug),
    )
    return () => {
      offMenu()
      offNav()
    }
  }, [host])

  useEffect(
    () =>
      live.subscribe((event) => {
        if (!isEventOf(event, "decision.opened")) return
        const { decisionId: id, kind, title } = event.payload
        if (!NOTIFY_KINDS.has(kind) || document.hasFocus()) return
        host.notify({ title: kind === "alert" ? "Alerta en Clanker Yard" : "Una corrida te espera", body: title, target: { decisionId: id } })
      }),
    [live, host],
  )
}
