import { useEffect, useEffectEvent, useState } from "react"
import type { Event } from "@clanker/api"
import { useAppData } from "@/app-data"
import { followEvents } from "@/lib/follow-events"

// Sigue los eventos del core mientras el componente está montado. Devuelve si hay conexión.
export function useEvents(onEvent: (event: Event) => void): boolean {
  const appData = useAppData()
  const [connected, setConnected] = useState(false)
  const deliver = useEffectEvent(onEvent)

  useEffect(
    () =>
      followEvents({
        open: (after, signal) => appData.events(after, signal),
        // Las consultas se releen al conectar: el historial solo haría releer todo cientos de veces y, con la
        // ventana sin foco, avisar de decisiones viejas.
        start: () => appData.latestEventSeq(),
        onEvent: deliver,
        onConnection: setConnected,
      }),
    [appData],
  )
  return connected
}
