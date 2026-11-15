import type {
  AgentSessionId,
  ArtifactHash,
  CachedIssue,
  ClankerProject,
  ClaudeMode,
  ClaudeStatus,
  Connection,
  ConnectionProvider,
  Event,
  GitHubPatForm,
  NewProject,
  ProjectId,
  QueueEntry,
  RecipeStatus,
  RecipeTestResult,
  Repo,
  RepoId,
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

/** Un repo registrado con lo que hay de su receta y cómo salió su última prueba (`null` si nunca se probó). */
export interface RepoRow {
  repo: Repo
  recipe: RecipeStatus
  lastTest: { ok: boolean; at: number } | null
}

// De dónde saca datos la UI y a quién le pide acciones. Los dominios son los del contrato de
// `@clanker/api`. `createCoreAppData` habla con el core; `createMemoryAppData` sirve datos de ejemplo
// para desarrollar sin core. Todo lo que falla rechaza con un `Error` cuyo mensaje se muestra tal cual.
export interface AppData {
  projects(): Promise<ClankerProject[]>
  createProject(input: NewProject): Promise<ClankerProject>
  /** Las issues del caché del proyecto. */
  issues(projectId: ProjectId): Promise<CachedIssue[]>
  /** La cola del proyecto, calculada por el core: ready primero, luego waiting y blocked, cada una con su motivo. */
  queue(projectId: ProjectId): Promise<QueueEntry[]>
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
  /** Pausa la corrida (con `now`, interrumpe a sus agentes y retoman su sesión al reanudar). Devuelve la corrida como quedó. */
  pauseRun(id: RunId, opts?: { now?: boolean }): Promise<RunDetail>
  resumeRun(id: RunId): Promise<RunDetail>
  /** Cancela la corrida y sus hijas: no se puede deshacer. */
  cancelRun(id: RunId): Promise<RunDetail>
  /** Detiene lo que la corrida tiene en marcha con su sesión guardada: `resumeRun` la retoma. */
  interruptRun(id: RunId): Promise<RunDetail>
  /** El nodo del paso corre de nuevo como una visita nueva con sesión nueva, y lo que la corrida tenía en marcha se cancela. */
  retryStep(stepId: StepRunId): Promise<RunDetail>
  /** Le deja un mensaje al agente del paso y retoma su sesión con él. */
  steerStep(stepId: StepRunId, message: string): Promise<RunDetail>
  /** Sigue el edge de `outcome` sin ejecutar el paso: solo pasos action y wait. */
  forceOutcome(stepId: StepRunId, outcome: string): Promise<RunDetail>
  /** El Scheduler deja de lanzar sus issues; lo que ya corre sigue. */
  pauseProject(id: ProjectId): Promise<ClankerProject>
  resumeProject(id: ProjectId): Promise<ClankerProject>
  /**
   * Eventos con `seq > after` (los que ya están y después los nuevos, sin duplicados) hasta que `signal`
   * se aborta. La promesa resuelve cuando la conexión está abierta.
   */
  events(after: number, signal: AbortSignal): Promise<AsyncIterable<Event>>
  prs(force: boolean): Promise<PRsResult>
  /** Las cuentas conectadas, sin tokens. */
  connections(): Promise<Connection[]>
  /** El link prellenado del formulario del PAT y la lista de permisos que necesita. */
  githubPatForm(): Promise<GitHubPatForm>
  /** Valida el PAT contra GitHub y lo conecta; el mensaje del rechazo dice qué cambiar. */
  setGithubPat(token: string): Promise<Connection>
  /** Inicia el login de Linear y devuelve el link para el navegador: lo abre el host y la cuenta aparece sola (`connection.changed`). */
  linearAuth(): Promise<string>
  /** Una llamada mínima a Claude: gasta un poco de cuota, así que solo la pide una persona o el refresco espaciado del plan. */
  testClaude(mode?: ClaudeMode): Promise<ClaudeStatus>
  /** La prueba antes de guardar: una key rechazada no queda guardada. */
  setClaudeApiKey(key: string): Promise<Connection>
  disconnect(provider: ConnectionProvider, account: string): Promise<void>
  repos(): Promise<RepoRow[]>
  /** Corre la receta del repo en un worktree desechable y vuelve al terminar; la salida llega mientras tanto como eventos `recipe.test_output`. */
  testRecipe(repoId: RepoId): Promise<RecipeTestResult>
  /** Registra el checkout de `path` (la raíz de un repo de git). */
  addRepo(path: string): Promise<Repo>
}

const AppDataContext = createContext<AppData | null>(null)
export const AppDataProvider = AppDataContext.Provider

export function useAppData(): AppData {
  const data = useContext(AppDataContext)
  if (!data) throw new Error("useAppData fuera de AppDataProvider")
  return data
}
