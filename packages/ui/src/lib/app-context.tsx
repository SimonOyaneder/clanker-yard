import { createContext, useContext } from "react"
import type { Loop } from "@/types"

// Acciones globales: las usan el header del loop, el click derecho de la sidebar y la paleta ⌘K.
export interface AppActions {
  selectLoop: (slug: string) => void
  openIssue: (slug: string, issueId: string) => void
  setArchived: (loop: Loop, archived: boolean) => void
  requestStop: (loop: Loop) => void
  resume: (loop: Loop) => Promise<boolean>
  run: (loop: Loop) => Promise<boolean>
  watch: (loop: Loop) => Promise<boolean>
  openLinear: (loop: Loop) => void
  openNewLoop: () => void
  refresh: () => void
}

export const AppActionsContext = createContext<AppActions | null>(null)

export function useAppActions(): AppActions {
  const ctx = useContext(AppActionsContext)
  if (!ctx) throw new Error("useAppActions fuera de AppActionsContext")
  return ctx
}

export const isRunning = (l: Loop) => l.status === "activo" || l.status === "vigilando"

export function lastSession(l: Loop) {
  return [...l.sessions].sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""))[0] ?? null
}
