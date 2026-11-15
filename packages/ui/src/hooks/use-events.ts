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
        onEvent: deliver,
        onConnection: setConnected,
      }),
    [appData],
  )
  return connected
}
