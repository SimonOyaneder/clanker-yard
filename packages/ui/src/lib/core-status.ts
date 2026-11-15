import { useSyncExternalStore } from "react"
import type { CoreLink, CoreState } from "@/host"

const noSubscribe = () => () => {}
const noState = () => undefined

// El estado del core que aloja el host; `undefined` si el host no tiene core propio.
export function useCoreState(link: CoreLink | undefined): CoreState | undefined {
  return useSyncExternalStore(link ? link.subscribe : noSubscribe, link ? link.state : noState)
}

export type FooterTone = "live" | "pending" | "down" | "error"

// Texto y color del pie de la barra lateral. Con core propio manda su estado; después, si los datos
// fallan o si el stream de eventos está conectado.
export function footerStatus(
  core: CoreState | undefined,
  data: { error: string | null; connected: boolean },
): { text: string; tone: FooterTone } {
  if (core?.status === "down") return { text: "core caído", tone: "down" }
  if (core?.status === "starting") return { text: "iniciando core…", tone: "pending" }
  if (data.error) return { text: "error leyendo datos", tone: "error" }
  if (data.connected) return { text: "core en vivo", tone: "live" }
  return { text: "conectando…", tone: "pending" }
}
