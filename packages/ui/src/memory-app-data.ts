import { type CachedIssue, type ClankerProject, type ClaudeStatus, type Connection, type ProjectId, type Repo, Run, type RunDetail, type Step } from "@clanker/api"
import type { AppData, RepoRow } from "@/app-data"
import { SEED_TECHLEAD, SEED_TOY } from "@/seed-flows"
import { buildPrs } from "@/seed-prs"
import { seedStep, transcriptPage, type StepSeed } from "@/seed-steps"

// Datos de ejemplo en memoria para desarrollar la UI sin core. Nada llega por `events`: lo que se ve es
// lo del arranque más lo que cambia `createProject` y `startRun`.

// Ids con la forma de los del core (prefijo + 26 caracteres de ULID).
const id = <P extends string>(prefix: P, n: number) => `${prefix}_${String(n).padStart(26, "0")}` as `${P}_${string}`

export function createMemoryAppData(now = Date.now()): AppData {
  const min = (m: number) => now - m * 60_000
  let nextId = 100

  const projects: ClankerProject[] = [
    {
      id: id("prj", 1),
      slug: "boundaries-de-engines",
      name: "Boundaries de engines",
      tracker: "linear",
      trackerRef: "boundaries",
      defaultFlowId: "techlead-clasico",
      defaultProfileId: "medio",
      repos: [],
      queueFilter: {},
      conventions: {},
      parallel: 1,
      stackOn: "ci_green",
      status: "active",
      flowParams: {},
      maxCostUsd: null,
    },
    {
      id: id("prj", 2),
      slug: "soporte",
      name: "SOPORTE",
      tracker: "local",
      trackerRef: id("prj", 2),
      defaultFlowId: "juguete",
      defaultProfileId: "juguete",
      repos: [],
      queueFilter: {},
      conventions: {},
      parallel: 2,
      stackOn: "ci_green",
      status: "paused",
      flowParams: {},
      maxCostUsd: null,
    },
  ]

  const issue = (n: number, projectId: ProjectId, key: string, title: string, status: CachedIssue["status"] = "todo"): CachedIssue => ({
    id: id("iss", n),
    projectId,
    ref: { tracker: "linear", id: key, key, url: `https://linear.app/acme/issue/${key}` },
    project: "boundaries",
    title,
    body: "",
    status,
    rawStatus: status,
    priority: 0,
    labels: [],
    relations: { blocks: [], blockedBy: [], related: [] },
    updatedAt: min(60),
  })
  const issues: CachedIssue[] = [
    issue(1, projects[0]!.id, "ENG-9178", "Separar el cálculo de comisiones por organización", "in_progress"),
    issue(2, projects[0]!.id, "ENG-9175", "Prohibir imports cruzados entre engines", "done"),
    issue(3, projects[0]!.id, "ENG-9183", "Lint de imports entre engines"),
    issue(4, projects[0]!.id, "ENG-9190", "Reglas de boundaries para engines nuevas"),
    issue(5, projects[1]!.id, "TW-31", "Arreglar el scroll del listado de cuentas"),
  ]

  const step = (n: number, nodeId: string, status: Step["status"], extra: Partial<Step> = {}): Step => ({
    id: id("stp", n),
    nodeId,
    visit: 1,
    round: 0,
    attempt: 0,
    status,
    outcome: status === "done" ? "ok" : null,
    outputHash: null,
    error: null,
    notBefore: null,
    costMicros: 0,
    startedAt: null,
    endedAt: null,
    ...extra,
  })
  // Un paso que corrió entre `from` y `to` minutos atrás (`to` omitido: sigue corriendo).
  const ran = (from: number, to?: number): Pick<Step, "startedAt" | "endedAt"> => ({ startedAt: min(from), endedAt: to === undefined ? null : min(to) })

  const run = (n: number, issueN: number, status: Run["status"], startedMinAgo: number, steps: Step[], extra: Partial<RunDetail> = {}): RunDetail => {
    const toy = projects[0]!.id !== issues[issueN - 1]!.projectId
    const flowDef = toy ? SEED_TOY : SEED_TECHLEAD
    return {
      id: id("run", n),
      projectId: issues[issueN - 1]!.projectId,
      flow: { slug: flowDef.id, version: 1 },
      subject: { type: "issue", id: issues[issueN - 1]!.id },
      lane: "dev",
      status,
      parkReason: null,
      outcome: status === "done" ? "done" : null,
      params: toy ? {} : { base: "main", reviewRounds: 3, checkRounds: 3 },
      rounds: {},
      costMicros: steps.reduce((sum, s) => sum + s.costMicros, 0),
      startedAt: min(startedMinAgo),
      endedAt: status === "done" || status === "failed" ? min(startedMinAgo - 12) : null,
      steps,
      flowDef,
      workspace: toy ? null : { repo: "api", branch: `ba-${issueN}`, base: "main" },
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...extra,
    }
  }

  const runs: RunDetail[] = [
    // En curso: una vuelta de review ya tomada y las reviews de la segunda pasada corriendo.
    run(
      1,
      1,
      "running",
      24,
      [
        step(1, "ws", "done", ran(24, 23.5)),
        step(2, "plan", "done", { costMicros: 400_000, ...ran(23.5, 20) }),
        step(3, "implement", "done", { costMicros: 1_200_000, ...ran(20, 12) }),
        step(4, "checks", "done", { ...ran(12, 10.5) }),
        step(5, "reviews", "done", { outcome: "changes", ...ran(10.5, 7) }),
        step(6, "rv-bugs", "done", { outcome: "changes", costMicros: 260_000, ...ran(10.5, 7.5) }),
        step(7, "rv-tests", "done", { costMicros: 120_000, ...ran(10.5, 8) }),
        step(8, "rv-patterns", "done", { costMicros: 100_000, ...ran(10.5, 8.5) }),
        step(9, "rv-lore", "done", { costMicros: 90_000, ...ran(10.5, 9) }),
        step(10, "fix", "done", { round: 1, costMicros: 640_000, ...ran(7, 3) }),
        step(11, "checks", "done", { visit: 2, ...ran(3, 2) }),
        step(12, "reviews", "waiting", { visit: 2, ...ran(2) }),
        step(13, "rv-bugs", "running", { visit: 2, costMicros: 310_000, ...ran(2) }),
        step(14, "rv-tests", "done", { visit: 2, costMicros: 120_000, ...ran(2, 0.6) }),
        step(15, "rv-patterns", "done", { visit: 2, costMicros: 100_000, ...ran(2, 0.8) }),
        step(16, "rv-lore", "done", { visit: 2, costMicros: 90_000, ...ran(2, 1) }),
      ],
      { rounds: { review: 1 }, usage: { input: 410_000, output: 380_000, cacheRead: 4_900_000, cacheWrite: 520_000 } },
    ),
    // Terminada: sin vueltas, hasta el PR y el feedback externo.
    run(
      2,
      2,
      "done",
      180,
      [
        step(17, "ws", "done", ran(180, 179.5)),
        step(18, "plan", "done", { costMicros: 300_000, ...ran(179.5, 176) }),
        step(19, "implement", "done", { costMicros: 2_100_000, ...ran(176, 160) }),
        step(20, "checks", "done", ran(160, 158)),
        step(21, "reviews", "done", ran(158, 154)),
        step(22, "rv-bugs", "done", { costMicros: 210_000, ...ran(158, 155) }),
        step(23, "rv-tests", "done", { costMicros: 120_000, ...ran(158, 156) }),
        step(24, "rv-patterns", "done", { costMicros: 100_000, ...ran(158, 156.5) }),
        step(25, "rv-lore", "done", { costMicros: 90_000, ...ran(158, 157) }),
        step(26, "sync", "done", { outcome: "same", ...ran(154, 153.5) }),
        step(27, "commit", "done", { costMicros: 150_000, ...ran(153.5, 151) }),
        step(28, "publish", "done", ran(151, 150)),
        step(29, "feedback", "done", { outcome: "done", ...ran(150, 168) }),
      ],
      { usage: { input: 220_000, output: 260_000, cacheRead: 2_300_000, cacheWrite: 310_000 } },
    ),
    run(3, 3, "parked", 50, [step(30, "ws", "done", ran(50, 49.5)), step(31, "plan", "done", { costMicros: 350_000, ...ran(49.5, 46) }), step(32, "implement", "failed", { error: "tope de gasto excedido", costMicros: 3_000_000, ...ran(46, 38) })], {
      parkReason: "needs_human",
      usage: { input: 120_000, output: 90_000, cacheRead: 1_100_000, cacheWrite: 90_000 },
    }),
  ]
  // El detalle de cada paso se arma al pedirlo: `seedStep` es determinista, así que repetirlo da lo mismo.
  const seeds = new Map<string, StepSeed>()
  const seedOf = (stepId: string): StepSeed => {
    const cached = seeds.get(stepId)
    if (cached) return cached
    for (const r of runs) {
      const found = r.steps.find((st) => st.id === stepId)
      if (!found) continue
      const seed = seedStep(found, Number(stepId.slice(-4)), r.flowDef.nodes[found.nodeId], found.startedAt ?? now)
      seeds.set(stepId, seed)
      return seed
    }
    throw new Error(`No existe el paso ${stepId}`)
  }
  // Conexiones de ejemplo: GitHub en regla, Linear vencida y Claude sin configurar.
  const day = 86_400_000
  const connections: Connection[] = [
    { provider: "github", account: "octocat", scopes: ["contents", "pull_requests", "issues", "checks", "statuses"], status: "active", expiresAt: now + 60 * day, expiresSoon: false },
    { provider: "linear", account: "clanker-yard", scopes: ["read", "write"], status: "expired", expiresAt: now - 2 * day },
  ]
  const connect = (c: Connection) => {
    const at = connections.findIndex((x) => x.provider === c.provider && x.account === c.account)
    if (at >= 0) connections[at] = c
    else connections.push(c)
    return c
  }
  const repoRows: RepoRow[] = (
    [
      ["api", { status: "found" }, { ok: true, at: min(90) }],
      ["web", { status: "missing" }, null],
      ["infra", { status: "invalid", message: 'checks.0: "lint" no está en commands (no hay ninguno).' }, { ok: false, at: min(600) }],
    ] as const
  ).map(([name, recipe, lastTest], i): RepoRow => {
    const repo: Repo = { id: id("repo", i + 1), name, path: `/Users/dev/${name}`, remote: `acme/${name}`, defaultBranch: "main" }
    return { repo, recipe, lastTest }
  })
  const projectOf = (projectId: ProjectId) => projects.find((p) => p.id === projectId)
  const detailOf = (runId: string) => {
    const found = runs.find((r) => r.id === runId)
    if (!found) throw new Error(`No existe la corrida ${runId}`)
    return found
  }

  return {
    projects: async () => projects.map((p) => ({ ...p })),
    createProject: async (input) => {
      if (projects.some((p) => p.slug === input.slug)) throw new Error(`Ya existe un proyecto con el slug ${input.slug}`)
      const projectId = id("prj", nextId++)
      const created: ClankerProject = {
        id: projectId,
        slug: input.slug,
        name: input.name,
        tracker: input.tracker,
        trackerRef: input.trackerRef ?? projectId,
        defaultFlowId: input.defaultFlowId ?? null,
        defaultProfileId: input.defaultProfileId ?? null,
        repos: input.repos?.map(({ repoId, labels = [] }) => ({ repoId, labels })) ?? [],
        queueFilter: input.queueFilter ?? {},
        conventions: input.conventions ?? {},
        parallel: input.parallel ?? 1,
        stackOn: input.stackOn ?? "ci_green",
        status: "active",
        flowParams: input.flowParams ?? {},
        maxCostUsd: input.maxCostUsd ?? null,
      }
      projects.push(created)
      return created
    },
    issues: async (projectId) => issues.filter((i) => i.projectId === projectId),
    // Sin bloqueos en los datos de ejemplo: la cola son las issues en todo que ninguna corrida tomó.
    queue: async (projectId) =>
      issues
        .filter((i) => i.projectId === projectId && i.status === "todo" && !runs.some((r) => r.subject.id === i.id))
        .map((issue) => ({ issue, state: "ready" as const, reason: "lista sobre la branch por defecto", base: { kind: "default" as const }, dependsOn: [] })),
    runs: async (filter = {}) =>
      runs
        .filter((r) => (!filter.projectId || r.projectId === filter.projectId) && (!filter.status || filter.status.includes(r.status)))
        // `Run` descarta los pasos, que solo trae `run`.
        .map((r) => Run.parse(r)),
    run: async (runId) => detailOf(runId),
    step: async (stepId) => seedOf(stepId).detail,
    transcript: async (sessionId, cursor) => {
      for (const r of runs) {
        for (const st of r.steps) {
          const entries = seedOf(st.id).transcripts.get(sessionId)
          if (entries) return transcriptPage(entries, cursor)
        }
      }
      throw new Error(`No existe la sesión ${sessionId}`)
    },
    artifact: async (hash) => {
      for (const r of runs) {
        for (const st of r.steps) {
          const text = seedOf(st.id).artifacts.get(hash)
          if (text !== undefined) return text
        }
      }
      throw new Error(`No existe el artefacto ${hash}`)
    },
    startRun: async ({ projectId, issueId }) => {
      const project = projectOf(projectId)
      if (!project) throw new Error(`No existe el proyecto ${projectId}`)
      if (project.status !== "active") throw new Error(`El proyecto ${project.name} no está activo`)
      const index = issues.findIndex((i) => i.id === issueId)
      if (index < 0) throw new Error(`No existe la issue ${issueId}`)
      const started = run(nextId++, index + 1, "running", 0, [step(nextId++, "ws", "running", ran(0))])
      runs.unshift(started)
      return started
    },
    events: async (_after, signal) => ({
      async *[Symbol.asyncIterator]() {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
      },
    }),
    prs: async () => buildPrs(now),
    connections: async () => connections.map((c) => ({ ...c })),
    githubPatForm: async () => ({
      url: "https://github.com/settings/personal-access-tokens/new?name=Clanker+Yard",
      permissions: [
        { name: "contents", label: "Contents", access: "write" },
        { name: "pull_requests", label: "Pull requests", access: "write" },
        { name: "issues", label: "Issues", access: "write" },
        { name: "checks", label: "Checks", access: "read" },
        { name: "statuses", label: "Commit statuses", access: "read" },
      ],
    }),
    setGithubPat: async (token) => {
      if (token.startsWith("bad")) throw new Error("GitHub rechazó el token: es inválido, está vencido o fue revocado. Crea uno nuevo y vuelve a pegarlo.")
      return connect({ provider: "github", account: "octocat", scopes: ["contents", "pull_requests", "issues", "checks", "statuses"], status: "active", expiresAt: now + 90 * day, expiresSoon: false })
    },
    // No hay navegador ni redirect: la cuenta queda conectada de una vez.
    linearAuth: async () => {
      connect({ provider: "linear", account: "clanker-yard", scopes: ["read", "write"], status: "active", expiresAt: now + 30 * day, expiresSoon: false })
      return "https://linear.app/oauth/authorize?client_id=memory"
    },
    testClaude: async (mode = "subscription") => {
      const status: ClaudeStatus = {
        mode,
        state: "ready",
        version: "2.1.325",
        ...(mode === "subscription" && { plan: "max", usage: { fiveHour: { utilization: 0.15, resetsAt: now + 2 * 3_600_000 }, sevenDay: { utilization: 0.42, resetsAt: now + 3 * day } } }),
      }
      connect({ provider: "claude", account: mode, scopes: [], status: "active" })
      return status
    },
    setClaudeApiKey: async (key) => {
      if (key.startsWith("bad")) throw new Error("Anthropic rechazó la API key de Claude: revisa que sea válida y esté activa, y guárdala de nuevo.")
      return connect({ provider: "claude", account: "api-key", scopes: [], status: "active" })
    },
    disconnect: async (provider, account) => {
      const at = connections.findIndex((c) => c.provider === provider && c.account === account)
      if (at >= 0) connections.splice(at, 1)
    },
    repos: async () => repoRows.map((r) => ({ ...r })),
    testRecipe: async (repoId) => {
      const row = repoRows.find((r) => r.repo.id === repoId)
      if (!row) throw new Error(`No existe el repo ${repoId}`)
      if (row.recipe.status !== "found") throw new Error(`${row.repo.name} no tiene una receta válida: no hay nada que probar.`)
      row.lastTest = { ok: true, at: Date.now() }
      return { ok: true, steps: [{ phase: "setup.worktree", name: "pnpm install", ok: true, exitCode: 0, extract: "Done in 4.2s" }] }
    },
    addRepo: async (path) => {
      if (repoRows.some((r) => r.repo.path === path)) throw new Error(`${path} ya está registrado.`)
      const name = path.split("/").filter(Boolean).pop() ?? path
      const repo: Repo = { id: id("repo", repoRows.length + 1), name, path, remote: null, defaultBranch: "main" }
      repoRows.push({ repo, recipe: { status: "missing" }, lastTest: null })
      return repo
    },
  }
}
