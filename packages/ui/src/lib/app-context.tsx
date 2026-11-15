import type { CachedIssue, ClankerProject, DecisionId, RunId } from "@clanker/api"
import { createContext, useContext } from "react"

// Acciones globales: las usan los menús contextuales, la paleta ⌘K y los atajos.
export interface AppActions {
  selectProject: (slug: string) => void
  openRun: (slug: string, runId: RunId) => void
  /** Abre la decisión en la bandeja (`/inbox/:decision`). */
  openDecision: (id: DecisionId) => void
  openNewProject: () => void
  /** Lanza el flujo del proyecto sobre la issue y avisa el resultado con un toast. */
  startRun: (project: ClankerProject, issue: CachedIssue) => Promise<void>
  refresh: () => void
  goConnections: () => void
  /** Va a Conexiones e inicia el login de Linear en el navegador. */
  connectLinear: () => void
  /** Va a Conexiones, prueba Claude y avisa el resultado con un toast. */
  testClaude: () => Promise<void>
}

export const AppActionsContext = createContext<AppActions | null>(null)

export function useAppActions(): AppActions {
  const ctx = useContext(AppActionsContext)
  if (!ctx) throw new Error("useAppActions fuera de AppActionsContext")
  return ctx
}
