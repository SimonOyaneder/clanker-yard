import type { ColorMode } from "@xyflow/react"
import { useSyncExternalStore } from "react"

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
  return () => observer.disconnect()
}

// El tema de la app (la clase `dark` de <html>) en el formato de xyflow.
export function useColorMode(): ColorMode {
  return useSyncExternalStore(
    subscribe,
    () => (document.documentElement.classList.contains("dark") ? "dark" : "light"),
    () => "light",
  )
}
