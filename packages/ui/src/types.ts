// Lo que la UI muestra. Más adelante estos tipos salen del contrato de `@clanker/api`.

export type LoopStatus = "activo" | "vigilando" | "dormido" | "terminado"

export type MemberStatus = "trabajando" | "esperando" | "listo" | "en cola" | "sin señal"

export type StepStatus = "done" | "current" | "todo"

export interface ToolCall {
  ts: string
  tool: string
  detail: string
}

export interface Member {
  role: string
  model: string | null
  effort: string | null
  status: MemberStatus
  runs: number
  lastAction: ToolCall | null
  lastActivity: string | null
  startedAt: string | null
  usd: number
  tokens: number
}

export interface Step {
  key: string
  label: string
  status: StepStatus
}

export interface CheckpointLine {
  step: string
  text: string
}

export interface Slot {
  slot: string
  issueId: string
  title: string | null
  profile: string | null
  repo: string | null
  branch: string | null
  base: string | null
  worktree: string | null
  startedAt: string | null
  minutes: number | null
  usd: number
  steps: Step[]
  team: Member[]
}

export interface HistoryRow {
  issueId: string
  title: string | null
  estado: string
  perfil: string
  pr: string
  prUrl: string | null
  branch: string
  minutes: number | null
  usd: number | null
  column: BoardColumn
}

export type BoardColumn = "abierto" | "aprobado" | "mergeado" | "problema"

export interface Decision {
  issueId: string | null
  pr: string | null
  text: string
  pending: boolean
}

export type FeedKind =
  | "lanzó"
  | "listo"
  | "aviso"
  | "falló"
  | "restack"
  | "merge"
  | "cola"
  | "evento"

export interface FeedItem {
  ts: string
  kind: FeedKind
  text: string
}

export interface WatchPR {
  key: string
  approved: boolean
  merged: boolean
  queuefail: boolean
}

export interface SessionInfo {
  id: string
  cwd: string | null
  lastActivity: string | null
}

export interface AgentInfo {
  id: string | null
  sessionId: string
  kind: "background" | "interactive"
  pid: number | null
  name: string | null
  cwd: string | null
  state: string | null
  status: string | null
}

export interface RepoOption {
  name: string
  path: string
  trusted: boolean
}

export interface AppConfig {
  profiles: string[]
  defaultProfile: string | null
  repos: RepoOption[]
  models: string[]
  efforts: string[]
  // Lo que usaría `claude` sin flags, según ~/.claude/settings.json.
  defaultModel: string | null
  defaultEffort: string | null
}

export type LoopMode = "run" | "dry-run" | "watch"

export interface NewLoopInput {
  project: string
  cwd: string
  parallel: number
  profile: string | null
  only: string | null
  mode: LoopMode
  model: string | null
  effort: string | null
}

export interface QueueItem {
  id: string
  title: string | null
  priority: number | null
  repo: string | null
  base: string | null
  bloqueos: string | null
}

export interface LoopSummary {
  slug: string
  title: string
  totalUsd: number
  emUsd: number
  teamsUsd: number
  issuesRecorded: number
  results: { result: string; count: number }[]
  prs: { abierto: number; aprobado: number; mergeado: number; problema: number }
  agentMinutes: number
  avgMinutes: number | null
  avgUsd: number | null
  rounds: { review: number | null; bot: number | null; botValid: number; botFp: number; ciFails: number }
  byRole: { role: string; usd: number; tokens: number }[]
  byModel: { model: string; usd: number }[]
  byDay: { day: string; usd: number; issues: number }[]
  topIssues: { issueId: string; title: string | null; usd: number; minutes: number | null; result: string; pr: string | null }[]
  firstTs: string | null
  lastTs: string | null
  decisions: { total: number; pending: number }
  omitted: number
}

export interface Loop {
  slug: string
  title: string
  archived: boolean
  projectUrl: string | null
  repos: string | null
  status: LoopStatus
  lastActivity: string | null
  sessions: SessionInfo[]
  agent: AgentInfo | null
  // Modo de permisos con que corre (o corrió) el EM, según su transcript.
  permissionMode: string | null
  slots: Slot[]
  history: HistoryRow[]
  decisions: Decision[]
  omitted: string[]
  feed: FeedItem[]
  queue: { ts: string; text: string; next: string[] } | null
  queueItems: QueueItem[] | null
  watch: WatchPR[]
  todayUsd: number
  todayIssues: number
}

export interface PlanUsage {
  fiveHour: { pct: number; resetsAt: string | null } | null
  sevenDay: { pct: number; resetsAt: string | null } | null
  // Cuándo lo escribió la status line por última vez.
  updatedAt: string
}

export interface Snapshot {
  generatedAt: string
  loops: Loop[]
  planUsage: PlanUsage | null
  // Sesiones `clanker · …` en background que todavía no tienen state (recién lanzadas).
  starting: AgentInfo[]
}

export interface IssueDetail {
  project: string
  issueId: string
  title: string | null
  slot: Slot | null
  history: HistoryRow | null
  checkpoint: CheckpointLine[]
  steps: Step[]
  team: Member[]
  tails: Record<string, ToolCall[]>
  usd: number
  tokens: number
  minutes: number | null
  decisions: Decision[]
}

export interface Launched {
  id: string | null
  name: string
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: string }

// ─── Stacks de PR (portado de stack-pr) ─────────────────────────────

export type PRState = "open" | "draft" | "merged" | "closed"
export type CIStatus = "success" | "failure" | "pending" | "neutral" | "skipped" | "unknown"
export type ReviewDecision = "approved" | "changes_requested" | "review_required" | "none"
export type ReviewerStateKind = "approved" | "changes_requested" | "commented" | "pending"

export interface ReviewerState {
  login: string
  avatarUrl: string | null
  state: ReviewerStateKind
}

export type PRRisk = "high" | "mid" | "low"

export interface PRLabel {
  name: string
  color: string // hex sin "#", tal cual GitHub
  description: string | null
}

export interface PullRequest {
  id: number
  number: number
  title: string
  state: PRState
  url: string
  repoName: string
  repoFullName: string
  defaultBranch: string
  headRef: string
  baseRef: string
  author: { login: string; avatarUrl: string }
  createdAt: string
  updatedAt: string
  comments: number
  unresolvedThreads: number
  additions: number
  deletions: number
  changedFiles: number
  reviewerStates: ReviewerState[]
  // Último review de review-bot (el bot): su LGTM importa aunque no sea un humano.
  botReview: "approved" | "commented" | "changes_requested" | null
  reviewDecision: ReviewDecision
  ciStatus: CIStatus
  isDraft: boolean
  labels: PRLabel[]
  // Riesgo que puso el bot de review (/review) como label risk:low|mid|high.
  risk: PRRisk | null
  // PR que dejó un clanker-loop: de qué loop e issue viene.
  clanker: { slug: string; loop: string; issueId: string } | null
  // Misma regla que el vigilante del clanker-loop para "listo-para-merge".
  merge: {
    ready: boolean
    blockers: string[]
    finMerge: "queued" | "failed" | null
  }
}

export interface PRsResult {
  viewer: { login: string; avatarUrl: string }
  prs: PullRequest[]
  fetchedAt: string
  // Abiertos según GitHub; si es mayor que prs.length, hay PRs que no trajimos.
  total: number
  // Cuota de GraphQL (5.000 puntos por hora, compartida con gh y el vigilante).
  rate: { remaining: number; limit: number; cost: number; resetAt: string } | null
  // Si estamos sirviendo el cache para no gastar cuota, hasta cuándo.
  pausedUntil: string | null
}
