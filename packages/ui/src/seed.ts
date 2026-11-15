import type {
  AgentInfo,
  AppConfig,
  FeedItem,
  HistoryRow,
  Loop,
  LoopStatus,
  Member,
  MemberStatus,
  PlanUsage,
  PRRisk,
  PRsResult,
  PullRequest,
  QueueItem,
  Slot,
  Snapshot,
  Step,
  ToolCall,
} from "@/types"

// Datos de ejemplo para desarrollar la UI sin core. Todo cuelga de `now`, así "hace 2 min" se ve
// igual cada vez que se abre y los tests no dependen del reloj.

export interface Seed {
  snapshot: Snapshot
  prs: PRsResult
  config: AppConfig
}

const STEP_LABELS = ["Contexto", "Worktree", "Plan", "Dev", "Review", "PR draft", "Bot + CI", "Cierre"] as const
const STEP_KEYS = ["contexto", "worktree", "plan", "dev", "review", "pr", "bot", "cierre"] as const

// `current` = índice del paso en curso; -1 si ya terminó todo.
function stepsAt(current: number): Step[] {
  return STEP_KEYS.map((key, i) => ({
    key,
    label: STEP_LABELS[i]!,
    status: current === -1 || i < current ? "done" : i === current ? "current" : "todo",
  }))
}

