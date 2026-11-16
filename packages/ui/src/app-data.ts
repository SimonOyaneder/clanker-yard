import type {
  AgentSessionId,
  ArtifactHash,
  Breaker,
  CachedIssue,
  CachedPr,
  ClankerProject,
  ClaudeMode,
  ClaudeStatus,
  Connection,
  ConnectionProvider,
  DayMetrics,
  DefRecord,
  Decision,
  DecisionFilter,
  DecisionId,
  Event,
  GitHubDeviceFlow,
  GitHubInstallations,
  GitHubPatForm,
  IssueId,
  IssueMetrics,
  Lanes,
  Learning,
  LearningId,
  LearningPatch,
  ModelMetrics,
  NewProject,
  PrRef,
  ProjectId,
  ProjectPatch,
  ProjectSummary,
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
  StepMetrics,
  StepRunId,
  TranscriptPage,
} from "@clanker/api"
import { createContext, useContext } from "react"

/** Un repo registrado con lo que hay de su receta y cómo salió su última prueba (`null` si nunca se probó). */
export interface RepoRow {
  repo: Repo
  recipe: RecipeStatus
  lastTest: { ok: boolean; at: number } | null
}

/** El rango (ms epoch, `to` exclusivo) y el origen que acotan las métricas de un proyecto: los de `MetricsFilter`. */
export interface MetricsRange {
  from?: number
  to?: number
  /** `true` solo las corridas importadas del clanker-loop; `false` solo las de Yard. */
  imported?: boolean
}

/** Lo que muestra el Resumen de un proyecto: todo acotado por el mismo rango y origen, menos `roles`. */
export interface ProjectMetrics {
  summary: ProjectSummary
  byDay: DayMetrics[]
  byModel: ModelMetrics[]
  byStep: StepMetrics[]
  byIssue: IssueMetrics[]
  /** Todos los roles que gastaron algo en el proyecto, sin acotar y ordenados: les fija el color a cada uno aunque el rango deje fuera a otros. */
  roles: string[]
}

// De dónde saca datos la UI y a quién le pide acciones. Los dominios son los del contrato de
// `@clanker/api`. `createCoreAppData` habla con el core; `createMemoryAppData` sirve datos de ejemplo
// para desarrollar sin core. Todo lo que falla rechaza con un `Error` cuyo mensaje se muestra tal cual.
export interface AppData {
  projects(): Promise<ClankerProject[]>
  createProject(input: NewProject): Promise<ClankerProject>
  updateProject(id: ProjectId, patch: ProjectPatch): Promise<ClankerProject>
  /** Saca la issue de la cola (`skipped`) o la devuelve. */
  skipIssue(projectId: ProjectId, issueId: IssueId, skipped: boolean): Promise<void>
  /** Sube la issue al principio de la cola o la devuelve a su lugar. */
  boostIssue(projectId: ProjectId, issueId: IssueId, boosted: boolean): Promise<void>
  /** La capacidad de cada carril de la máquina y cuánto está en uso. */
  lanes(): Promise<Lanes>
  /** Los circuit breakers abiertos: qué está en pausa y cuándo se vuelve a probar. */
  breakers(): Promise<Breaker[]>
  /** Los PRs abiertos que Watch conoce (los que abrió el sistema y los de tu búsqueda), con su estado ya leído y las señales de su pack. */
  openPrs(): Promise<CachedPr[]>
  /** Relee cada PR de GitHub y deja el estado en el caché: los cambios llegan después por `events` como `pr.changed`. */
  refreshPrs(refs: PrRef[]): Promise<void>
  /** Marca o desmarca "no mergear nunca". */
  setPrHold(ref: PrRef, hold: boolean): Promise<void>
  /** Mergea según la estrategia del pack (comenta su comando); el core rechaza si el PR ya no está listo. */
  mergePr(ref: PrRef): Promise<void>
  /** Le pide review al bot del pack. */
  requestPrReview(ref: PrRef): Promise<void>
  /** Arranca el rebase del PR en el carril de mantenimiento; la corrida aparece en el proyecto que lo abrió. */
  rebasePr(ref: PrRef): Promise<void>
  /** Las issues del caché del proyecto. */
  issues(projectId: ProjectId): Promise<CachedIssue[]>
  /** La cola del proyecto, calculada por el core: ready primero, luego waiting y blocked, cada una con su motivo. */
  queue(projectId: ProjectId): Promise<QueueEntry[]>
  /** Las métricas del proyecto para su Resumen; los días son del huso de la máquina. */
  projectMetrics(projectId: ProjectId, range: MetricsRange): Promise<ProjectMetrics>
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
  /** La bandeja, de la más reciente a la más antigua; sin filtro trae también las resueltas. */
  decisions(filter?: DecisionFilter): Promise<Decision[]>
  /**
   * Resuelve una decisión con una de sus opciones (o con un texto libre si no bloquea). En un gate o un
   * `needs_human` la corrida estacionada vuelve a la cola de su carril.
   */
  resolveDecision(id: DecisionId, option: string): Promise<Decision>
  /** Todos los learnings, de cualquier estado, del más reciente al más antiguo: la UI filtra y cuenta. */
  learnings(): Promise<Learning[]>
  /** Un `proposed`, `rejected` o `archived` pasa a `approved` y entra a los briefs de su alcance. Solo la app puede (origin `ui`). */
  approveLearning(id: LearningId): Promise<Learning>
  /** Un `proposed` queda `rejected` y un `approved` queda `archived` (se retira). */
  rejectLearning(id: LearningId): Promise<Learning>
  /** Cambia texto, roles o tags; el alcance y el estado no se editan. Uno aprobado solo lo edita la app. */
  updateLearning(patch: LearningPatch): Promise<Learning>
  /** Las cuentas conectadas, sin tokens. */
  connections(): Promise<Connection[]>
  /** El link prellenado del formulario del PAT y la lista de permisos que necesita. */
  githubPatForm(): Promise<GitHubPatForm>
  /** Valida el PAT contra GitHub y lo conecta; el mensaje del rechazo dice qué cambiar. */
  setGithubPat(token: string): Promise<Connection>
  /** Inicia el device flow de la GitHub App: devuelve el código para escribir en github.com; la cuenta aparece sola (`connection.changed`) al aprobar. */
  startGithubDeviceFlow(): Promise<GitHubDeviceFlow>
  /** Cuántas instalaciones de la GitHub App ve el token de la cuenta conectada con la App; con cero, los repos salen vacíos. */
  githubInstallations(): Promise<GitHubInstallations>
  /** Inicia el login de Linear y devuelve el link para el navegador: lo abre el host y la cuenta aparece sola (`connection.changed`). */
  linearAuth(): Promise<string>
  /** Una llamada mínima a Claude: gasta un poco de cuota, así que solo la pide una persona o el refresco espaciado del plan. */
  testClaude(mode?: ClaudeMode): Promise<ClaudeStatus>
  /** La prueba antes de guardar: una key rechazada no queda guardada. */
  setClaudeApiKey(key: string): Promise<Connection>
  disconnect(provider: ConnectionProvider, account: string): Promise<void>
  /** Los flujos o perfiles vigentes, con su versión vigente: de ahí salen los parámetros con default y las opciones de Ajustes. */
  defs(kind: "flow" | "profile"): Promise<DefRecord[]>
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
