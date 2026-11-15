import { type CachedIssue, type ClankerProject, type ProjectId, Run, type RunDetail, type Step } from "@clanker/api"
import type { AppData } from "@/app-data"
import { buildPrs } from "@/seed-prs"

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
    ...extra,
  })

  const run = (n: number, issueN: number, status: Run["status"], startedMinAgo: number, steps: Step[], extra: Partial<Run> = {}): RunDetail => ({
    id: id("run", n),
    projectId: issues[issueN - 1]!.projectId,
    flow: { slug: projects[0]!.id === issues[issueN - 1]!.projectId ? "techlead-clasico" : "juguete", version: 1 },
    subject: { type: "issue", id: issues[issueN - 1]!.id },
    lane: "dev",
    status,
    parkReason: null,
    outcome: status === "done" ? "done" : null,
    params: {},
    rounds: {},
    costMicros: steps.reduce((sum, s) => sum + s.costMicros, 0),
    startedAt: min(startedMinAgo),
    endedAt: status === "done" || status === "failed" ? min(startedMinAgo - 12) : null,
    steps,
    ...extra,
  })

  const runs: RunDetail[] = [
    run(
      1,
      1,
      "running",
      24,
      [
        step(1, "worktree", "done"),
        step(2, "plan", "done", { costMicros: 400_000 }),
        step(3, "implementar", "done", { costMicros: 1_200_000 }),
        step(4, "tests", "done", { outcome: "changes" }),
        step(5, "implementar", "done", { visit: 2, round: 1, costMicros: 640_000 }),
        step(6, "reviews", "running", { round: 1, costMicros: 310_000 }),
      ],
      { rounds: { reviews: 1 } },
    ),
    run(2, 2, "done", 180, [step(7, "worktree", "done"), step(8, "implementar", "done", { costMicros: 2_100_000 }), step(9, "reviews", "done", { costMicros: 520_000 })]),
    run(3, 3, "parked", 50, [step(10, "worktree", "done"), step(11, "implementar", "failed", { error: "tope de gasto excedido", costMicros: 3_000_000 })], {
      parkReason: "needs_human",
    }),
  ]
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
        status: "active",
        flowParams: input.flowParams ?? {},
        maxCostUsd: input.maxCostUsd ?? null,
      }
      projects.push(created)
      return created
    },
    issues: async (projectId) => issues.filter((i) => i.projectId === projectId),
    runs: async (filter = {}) =>
      runs
        .filter((r) => (!filter.projectId || r.projectId === filter.projectId) && (!filter.status || filter.status.includes(r.status)))
        // `Run` descarta los pasos, que solo trae `run`.
        .map((r) => Run.parse(r)),
    run: async (runId) => detailOf(runId),
    startRun: async ({ projectId, issueId }) => {
      const project = projectOf(projectId)
      if (!project) throw new Error(`No existe el proyecto ${projectId}`)
      if (project.status !== "active") throw new Error(`El proyecto ${project.name} no está activo`)
      const index = issues.findIndex((i) => i.id === issueId)
      if (index < 0) throw new Error(`No existe la issue ${issueId}`)
      const started = run(nextId++, index + 1, "running", 0, [step(nextId++, "worktree", "running")])
      runs.unshift(started)
      return started
    },
    events: async (_after, signal) => ({
      async *[Symbol.asyncIterator]() {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
      },
    }),
    prs: async () => buildPrs(now),
  }
}
