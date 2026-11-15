import { createContext, useContext } from "react"

// Acciones que el menú nativo le manda a la UI.
export type MenuAction =
  | "new-loop"
  | "command"
  | "refresh"
  | "toggle-sidebar"
  | "back"
  | "forward"
  | "tab:operacion"
  | "tab:resumen"
  | "shortcuts"
  | "go-prs"

export type Theme = "system" | "light" | "dark"
export type Unsubscribe = () => void

// Lo que la UI le pide al sistema que la aloja (Electron o el navegador). Todo lo demás
// entra por `AppData`.
export interface Host {
  onMenu(cb: (action: MenuAction) => void): Unsubscribe
  // Clicks en notificaciones y links profundos.
  onNavigate(cb: (target: { slug: string; issueId?: string }) => void): Unsubscribe
  notify(n: { title: string; body: string; target?: { slug: string; issueId?: string } }): void
  openExternal(url: string): void
  openInEditor(path: string): void
  // La UI siempre sigue `prefers-color-scheme`; el host decide qué valor tiene.
  setTheme(theme: Theme): void
}

const HostContext = createContext<Host | null>(null)
export const HostProvider = HostContext.Provider

export function useHost(): Host {
  const host = useContext(HostContext)
  if (!host) throw new Error("useHost fuera de HostProvider")
  return host
}
