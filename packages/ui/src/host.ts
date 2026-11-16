import { createContext, useContext } from "react"

// Acciones que el menú nativo le manda a la UI.
export type MenuAction =
  | "new-project"
  | "command"
  | "refresh"
  | "toggle-sidebar"
  | "back"
  | "forward"
  | "shortcuts"
  | "go-prs"
  | "go-inbox"
  | "go-learnings"

export type Theme = "system" | "light" | "dark"
export type Unsubscribe = () => void

// Cómo está el core que aloja el host. `starting` es el arranque inicial o un reintento.
export type CoreState =
  | { status: "starting" }
  | { status: "live"; version: string }
  | { status: "down"; reason: string }

// El core local que el host lanza y vigila. Solo existe donde hay un core propio (Electron); en el
// navegador de desarrollo o en una web contra un core remoto no aplica y `Host.core` falta.
export interface CoreLink {
  state(): CoreState
  // Cada cambio de `state()`; el valor anterior no se repite.
  subscribe(cb: () => void): Unsubscribe
  // Relanza el core caído.
  retry(): void
  openLogs(): void
}

// A dónde lleva un click en una notificación o un link profundo: un proyecto (y quizá una issue) o una decisión de la bandeja.
export type NavTarget = { slug: string; issueId?: string } | { decisionId: string }

// Lo que la UI le pide al sistema que la aloja (Electron o el navegador). Todo lo demás
// entra por `AppData`.
export interface Host {
  core?: CoreLink
  onMenu(cb: (action: MenuAction) => void): Unsubscribe
  // Clicks en notificaciones y links profundos.
  onNavigate(cb: (target: NavTarget) => void): Unsubscribe
  notify(n: { title: string; body: string; target?: NavTarget }): void
  openExternal(url: string): void
  openInEditor(path: string): void
  // El selector nativo de carpetas: la ruta elegida o `null` si se cancela. Falta donde el host no tiene uno (navegador).
  pickDirectory?(): Promise<string | null>
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
