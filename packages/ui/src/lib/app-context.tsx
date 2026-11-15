import type { CachedIssue, ClankerProject, RunId } from "@clanker/api"
import { createContext, useContext } from "react"

// Acciones globales: las usan los menús contextuales, la paleta ⌘K y los atajos.
export interface AppActions {
  selectProject: (slug: string) => void
  openRun: (slug: string, runId: RunId) => void
  openNewProject: () => void
  /** Lanza el flujo del proyecto sobre la issue y avisa el resultado con un toast. */
  startRun: (project: ClankerProject, issue: CachedIssue) => Promise<void>
  refresh: () => void
}

export const AppActionsContext = createContext<AppActions | null>(null)

export function useAppActions(): AppActions {
  const ctx = useContext(AppActionsContext)
  if (!ctx) throw new Error("useAppActions fuera de AppActionsContext")
  return ctx
}