export function buildSeed(now: number): Seed {
  const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString()
  const min = (m: number) => m * 60

  const call = (secondsAgo: number, tool: string, detail: string): ToolCall => ({ ts: at(secondsAgo), tool, detail })

  const member = (role: string, status: MemberStatus, o: Partial<Member> = {}): Member => ({
    role,
    model: role === "techlead" ? "opus" : "sonnet",
    effort: role === "techlead" ? "high" : "medium",
    status,
    runs: status === "en cola" ? 0 : 1,
    lastAction: null,
    lastActivity: null,
    startedAt: status === "en cola" ? null : at(min(20)),
    usd: 0,
    tokens: 0,
    ...o,
  })

  // ─── Slots en curso de "Boundaries de engines" ─────────────────────────────

  const slot1Team: Member[] = [
    member("techlead", "esperando", { usd: 2.41, tokens: 410_000, runs: 1, lastActivity: at(40), lastAction: call(40, "Agent", "review-bugs: revisa el diff contra origin/main") }),
    member("dev", "listo", { usd: 3.12, tokens: 640_000, runs: 2, lastActivity: at(min(9)), lastAction: call(min(9), "Bash", "bundle exec rspec engines/ledger") }),
    member("review-bugs", "trabajando", { usd: 0.64, tokens: 98_000, lastActivity: at(8), lastAction: call(8, "Read", "engines/ledger/app/services/post_entry.rb") }),
    member("review-tests", "trabajando", { usd: 0.38, tokens: 61_000, lastActivity: at(14), lastAction: call(14, "Grep", "describe PostEntry") }),
    member("review-patterns", "listo", { usd: 0.41, tokens: 72_000, lastActivity: at(min(2)), lastAction: call(min(2), "Read", "AGENTS.md") }),
    member("review-lore", "listo", { usd: 0.22, tokens: 38_000, lastActivity: at(min(3)), lastAction: call(min(3), "Grep", "lore/boundaries") }),
    member("committer", "en cola"),
    member("bot-reviewer", "en cola"),
  ]
  const slot2Team: Member[] = [
    member("techlead", "esperando", { usd: 0.55, tokens: 92_000, lastActivity: at(min(1)), lastAction: call(min(1), "Agent", "dev: arma el plan del cambio") }),
    member("dev", "trabajando", { usd: 0.71, tokens: 130_000, lastActivity: at(3), lastAction: call(3, "Edit", "engines/payments/lib/payments/engine.rb") }),
    member("review-bugs", "en cola"),
    member("review-tests", "en cola"),
    member("review-patterns", "en cola"),
    member("review-lore", "en cola"),
    member("committer", "en cola"),
    member("bot-reviewer", "en cola"),
  ]

  const slots: Slot[] = [
    {
      slot: "A",
      issueId: "ENG-9178",
      title: "Separar el cálculo de comisiones",
      profile: "default",
      repo: "ledger",
      branch: "eng-9178-ledger-boundary",
      base: "main",
      worktree: "/Users/dev/work/ledger-wt/ENG-9178",
      startedAt: at(min(34)),
      minutes: 34,
      usd: slot1Team.reduce((a, m) => a + m.usd, 0),
      steps: stepsAt(4),
      team: slot1Team,
    },
    {
      slot: "B",
      issueId: "ENG-9181",
      title: "Mover PostEntry a la engine de ledger",
      profile: "ligero",
      repo: "payments-api",
      branch: "eng-9181-move-post-entry",
      base: "eng-9178-ledger-boundary",
      worktree: "/Users/dev/work/payments-api-wt/ENG-9181",
      startedAt: at(min(6)),
      minutes: 6,
      usd: slot2Team.reduce((a, m) => a + m.usd, 0),
      steps: stepsAt(3),
      team: slot2Team,
    },
  ]

  const row = (
    issueId: string,
    title: string,
    estado: string,
    pr: string,
    column: HistoryRow["column"],
    minutes: number,
    usd: number,
    perfil = "default",
  ): HistoryRow => {
    const repo = pr.split("#")[0] ?? "ledger"
    const number = pr.split("#")[1]?.split(" ")[0]
    return {
      issueId,
      title,
      estado,
      perfil,
      pr,
      prUrl: number ? `https://github.com/acme/${repo}/pull/${number}` : null,
      branch: `${issueId.toLowerCase()}-${title.toLowerCase().split(" ").slice(0, 3).join("-")}`,
      minutes,
      usd,
      column,
    }
  }

  const boundariesHistory: HistoryRow[] = [
    row("ENG-9150", "Extraer el cliente de ledger a su engine", "mergeado", "ledger#412", "mergeado", 41, 6.2),
    row("ENG-9152", "Definir la interfaz pública de PostEntry", "mergeado", "ledger#415", "mergeado", 28, 4.1),
    row("ENG-9160", "Prohibir imports cruzados entre engines", "listo-para-merge", "ledger#421", "aprobado", 52, 8.4),
    row("ENG-9163", "Renombrar Payments::Ledger a Payments::Posting", "aprobado-con-comentarios (falta renombrar un spec)", "payments-api#388", "abierto", 37, 5.6, "ligero"),
    row("ENG-9167", "Agregar checks de boundaries a CI", "PR abierto", "ledger#424", "abierto", 33, 4.9),
    row("ENG-9170", "Migrar el job de conciliación", "merge-queue-falló", "payments-api#391", "problema", 64, 11.3),
    row("ENG-9172", "Documentar los boundaries de cada engine", "mergeado", "ledger#418", "mergeado", 19, 2.2, "ligero"),
  ]

  const boundariesQueue: QueueItem[] = [
    { id: "ENG-9183", title: "Aislar los modelos de ledger detrás de un facade", priority: 2, repo: "ledger", base: "main", bloqueos: null },
    { id: "ENG-9185", title: "Quitar los últimos accesos directos a LedgerEntry", priority: 3, repo: "payments-api", base: "eng-9181-move-post-entry", bloqueos: "ENG-9181" },
    { id: "ENG-9190", title: "Guía para crear una engine nueva", priority: 4, repo: "ledger", base: "main", bloqueos: null },
  ]

  const boundariesFeed: FeedItem[] = [
    { ts: at(min(2)), kind: "evento", text: "cambios ledger#424 · @marta pidió cambios · https://github.com/acme/ledger/pull/424" },
    { ts: at(min(6)), kind: "lanzó", text: "ENG-9181 en slot B (perfil ligero)" },
    { ts: at(min(11)), kind: "evento", text: "listo-para-merge ledger#421 · https://github.com/acme/ledger/pull/421" },
    { ts: at(min(18)), kind: "falló", text: "merge-queue-falló payments-api#391 · integration-tests · https://github.com/acme/payments-api/pull/391" },
    { ts: at(min(34)), kind: "lanzó", text: "ENG-9178 en slot A (perfil default)" },
    { ts: at(min(41)), kind: "listo", text: "ENG-9167 PR ledger#424 abierto, esperando review" },
    { ts: at(min(55)), kind: "restack", text: "ledger#424 rebaseado sobre main tras el merge de ledger#418" },
    { ts: at(min(58)), kind: "merge", text: "fin-merge ledger#418 encolado" },
    { ts: at(min(70)), kind: "cola", text: "ENG-9183 siguiente, ENG-9185 bloqueada por ENG-9181" },
  ]

  const boundaries: Loop = {
    slug: "boundaries-de-engines",
    title: "Boundaries de engines",
    archived: false,
    projectUrl: "https://linear.app/acme/project/boundaries-de-engines-a1b2c3d4e5f6",
    repos: "ledger, payments-api",
    status: "activo",
    lastActivity: at(8),
    sessions: [{ id: "5f1c2d3e-aaaa-4bbb-8ccc-0123456789ab", cwd: "/Users/dev/work/ledger", lastActivity: at(8) }],
    agent: { id: "bg-7f3a", sessionId: "5f1c2d3e-aaaa-4bbb-8ccc-0123456789ab", kind: "background", pid: 41872, name: "clanker · boundaries-de-engines", cwd: "/Users/dev/work/ledger", state: "running", status: "busy" },
    permissionMode: "bypassPermissions",
    slots,
    history: boundariesHistory,
    decisions: [
      { issueId: "ENG-9170", pr: "payments-api#391", text: "PENDIENTE: merge-queue falló dos veces en integration-tests con el mismo error. Reintento una tercera vez o lo dejo para revisión humana?", pending: true },
      { issueId: "ENG-9163", pr: "payments-api#388", text: "Dejé el rename de Payments::Ledger a medias porque el spec de reconciliation todavía lo usa; lo anoto como comentario del PR.", pending: false },
      { issueId: "ENG-9152", pr: "ledger#415", text: "Usé el perfil default para esta issue por el tamaño del diff.", pending: false },
    ],
    omitted: [],
    feed: boundariesFeed,
    queue: { ts: at(min(70)), text: "3 issues en cola, 1 bloqueada", next: ["ENG-9183", "ENG-9190"] },
    queueItems: boundariesQueue,
    watch: [
      { key: "ledger#421", approved: true, merged: false, queuefail: false },
      { key: "payments-api#391", approved: false, merged: false, queuefail: true },
    ],
    todayUsd: 38.7,
    todayIssues: 4,
  }

  const tankWeek: Loop = {
    slug: "soporte",
    title: "SOPORTE",
    archived: false,
    projectUrl: "https://linear.app/acme/project/soporte-0f9e8d7c6b5a",
    repos: "dashboard",
    status: "vigilando",
    lastActivity: at(min(3)),
    sessions: [{ id: "9a8b7c6d-bbbb-4ccc-9ddd-123456789abc", cwd: "/Users/dev/work/dashboard", lastActivity: at(min(3)) }],
    agent: { id: "bg-2c19", sessionId: "9a8b7c6d-bbbb-4ccc-9ddd-123456789abc", kind: "background", pid: 40117, name: "clanker · soporte", cwd: "/Users/dev/work/dashboard", state: "blocked", status: "idle" },
    permissionMode: "bypassPermissions",
    slots: [],
    history: [
      row("TW-31", "Arreglar el scroll del listado de cuentas", "listo-para-merge", "dashboard#977", "aprobado", 22, 2.8, "ligero"),
      row("TW-33", "Quitar el modal duplicado de confirmación", "PR abierto", "dashboard#979", "abierto", 18, 2.1, "ligero"),
      row("TW-29", "Actualizar los textos del onboarding", "mergeado", "dashboard#971", "mergeado", 12, 1.4, "ligero"),
    ],
    decisions: [{ issueId: "TW-33", pr: "dashboard#979", text: "PENDIENTE: el diseño pide otro texto para el modal pero no está en Figma. Dejo el actual?", pending: true }],
    omitted: [],
    feed: [
      { ts: at(min(3)), kind: "aviso", text: "El EM espera tu respuesta sobre TW-33" },
      { ts: at(min(25)), kind: "evento", text: "listo-para-merge dashboard#977 · https://github.com/acme/dashboard/pull/977" },
      { ts: at(min(40)), kind: "lanzó", text: "TW-33 en slot A (perfil ligero)" },
    ],
    queue: null,
    queueItems: [],
    watch: [{ key: "dashboard#977", approved: true, merged: false, queuefail: false }],
    todayUsd: 6.3,
    todayIssues: 3,
  }

  const checkout: Loop = {
    slug: "migracion-checkout",
    title: "Migración del checkout",
    archived: false,
    projectUrl: "https://linear.app/acme/project/migracion-checkout-1a2b3c4d5e6f",
    repos: "payments-api, dashboard",
    status: "dormido",
    lastActivity: at(60 * 60 * 5),
    sessions: [{ id: "c0ffee00-cccc-4ddd-8eee-abcdef012345", cwd: "/Users/dev/work/payments-api", lastActivity: at(60 * 60 * 5) }],
    agent: null,
    permissionMode: "bypassPermissions",
    slots: [],
    history: [
      row("CH-12", "Endpoint para crear una sesión de checkout", "mergeado", "payments-api#360", "mergeado", 47, 7.5),
      row("CH-14", "Pantalla de resumen del pago", "PR abierto", "dashboard#955", "abierto", 39, 5.9),
    ],
    decisions: [],
    omitted: [],
    feed: [{ ts: at(60 * 60 * 5), kind: "listo", text: "CH-14 PR dashboard#955 abierto, esperando review" }],
    queue: null,
    queueItems: null,
    watch: [],
    todayUsd: 0,
    todayIssues: 0,
  }

  const archivedLoop = (slug: string, title: string, status: LoopStatus, days: number, usd: number): Loop => ({
    slug,
    title,
    archived: true,
    projectUrl: `https://linear.app/acme/project/${slug}-aabbccddeeff`,
    repos: "ledger",
    status,
    lastActivity: at(60 * 60 * 24 * days),
    sessions: [],
    agent: null,
    permissionMode: null,
    slots: [],
    history: [row("OLD-1", "Limpieza de feature flags", "mergeado", "ledger#300", "mergeado", 25, usd)],
    decisions: [],
    omitted: [],
    feed: [],
    queue: null,
    queueItems: null,
    watch: [],
    todayUsd: 0,
    todayIssues: 0,
  })

  const starting: AgentInfo[] = [
    { id: "bg-91de", sessionId: "d00d1e00-dddd-4eee-8fff-000000000001", kind: "background", pid: 42001, name: "clanker · onboarding-nuevo", cwd: null, state: null, status: null },
  ]

  const planUsage: PlanUsage = {
    fiveHour: { pct: 38, resetsAt: at(-min(95)) },
    sevenDay: { pct: 61, resetsAt: at(-60 * 60 * 52) },
    updatedAt: at(20),
  }

  const snapshot: Snapshot = {
    generatedAt: at(0),
    loops: [
      boundaries,
      tankWeek,
      checkout,
      archivedLoop("limpieza-de-flags", "Limpieza de feature flags", "terminado", 12, 3.1),
      archivedLoop("auditoria-de-logs", "Auditoría de logs", "terminado", 30, 4.6),
    ],
    planUsage,
    starting,
  }

  // ─── PRs abiertos ──────────────────────────────────────────────────────────

  const viewer = { login: "alex", avatarUrl: "" }
  let nextId = 1000
  const pr = (
    repoName: string,
    number: number,
    title: string,
    headRef: string,
    o: Partial<PullRequest> & { reviewers?: PullRequest["reviewerStates"]; risk?: PRRisk | null; updated?: number } = {},
  ): PullRequest => {
    const { reviewers, updated, ...rest } = o
    return {
      id: nextId++,
      number,
      title,
      state: "open",
      url: `https://github.com/acme/${repoName}/pull/${number}`,
      repoName,
      repoFullName: `acme/${repoName}`,
      defaultBranch: "main",
      headRef,
      baseRef: "main",
      author: viewer,
      createdAt: at(60 * 60 * 30),
      updatedAt: at(updated ?? min(30)),
      comments: 0,
      unresolvedThreads: 0,
      additions: 120,
      deletions: 34,
      changedFiles: 6,
      reviewerStates: reviewers ?? [],
      botReview: null,
      reviewDecision: "review_required",
      ciStatus: "success",
      isDraft: false,
      labels: [],
      risk: null,
      clanker: null,
      merge: { ready: false, blockers: ["falta aprobación"], finMerge: null },
      ...rest,
    }
  }
  const human = (login: string, state: PullRequest["reviewerStates"][number]["state"]) => ({ login, avatarUrl: null, state })
  const label = (name: string, color: string, description: string) => ({ name, color, description })
  const riskLabel = (r: PRRisk) => label(`risk:${r}`, r === "high" ? "d73a4a" : r === "mid" ? "fbca04" : "0e8a16", `Riesgo ${r} según el bot de review`)

  const stackBase = pr("ledger", 421, "Prohibir imports cruzados entre engines", "eng-9160-no-cross-imports", {
    reviewers: [human("marta", "approved")],
    reviewDecision: "approved",
    botReview: "approved",
    risk: "mid",
    labels: [riskLabel("mid")],
    clanker: { slug: "boundaries-de-engines", loop: "Boundaries de engines", issueId: "ENG-9160" },
    merge: { ready: true, blockers: [], finMerge: null },
    additions: 210,
    deletions: 58,
    updated: min(11),
  })
  const stackMid = pr("ledger", 424, "Agregar checks de boundaries a CI", "eng-9167-boundary-checks", {
    baseRef: "eng-9160-no-cross-imports",
    reviewers: [human("marta", "changes_requested")],
    reviewDecision: "changes_requested",
    unresolvedThreads: 2,
    comments: 5,
    risk: "low",
    labels: [riskLabel("low")],
    clanker: { slug: "boundaries-de-engines", loop: "Boundaries de engines", issueId: "ENG-9167" },
    merge: { ready: false, blockers: ["pidieron cambios", "2 threads sin resolver"], finMerge: null },
    updated: min(2),
  })
  const stackTop = pr("ledger", 426, "Reglas de boundaries para engines nuevas", "eng-9173-new-engine-rules", {
    baseRef: "eng-9167-boundary-checks",
    isDraft: true,
    state: "draft",
    reviewDecision: "none",
    ciStatus: "pending",
    risk: "low",
    labels: [riskLabel("low")],
    merge: { ready: false, blockers: ["draft"], finMerge: null },
    additions: 64,
    deletions: 3,
    changedFiles: 2,
    updated: min(5),
  })
  const stackBranch = pr("ledger", 427, "Lint de imports entre engines", "eng-9174-import-lint", {
    baseRef: "eng-9160-no-cross-imports",
    reviewers: [human("diego", "pending")],
    ciStatus: "pending",
    merge: { ready: false, blockers: ["CI corriendo", "falta aprobación"], finMerge: null },
    updated: min(8),
  })

  const prsList: PullRequest[] = [
    stackBase,
    stackMid,
    stackTop,
    stackBranch,
    pr("payments-api", 388, "Renombrar Payments::Ledger a Payments::Posting", "eng-9163-rename-posting", {
      reviewers: [human("marta", "commented"), human("diego", "approved")],
      reviewDecision: "approved",
      botReview: "commented",
      unresolvedThreads: 1,
      comments: 3,
      risk: "high",
      labels: [riskLabel("high"), label("clanker", "8957e5", "PR del clanker-loop")],
      clanker: { slug: "boundaries-de-engines", loop: "Boundaries de engines", issueId: "ENG-9163" },
      merge: { ready: false, blockers: ["1 thread sin resolver"], finMerge: null },
      additions: 480,
      deletions: 395,
      changedFiles: 31,
      updated: min(22),
    }),
    pr("payments-api", 391, "Migrar el job de conciliación", "eng-9170-reconciliation-job", {
      ciStatus: "failure",
      reviewers: [human("marta", "approved")],
      reviewDecision: "approved",
      botReview: "approved",
      risk: "high",
      labels: [riskLabel("high")],
      clanker: { slug: "boundaries-de-engines", loop: "Boundaries de engines", issueId: "ENG-9170" },
      merge: { ready: false, blockers: ["merge-queue falló"], finMerge: "failed" },
      updated: min(18),
    }),
    pr("dashboard", 977, "Arreglar el scroll del listado de cuentas", "tw-31-accounts-scroll", {
      reviewers: [human("sofia", "approved")],
      reviewDecision: "approved",
      botReview: "approved",
      risk: "low",
      labels: [riskLabel("low")],
      clanker: { slug: "soporte", loop: "SOPORTE", issueId: "TW-31" },
      merge: { ready: true, blockers: [], finMerge: "queued" },
      additions: 18,
      deletions: 6,
      changedFiles: 2,
      updated: min(25),
    }),
    pr("dashboard", 979, "Quitar el modal duplicado de confirmación", "tw-33-duplicate-modal", {
      reviewers: [human("sofia", "pending")],
      risk: "low",
      labels: [riskLabel("low")],
      clanker: { slug: "soporte", loop: "SOPORTE", issueId: "TW-33" },
      merge: { ready: false, blockers: ["falta aprobación"], finMerge: null },
      additions: 40,
      deletions: 77,
      changedFiles: 4,
      updated: min(40),
    }),
    pr("dashboard", 955, "Pantalla de resumen del pago", "ch-14-payment-summary", {
      reviewers: [],
      risk: "mid",
      labels: [riskLabel("mid")],
      clanker: { slug: "migracion-checkout", loop: "Migración del checkout", issueId: "CH-14" },
      additions: 310,
      deletions: 12,
      changedFiles: 9,
      updated: 60 * 60 * 5,
    }),
    pr("ledger", 430, "Probar el nuevo índice de entradas en staging", "idx-entries-staging", {
      isDraft: true,
      state: "draft",
      reviewDecision: "none",
      ciStatus: "unknown",
      merge: { ready: false, blockers: ["draft"], finMerge: null },
      additions: 12,
      deletions: 0,
      changedFiles: 1,
      updated: 60 * 60 * 20,
    }),
  ]

  const prs: PRsResult = {
    viewer,
    prs: prsList,
    fetchedAt: at(75),
    total: prsList.length,
    rate: { remaining: 4310, limit: 5000, cost: 6, resetAt: at(-min(41)) },
    pausedUntil: null,
  }

  const config: AppConfig = {
    profiles: ["default", "ligero", "profundo"],
    defaultProfile: "default",
    repos: [
      { name: "ledger", path: "/Users/dev/work/ledger", trusted: true },
      { name: "payments-api", path: "/Users/dev/work/payments-api", trusted: true },
      { name: "dashboard", path: "/Users/dev/work/dashboard", trusted: false },
    ],
    models: ["opus", "sonnet", "haiku"],
    efforts: ["low", "medium", "high", "xhigh"],
    defaultModel: "opus",
    defaultEffort: "high",
  }

  return { snapshot, prs, config }
}
