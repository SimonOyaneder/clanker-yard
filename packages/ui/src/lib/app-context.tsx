import type { CachedIssue, ClankerProject, DecisionId, Lane, RunId } from "@clanker/api"
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
  /** Cambia cuántas corridas del carril dev puede tener el proyecto a la vez. */
  setParallel: (project: ClankerProject, parallel: number) => Promise<void>
  /** Cambia cuántas corridas caben en un carril de la máquina (`from` es la capacidad de antes, para deshacer). */
  setLanes: (lane: Lane, capacity: number, from: number) => Promise<void>
  /** Saca la issue de la cola (`skipped`) o la devuelve; el toast permite deshacerlo. */
  skipIssue: (project: ClankerProject, issue: CachedIssue, skipped: boolean) => Promise<void>
  /** La sube al principio de la cola; el toast permite deshacerlo. */
  boostIssue: (project: ClankerProject, issue: CachedIssue) => Promise<void>
  /** Abre Ajustes del proyecto en la sección de filtros de la cola. */
  editQueueFilters: () => void
  /** Abre Ajustes del proyecto en Flujo y parámetros, donde se elige el flujo y el perfil por defecto. */
  editFlow: () => void
  openExternal: (url: string) => void
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
