import { useSyncExternalStore } from "react"
import type { CoreLink, CoreState } from "@/host"
import { ago } from "@/lib/format"

const noSubscribe = () => () => {}
const noState = () => undefined

// El estado del core que aloja el host; `undefined` si el host no tiene core propio.
export function useCoreState(link: CoreLink | undefined): CoreState | undefined {
  return useSyncExternalStore(link ? link.subscribe : noSubscribe, link ? link.state : noState)
}

export type FooterTone = "live" | "pending" | "down" | "error"

// Texto y color del pie de la barra lateral. Con core propio manda su estado; sin él, el último poll de datos.
export function footerStatus(
  core: CoreState | undefined,
  data: { error: string | null; updatedAt: number | null },
  now = Date.now(),
): { text: string; tone: FooterTone } {
  if (core?.status === "down") return { text: "core caído", tone: "down" }
  if (core?.status === "starting") return { text: "iniciando core…", tone: "pending" }
  if (data.error) return { text: "error leyendo datos", tone: "error" }
  if (core) return { text: "core en vivo", tone: "live" }
  if (data.updatedAt) return { text: `en vivo · ${ago(new Date(data.updatedAt).toISOString(), now)}`, tone: "live" }
  return { text: "cargando…", tone: "pending" }
}
