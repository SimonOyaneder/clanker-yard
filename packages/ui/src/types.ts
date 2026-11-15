// Stacks de PR (portado de stack-pr). Todavía no salen del contrato de `@clanker/api`: el core no sirve PRs.

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
