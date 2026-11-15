import type {
  AgentSessionId,
  ArtifactHash,
  CachedIssue,
  ClankerProject,
  Event,
  NewProject,
  ProjectId,
  Run,
  RunDetail,
  RunFilter,
  RunId,
  StartRun,
  StepDetail,
  StepRunId,
  TranscriptPage,
} from "@clanker/api"
import { createContext, useContext } from "react"
import type { PRsResult } from "@/types"

// De dónde saca datos la UI y a quién le pide acciones. Los dominios son los del contrato de
// `@clanker/api`. `createCoreAppData` habla con el core; `createMemoryAppData` sirve datos de ejemplo
// para desarrollar sin core. Todo lo que falla rechaza con un `Error` cuyo mensaje se muestra tal cual.
export interface AppData {
  projects(): Promise<ClankerProject[]>
  createProject(input: NewProject): Promise<ClankerProject>
  /** Las issues del caché del proyecto. */
  issues(projectId: ProjectId): Promise<CachedIssue[]>
  /** De la más reciente a la más antigua, sin pasos. */
  runs(filter?: RunFilter): Promise<Run[]>
  run(id: RunId): Promise<RunDetail>
  /** Sesiones, artefactos y comandos de un paso: lo que su panel muestra y `run` no trae. */
  step(id: StepRunId): Promise<StepDetail>
  /** Una página del transcript de una sesión de agente, desde el `next` de la anterior (0 para empezar). */
  transcript(sessionId: AgentSessionId, cursor: number): Promise<TranscriptPage>
  /** El contenido de un artefacto como texto. */
  artifact(hash: ArtifactHash): Promise<string>
  /** Vuelve sin esperar: el progreso llega por `events`. */
  startRun(input: StartRun): Promise<RunDetail>
  /**
   * Eventos con `seq > after` (los que ya están y después los nuevos, sin duplicados) hasta que `signal`
   * se aborta. La promesa resuelve cuando la conexión está abierta.
   */
  events(after: number, signal: AbortSignal): Promise<AsyncIterable<Event>>
  prs(force: boolean): Promise<PRsResult>
}

const AppDataContext = createContext<AppData | null>(null)
export const AppDataProvider = AppDataContext.Provider

export function useAppData(): AppData {
  const data = useContext(AppDataContext)
  if (!data) throw new Error("useAppData fuera de AppDataProvider")
  return data
}
