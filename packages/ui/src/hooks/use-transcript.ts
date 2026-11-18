import type { AgentSessionId, TranscriptEntry } from "@clanker/api"
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react"
import { useAppData } from "@/app-data"
import { useLiveTick } from "@/hooks/use-live"
import { messageOf } from "@/lib/utils"

interface Loaded {
  entries: TranscriptEntry[]
  /** Hay más páginas ahora mismo; con la sesión viva vuelve a ser cierto cuando el agente escribe. */
  hasMore: boolean
  /** Ya llegó al menos una página. */
  loaded: boolean
  error: string | null
}

// El transcript de una sesión, página a página: la primera al montar y las siguientes con `loadMore`
// (la lista lo llama al acercarse al final). Con `live`, cada tanda de eventos del core pide lo que el
// agente escribió desde la última página. Una sesión distinta pide un hook nuevo (`key={sessionId}`).
export function useTranscript(sessionId: AgentSessionId, live: boolean) {
  const appData = useAppData()
  // Lo que el agente escribe llega como `agent.activity`; `step.*` cubre el cierre del paso.
  const revision = useLiveTick(["agent.*", "step.*"], live)
  const [state, setState] = useState<Loaded>({ entries: [], hasMore: true, loaded: false, error: null })
  const cursor = useRef(0)
  const busy = useRef(false)
  const mounted = useRef(false)

  const loadMore = useCallback(() => {
    if (busy.current) return
    busy.current = true
    appData
      .transcript(sessionId, cursor.current)
      .then(
        (page) => {
          if (!mounted.current) return
          cursor.current = page.next
          setState((s) => ({ entries: page.entries.length ? [...s.entries, ...page.entries] : s.entries, hasMore: page.hasMore, loaded: true, error: null }))
        },
        (e: unknown) => {
          if (mounted.current) setState((s) => ({ ...s, hasMore: false, loaded: true, error: messageOf(e) }))
        },
      )
      .finally(() => {
        busy.current = false
      })
  }, [appData, sessionId])

  useEffect(() => {
    mounted.current = true
    loadMore()
    return () => {
      mounted.current = false
    }
  }, [loadMore])

  // En vivo, y una vez más cuando la sesión termina (para leer la cola): lo nuevo desde el último cursor.
  const wasLive = useRef(live)
  const poll = useEffectEvent(() => {
    const justEnded = wasLive.current && !live
    wasLive.current = live
    if ((live || justEnded) && state.loaded && !state.hasMore) loadMore()
  })
  useEffect(() => {
    poll()
    // `revision` y `live` son los disparadores: lo demás lo lee `poll` fresco.
  }, [revision, live])

  return { ...state, loadMore }
}
