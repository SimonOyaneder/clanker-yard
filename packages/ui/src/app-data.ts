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
  AgentOptions,
  DayMetrics,
  DefExported,
  DefKind,
  DefRecord,
  DefWrite,
  DefWriteKind,
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
  LanesPatch,
  Learning,
  LearningId,
  LearningPatch,
  NewLearning,
  LearningVerdict,
  LocalPrDetail,
  ModelMetrics,
  NewProject,
  PackInfo,
  PrRef,
  ProjectConfig,
  ProjectDefaults,
  ProjectDefaultsPatch,
  ProjectId,
  ProjectImportResult,
  ProjectPatch,
  ProjectSummary,
  QueueEntry,
  RecipeTestResult,
  Repo,
  RepoConfigSync,
  RepoOverview,
  RepoId,
  Run,
  RunDetail,
  RunFilter,
  RunId,
  StartRun,
  StepDetail,
  StepMetrics,
  StepRunId,
  TrackerId,
  TrackerProject,
  TranscriptPage,
} from "@clanker/api"
import { createContext, useContext } from "react"

/** Un repo registrado con lo que hay de su receta y cómo salió su última prueba: `repos.overview` del core. */
export type RepoRow = RepoOverview

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
  updateProject(input: { id: ProjectId } & ProjectPatch): Promise<ClankerProject>
  /** Saca la issue de la cola (`skipped`) o la devuelve. */
  skipIssue(input: { id: ProjectId; issueId: IssueId; skipped: boolean }): Promise<void>
  /** Sube la issue al principio de la cola o la devuelve a su lugar. */
  boostIssue(input: { id: ProjectId; issueId: IssueId; boosted: boolean }): Promise<void>
  /** La capacidad de cada carril de la máquina y cuánto está en uso. */
  lanes(): Promise<Lanes>
  /** Cambia la capacidad de los carriles de la máquina; rige al instante y nunca interrumpe lo que corre. */
  setLanes(patch: LanesPatch): Promise<Lanes>
  /** Lo que un proyecto nuevo toma si no se pide otra cosa: flujo, perfil, corridas en paralelo y tope de gasto. */
  projectDefaults(): Promise<ProjectDefaults>
  /** Cambia los defaults de proyectos nuevos; lo que no se pasa no cambia, rige sin reiniciar el core y no toca los proyectos que ya existen. */
  setProjectDefaults(patch: ProjectDefaultsPatch): Promise<ProjectDefaults>
  /** Los packs activos (reglas de una organización) con su versión, su alcance y si vienen con la app. */
  packs(): Promise<PackInfo[]>
  /** Instala (o actualiza) el pack de una carpeta; rige sin reiniciar el core. El mensaje del rechazo dice qué archivo y campo fallan. */
  installPack(path: string): Promise<PackInfo>
  /** Quita un pack instalado; uno que viene con la app no se puede quitar. */
  removePack(id: string): Promise<void>
  /** Dónde guarda el core sus datos, con qué client_id de Linear se conecta y si tiene configurada la GitHub App. */
  coreInfo(): Promise<{ dataDir: string; linearClientId: string; githubApp: boolean }>
  /** Los circuit breakers abiertos: qué está en pausa y cuándo se vuelve a probar. */
  breakers(): Promise<Breaker[]>
  /** Los PRs abiertos que Watch conoce (los que abrió el sistema y los de tu búsqueda), con su estado ya leído y las señales de su pack. */
  openPrs(): Promise<CachedPr[]>
  /** Relee cada PR de GitHub y deja el estado en el caché: los cambios llegan después por `events` como `pr.changed`. */
  refreshPrs(refs: PrRef[]): Promise<void>
  /** Marca o desmarca "no mergear nunca". */
  setPrHold(input: { ref: PrRef; hold: boolean }): Promise<void>
  /** Mergea según la estrategia del pack (comenta su comando); el core rechaza si el PR ya no está listo. */
  mergePr(ref: PrRef): Promise<void>
  /** Le pide review al bot del pack. */
  requestPrReview(ref: PrRef): Promise<void>
  /** Arranca el rebase del PR en el carril de mantenimiento; la corrida aparece en el proyecto que lo abrió. */
  rebasePr(ref: PrRef): Promise<void>
  /** Publica ya en GitHub un PR local (por su id): sale apilado sobre su padre; la corrida aparece en el proyecto que lo abrió. */
  publishLocalPr(id: string): Promise<void>
  /** Lo que se ve de un PR local sin GitHub (descripción, commits y diff contra su base), leído del repo. */
  localPrDetail(id: string): Promise<LocalPrDetail>
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
  steerStep(input: { stepId: StepRunId; message: string }): Promise<RunDetail>
  /** Sigue el edge de `outcome` sin ejecutar el paso: solo pasos action y wait. */
  forceOutcome(input: { stepId: StepRunId; outcome: string }): Promise<RunDetail>
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
  resolveDecision(input: { id: DecisionId; option: string }): Promise<Decision>
  /** Deja un learning de una persona en `proposed`; si el mismo texto ya existe en ese alcance devuelve el que había, sea cual sea su estado. */
  proposeLearning(learning: NewLearning): Promise<Learning>
  /** Todos los learnings, de cualquier estado, del más reciente al más antiguo: la UI filtra y cuenta. */
  learnings(): Promise<Learning[]>
  /** Un `proposed`, `rejected` o `archived` pasa a `approved` y entra a los briefs de su alcance. Solo la app puede (origin `ui`). */
  approveLearning(id: LearningId): Promise<Learning>
  /** Un `proposed` queda `rejected` y un `approved` queda `archived` (se retira). */
  rejectLearning(id: LearningId): Promise<Learning>
  /** Cambia texto, roles o tags; el alcance y el estado no se editan. Uno aprobado solo lo edita la app. */
  updateLearning(patch: LearningPatch): Promise<Learning>
  /** Revisa con el criterio los propuestos por agentes (un agente barato): un veredicto con su razón por cada uno, sin cambiar nada. */
  screenLearnings(): Promise<LearningVerdict[]>
  /** Los `proposed` pasan a `archived`: no entran a ningún brief y se pueden volver a aprobar. */
  archiveLearnings(ids: LearningId[]): Promise<Learning[]>
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
  disconnect(input: { provider: ConnectionProvider; account: string }): Promise<void>
  /** Las defs vigentes del kind, cada una con su versión vigente (de ahí salen los parámetros con default y las opciones de Ajustes); con `includeArchived` también las archivadas. Puede haber varias con el mismo slug: una por scope. */
  defs(kind: DefKind, opts?: { includeArchived?: boolean }): Promise<DefRecord[]>
  /** Los modelos y esfuerzos que el runtime acepta en un perfil: los da el core, la UI no los lista. */
  agentOptions(): Promise<AgentOptions>
  /** Todas las versiones de la def, de la más nueva a la más vieja, cada una con su body. */
  defVersions(kind: DefWriteKind, id: string): Promise<DefRecord[]>
  /** Crea una def tuya (scope `user`) con ese slug y ese body; si el slug es de un incluido o de un pack, la tuya pasa a mandar. */
  createDef(input: { kind: DefWriteKind; slug: string; body: unknown }): Promise<DefRecord>
  /**
   * Reemplaza el body de una def tuya y crea una versión nueva (las corridas en curso siguen con la suya). Con `dryRun`
   * no guarda nada: devuelve los errores del core (`errors`, cada uno con su ruta) y el diff contra la versión vigente.
   */
  updateDef(input: { kind: DefWriteKind; id: string; body: unknown; dryRun: boolean }): Promise<DefWrite>
  /** La def deja de resolverse por slug pero conserva sus versiones. Solo las tuyas y las del repo. */
  archiveDef(input: { kind: DefWriteKind; id: string }): Promise<DefRecord>
  restoreDef(input: { kind: DefWriteKind; id: string }): Promise<DefRecord>
  /** Los proyectos del tracker de las cuentas conectadas, los de la persona primero. Rechaza (con el paso a seguir) si no hay cuenta conectada. */
  trackerProjects(tracker: TrackerId): Promise<TrackerProject[]>
  repos(): Promise<RepoRow[]>
  /** Corre la receta del repo en un worktree desechable y vuelve al terminar; la salida llega mientras tanto como eventos `recipe.test_output`. */
  testRecipe(repoId: RepoId): Promise<RecipeTestResult>
  /** Registra el checkout de `path` (la raíz de un repo de git). */
  addRepo(path: string): Promise<Repo>
  /** "Exportar al repo": abre un PR en draft que agrega la def tuya al `.clanker/` del repo. Rechaza con lo que hay que cambiar (la def no es tuya, el repo no tiene cuenta de GitHub, ya está igual). */
  exportDefToRepo(input: { kind: DefWriteKind; id: string; repoId: RepoId }): Promise<DefExported>
  /** Vuelve a leer `.clanker/` de la branch por defecto del repo y actualiza lo que el repo trae. */
  syncRepoConfig(repoId: RepoId): Promise<RepoConfigSync>
  /** La configuración del proyecto como archivo, para llevarla a otra máquina o proyecto. */
  exportProjectConfig(projectId: ProjectId): Promise<ProjectConfig>
  /** Aplica una configuración exportada al proyecto; con `dryRun` solo dice qué cambiaría y qué no se pudo mapear. */
  importProjectConfig(input: { projectId: ProjectId; config: unknown; dryRun: boolean }): Promise<ProjectImportResult>
}

const AppDataContext = createContext<AppData | null>(null)
export const AppDataProvider = AppDataContext.Provider

export function useAppData(): AppData {
  const data = useContext(AppDataContext)
  if (!data) throw new Error("useAppData fuera de AppDataProvider")
  return data
}
