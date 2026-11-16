import { type Breaker, type CachedIssue, type CachedPr, type ClankerProject, type ClaudeStatus, type Connection, type Decision, type DefChange, type DefIssue, type DefRecord, FlowDef, type IssueId, type Lanes, type Learning, type LearningPatch, type PackInfo, Profile, type PrRef, type ProjectDefaults, type ProjectId, type QueueEntry, type Repo, Role, Run, type RunDetail, type Step } from "@clanker/api"
import type { AppData, RepoRow } from "@/app-data"
import { SEED_REBASE, SEED_TECHLEAD, SEED_TOY } from "@/seed-flows"
import { buildOpenPrs } from "@/seed-prs"
import { aggregate, seedClosedRuns } from "@/seed-metrics"
import { seedStep, transcriptPage, type StepSeed } from "@/seed-steps"

// Datos de ejemplo en memoria para desarrollar la UI sin core. Nada llega por `events`: lo que se ve es
// lo del arranque más lo que cambia `createProject` y `startRun`.

// Ids con la forma de los del core (prefijo + 26 caracteres de ULID).
const id = <P extends string>(prefix: P, n: number) => `${prefix}_${String(n).padStart(26, "0")}` as `${P}_${string}`

// Los proyectos de Linear de ejemplo: los de la persona primero, como los ordena el core.
const TRACKER_PROJECTS = [
  { ref: { tracker: "linear" as const, id: "5d1c0a52-7a58-4f43-9a0e-0c7f5b2f1a01" }, name: "Boundaries de engines", mine: true },
  { ref: { tracker: "linear" as const, id: "0a9e3c1b-2f6d-4b88-8d57-7e0d4c9a3b02" }, name: "Clanker Yard MVP", mine: true },
  { ref: { tracker: "linear" as const, id: "c43b8e70-91d2-4e0c-a6f5-3b1e8d2f6c03" }, name: "Facturación mensual", mine: false },
  { ref: { tracker: "linear" as const, id: "9e72d4a8-6b15-4c39-b0a2-5f8c1d7e4a04" }, name: "Limpieza de feature flags", mine: false },
]

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
      trackerAccount: "clanker-yard",
      defaultFlowId: "techlead-clasico",
      defaultProfileId: "medio",
      repos: [],
      queueFilter: {},
      conventions: {},
      parallel: 1,
      stackOn: "ci_green",
      statusMapping: {},
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
      trackerAccount: null,
      defaultFlowId: "juguete",
      defaultProfileId: "juguete",
      repos: [],
      queueFilter: {},
      conventions: {},
      parallel: 2,
      stackOn: "ci_green",
      statusMapping: {},
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
      parentRunId: null,
      borrowedFromRunId: null,
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
    // Estacionada en un gate: espera que alguien apruebe antes de seguir.
    run(4, 4, "parked", 35, [step(33, "ws", "done", ran(35, 34.5)), step(34, "plan", "done", { costMicros: 280_000, ...ran(34.5, 31) })], {
      parkReason: "gate",
      usage: { input: 60_000, output: 40_000, cacheRead: 500_000, cacheWrite: 40_000 },
    }),
  ]

  // La bandeja: una decisión de cada tipo, dos de ellas bloqueantes y una resuelta hoy. `resolveDecision` solo
  // cierra la decisión y mueve la corrida estacionada, como lo hace el core.
  const decision = (n: number, d: Pick<Decision, "kind" | "title" | "body"> & Partial<Decision>): Decision => ({
    id: id("dec", n),
    projectId: null,
    runId: null,
    stepRunId: null,
    subject: null,
    options: [],
    status: "pending",
    resolution: null,
    resolvedBy: null,
    createdAt: min(10),
    resolvedAt: null,
    ...d,
  })
  const on = (runN: number) => {
    const r = runs[runN - 1]!
    return { projectId: r.projectId, runId: r.id, subject: r.subject }
  }
  const decisions: Decision[] = [
    decision(1, {
      kind: "gate",
      title: "¿Publico el PR de ENG-9190 como draft?",
      body: "draft: Publicar como draft y pedir /review\nready: Publicar listo para revisar\nskip: No publicar todavía",
      options: ["draft", "ready", "skip"],
      createdAt: min(4),
      ...on(4),
    }),
    decision(2, {
      kind: "needs_human",
      title: "La corrida llegó a su tope",
      body: "La corrida gastó US$ 3,35 y su tope es US$ 3. Continuar le suma otra vez el tope; cancelar la termina.",
      options: ["continue", "cancel"],
      createdAt: min(38),
      ...on(3),
    }),
    decision(3, {
      kind: "review_note",
      title: "Quedan 🔴/🟡 tras las rondas de review",
      body: "🔴 `rv-bugs`: el scope por organización no cubre el caso sin modelo.\n🟡 `rv-patterns`: el nombre del helper no sigue el de los engines vecinos.",
      createdAt: min(75),
      ...on(2),
    }),
    decision(4, {
      kind: "alert",
      title: "La conexión de Linear venció",
      body: "El refresh token de Linear ya no vale: las issues no se sincronizan hasta que vuelvas a conectar la cuenta.",
      createdAt: min(130),
    }),
    decision(5, {
      kind: "note",
      title: "Aprendizaje propuesto: correr los checks antes del commit",
      body: "En las últimas 4 corridas el commit falló por lint. Propongo agregar `recipe.check` antes de `commit` en el flujo.",
      options: ["Aprobar", "Editar", "Descartar"],
      projectId: projects[1]!.id,
      createdAt: min(1500),
    }),
    decision(6, {
      kind: "gate",
      title: "¿Publico el PR de ENG-9175?",
      body: "draft: Publicar como draft y pedir /review\nready: Publicar listo para revisar",
      options: ["draft", "ready"],
      status: "answered",
      resolution: { option: "draft" },
      resolvedBy: "ui",
      createdAt: min(200),
      resolvedAt: min(190),
      ...on(2),
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
  // Learnings de los tres orígenes y los cuatro estados. Aprobar, rechazar y editar siguen las reglas del core.
  const learning = (n: number, l: Pick<Learning, "text" | "status" | "source"> & Partial<Learning>): Learning => ({
    id: id("lrn", n),
    projectId: projects[0]!.id,
    repoId: null,
    roles: [],
    tags: [],
    sourceRunId: null,
    createdAt: min(60 * n),
    ...l,
  })
  const learnings: Learning[] = [
    learning(1, { text: "El scope por organización se pasa siempre explícito: ningún query de un engine lee `Current.organization`.", status: "proposed", source: "agent", roles: ["review-bugs"], sourceRunId: runs[1]!.id }),
    learning(2, { text: "Antes de tocar un engine, correr `bin/boundaries check` para ver qué dependencias ya están prohibidas.", status: "proposed", source: "import" }),
    learning(3, { text: "Los specs de un engine no cargan fixtures de otro: se arman con las factories del propio engine.", status: "proposed", source: "import", roles: ["dev", "review-tests"] }),
    learning(4, { text: "Nombrar los helpers de boundaries con el sufijo del engine dueño, como los vecinos.", status: "proposed", source: "agent", roles: ["review-patterns"], sourceRunId: runs[1]!.id }),
    learning(5, { text: "El CLI viejo del loop se llamaba con `loop run`; en Yard es `clanker runs start`.", status: "proposed", source: "import" }),
    learning(6, { text: "Usar `recipe.check` antes de `commit`: en las últimas corridas el commit falló por lint.", status: "proposed", source: "human", projectId: projects[1]!.id }),
    learning(7, { text: "Cada PR de la cadena sale sobre la rama del anterior, no sobre main.", status: "approved", source: "import", tags: ["stack"] }),
    learning(8, { text: "No mergear con `gh pr merge`: el pack comenta su comando y el merge lo hace el bot.", status: "approved", source: "human", roles: ["committer"] }),
    learning(9, { text: "El hook de pre-commit tarda 40 s: no lo saltes, espéralo.", status: "rejected", source: "agent", sourceRunId: runs[2]!.id }),
    learning(10, { text: "Las migraciones se generan con `--name`, nunca con el nombre aleatorio.", status: "archived", source: "import" }),
  ]
  const needLearning = (learningId: string) => {
    const found = learnings.find((l) => l.id === learningId)
    if (!found) throw new Error(`No existe el learning ${learningId}.`)
    return found
  }

  const connections: Connection[] = [
    { provider: "github", account: "octocat", scopes: ["contents", "pull_requests", "issues", "checks", "statuses"], status: "active", expiresAt: now + 60 * day, expiresSoon: false, auth: "pat" },
    { provider: "linear", account: "clanker-yard", scopes: ["read", "write"], status: "expired", expiresAt: now - 2 * day },
  ]
  const connect = (c: Connection) => {
    const at = connections.findIndex((x) => x.provider === c.provider && x.account === c.account)
    if (at >= 0) connections[at] = c
    else connections.push(c)
    return c
  }
  const def = (kind: DefRecord["kind"], slug: string, body: unknown, extra: Partial<DefRecord> = {}): DefRecord => ({
    id: id("def", nextId++),
    kind,
    slug,
    scope: "builtin",
    repoId: null,
    archivedAt: null,
    currentVersion: 1,
    version: 1,
    body,
    source: "builtin",
    createdAt: min(600),
    ...extra,
  })
  const roleBody = (prompt: string, mode: string) => ({
    prompt,
    context: [],
    modes: { [mode]: { instructions: `Haz el trabajo del modo ${mode}.`, report: { type: "object" }, outcomes: ["ok"], session: "new" } },
  })
  const defsStore: DefRecord[] = [
    ...[SEED_TECHLEAD, SEED_TOY, SEED_REBASE].map((flow) => def("flow", flow.id, flow, flow === SEED_TECHLEAD ? { currentVersion: 3, version: 3 } : {})),
    def("role", "dev", roleBody("Eres quien implementa la issue.", "implement")),
    def("role", "review-bugs", roleBody("Buscas bugs de producción en el cambio.", "review")),
    def("role", "review-tests", roleBody("Revisas los tests del cambio.", "review")),
    def("role", "review-patterns", roleBody("Revisas patrones y simplicidad.", "review")),
    def("role", "review-lore", roleBody("Revisas el cambio contra el lore del equipo.", "review")),
    def("role", "committer", roleBody("Armas los commits y el PR.", "plan")),
    def("role", "juguete", roleBody("Saludas.", "saludar")),
    def("profile", "eco", { roles: { dev: { model: "sonnet", effort: "high" }, "review-bugs": { model: "sonnet" }, "review-tests": { model: "haiku" } } }),
    def("profile", "medio", { roles: { dev: { model: "sonnet", effort: "medium" }, "review-bugs": { model: "sonnet" }, "review-tests": { model: "haiku", effort: "high" }, committer: { model: "sonnet" } } }),
    def("context", "lore", { description: "Lecciones de reviews anteriores", refs: ["rule:lore"] }),
    def("context", "commits", { description: "Cómo se hacen los commits", refs: ["skill:commit"] }),
    def("profile", "juguete", { roles: { juguete: { model: "haiku" } } }),
  ]
  // Los bodies de las versiones guardadas desde `updateDef`, por def.
  const bodies = new Map<string, Map<number, { body: unknown; source: string; createdAt: number }>>()
  const checkBody = (kind: DefRecord["kind"], slug: string, body: unknown): { parsed: unknown; errors: DefIssue[] } => {
    const schema = kind === "flow" ? FlowDef : kind === "role" ? Role : Profile
    const result = schema.safeParse(body)
    if (!result.success) return { parsed: undefined, errors: result.error.issues.map(({ path, message }) => ({ path: path.map(String).join("."), message })) }
    const errors: DefIssue[] = []
    if (kind === "flow") {
      const flow = result.data as FlowDef
      if (flow.id !== slug) errors.push({ path: "id", message: `el id del flujo es "${flow.id}" y debe ser su slug "${slug}"` })
      for (const [nodeId, node] of Object.entries(flow.nodes)) {
        if (node.type === "agent" && !defsStore.some((d) => d.kind === "role" && d.slug === node.role && d.archivedAt === null)) errors.push({ path: `nodes.${nodeId}.role`, message: `no existe el rol "${node.role}"` })
      }
    }
    return { parsed: result.data, errors }
  }
  const needDef = (kind: DefRecord["kind"], defId: string) => {
    const found = defsStore.find((d) => d.kind === kind && d.id === defId)
    if (!found) throw new Error(`No existe el ${kind} ${defId}.`)
    return found
  }
  const writableDef = (kind: DefRecord["kind"], defId: string) => {
    const found = needDef(kind, defId)
    if (found.scope === "builtin" || found.scope === "pack") throw new Error(`El ${kind} "${found.slug}" viene incluido: no se archiva ni se edita. Duplícalo para tener uno tuyo.`)
    return found
  }

  const repoRows: RepoRow[] = (
    [
      ["api", { status: "found" }, { ok: true, at: min(90) }],
      ["web", { status: "missing" }, null],
      ["infra", { status: "invalid", message: 'checks.0: "lint" no está en commands (no hay ninguno).' }, { ok: false, at: min(600) }],
    ] as const
  ).map(([name, recipe, lastTest], i): RepoRow => {
    const repo: Repo = { id: id("repo", i + 1), name, path: `/Users/dev/${name}`, remote: `acme/${name}`, defaultBranch: "main", mergeStrategy: null }
    return { repo, recipe, lastTest }
  })
  // Lo que el usuario saltó o subió en la cola, que `queue` refleja.
  const skipped = new Set<IssueId>()
  // Los topes por defecto del core: dev 4, mantenimiento 2.
  const capacities = { dev: 4, maintenance: 2 }
  const defaults: ProjectDefaults = { defaultFlowId: null, defaultProfileId: null, parallel: 1, maxCostUsd: null }
  let packsStore: PackInfo[] = [{ id: "base", version: 2, origin: "factory", activate: { githubOrgs: ["base-org"], trackerWorkspaces: ["base"] } }]
  const lanesNow = (): Lanes => {
    const holding = (lane: Run["lane"]) => runs.filter((r) => r.lane === lane && (r.status === "running" || r.status === "waiting" || r.status === "paused")).length
    return { dev: { active: holding("dev"), capacity: capacities.dev }, maintenance: { active: holding("maintenance"), capacity: capacities.maintenance } }
  }
  const boosted: IssueId[] = []
  const breakers: Breaker[] = []
  const prs: CachedPr[] = buildOpenPrs(now)
  const prOf = (ref: PrRef): CachedPr => {
    const found = prs.find((p) => p.ref.repo === ref.repo && p.ref.number === ref.number)
    if (!found?.state) throw new Error(`El core no conoce el PR ${ref.repo}#${ref.number}`)
    return found
  }
  const projectOf = (projectId: ProjectId) => projects.find((p) => p.id === projectId)
  const detailOf = (runId: string) => {
    const found = runs.find((r) => r.id === runId)
    if (!found) throw new Error(`No existe la corrida ${runId}`)
    return found
  }

  /** Cambia la corrida sin mutar la anterior: lo que la UI ya leyó no se mueve a escondidas. */
  const update = (runId: string, change: (r: RunDetail) => Partial<RunDetail>): RunDetail => {
    const at = runs.findIndex((r) => r.id === runId)
    const updated = { ...runs[at]!, ...change(runs[at]!) }
    runs[at] = updated
    return updated
  }
  const OPEN: Step["status"][] = ["pending", "leased", "running", "waiting"]
  const cancelOpen = (steps: Step[]): Step[] => steps.map((st) => (OPEN.includes(st.status) ? { ...st, status: "canceled", error: "Lo canceló una persona." } : st))
  const ownerOf = (stepId: string) => {
    const owner = runs.find((r) => r.steps.some((st) => st.id === stepId))
    if (!owner) throw new Error(`No existe el paso ${stepId}`)
    return { run: owner, step: owner.steps.find((st) => st.id === stepId)! }
  }
  const setProjectStatus = (projectId: ProjectId, status: ClankerProject["status"]) => {
    const found = projectOf(projectId)
    if (!found) throw new Error(`No existe el proyecto ${projectId}`)
    if (found.status === "archived") throw new Error(`El proyecto ${found.name} está archivado.`)
    found.status = status
    return { ...found }
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
        trackerAccount: input.trackerAccount ?? null,
        defaultFlowId: input.defaultFlowId ?? defaults.defaultFlowId,
        defaultProfileId: input.defaultProfileId ?? defaults.defaultProfileId,
        repos: input.repos?.map(({ repoId, labels = [] }) => ({ repoId, labels })) ?? [],
        queueFilter: input.queueFilter ?? {},
        conventions: input.conventions ?? {},
        parallel: input.parallel ?? defaults.parallel,
        stackOn: input.stackOn ?? "ci_green",
        statusMapping: input.statusMapping ?? {},
        status: "active",
        flowParams: input.flowParams ?? {},
        maxCostUsd: input.maxCostUsd === undefined ? defaults.maxCostUsd : input.maxCostUsd,
      }
      projects.push(created)
      return created
    },
    updateProject: async (projectId, patch) => {
      const project = projectOf(projectId)
      if (!project) throw new Error(`No existe el proyecto ${projectId}`)
      Object.assign(project, patch)
      return { ...project }
    },
    skipIssue: async (_projectId, issueId, skip) => void (skip ? skipped.add(issueId) : skipped.delete(issueId)),
    boostIssue: async (_projectId, issueId, boost) => {
      const at = boosted.indexOf(issueId)
      if (at >= 0) boosted.splice(at, 1)
      if (boost) boosted.unshift(issueId)
    },
    lanes: async () => lanesNow(),
    setLanes: async (patch) => {
      for (const lane of ["dev", "maintenance"] as const) {
        const capacity = patch[lane]
        if (capacity === undefined) continue
        if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`La capacidad del carril ${lane} debe ser un entero de 1 o más`)
        capacities[lane] = capacity
      }
      return lanesNow()
    },
    projectDefaults: async () => ({ ...defaults }),
    setProjectDefaults: async (patch) => {
      Object.assign(defaults, Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)))
      return { ...defaults }
    },
    packs: async () => packsStore.map((p) => ({ ...p })),
    installPack: async (path) => {
      if (path.trim() === "") throw new Error("Falta la carpeta del pack.")
      const installed: PackInfo = { id: "acme", version: 1, origin: "installed", activate: { githubOrgs: ["acme"] } }
      packsStore = [...packsStore.filter((p) => p.id !== installed.id), installed].sort((a, b) => a.id.localeCompare(b.id))
      return { ...installed }
    },
    removePack: async (packId) => {
      const found = packsStore.find((p) => p.id === packId)
      if (!found) throw new Error(`El pack "${packId}" no está instalado.`)
      if (found.origin === "factory") throw new Error(`El pack "${packId}" viene con la app: no se puede quitar.`)
      packsStore = packsStore.filter((p) => p.id !== packId)
    },
    coreInfo: async () => ({ dataDir: "/Users/ana/Library/Application Support/Clanker Yard", linearClientId: "60358f9aaddae2ba3a9c09e1419c2579" }),
    breakers: async () => breakers.map((b) => ({ ...b })),
    openPrs: async () => prs.map((p) => ({ ...p })),
    refreshPrs: async () => {},
    setPrHold: async (ref, hold) => {
      const found = prOf(ref)
      // Como el core: el hold apaga la oferta y el merge automático.
      found.state = { ...found.state!, hold, merge: { ...found.state!.merge, offer: hold ? false : found.state!.merge.ready, auto: false } }
    },
    mergePr: async (ref) => {
      const found = prOf(ref)
      if (!found.state!.merge.ready || found.state!.hold) throw new Error(`${found.state!.key} no está listo para mergear`)
      found.state = { ...found.state!, merge: { ...found.state!.merge, queue: "queued" } }
    },
    requestPrReview: async (ref) => void prOf(ref),
    rebasePr: async (ref) => void prOf(ref),
    // Solo el primer proyecto tiene corridas cerradas de ejemplo; el otro trae su Resumen vacío.
    projectMetrics: async (projectId, range) =>
      aggregate(projectId === projects[0]!.id ? seedClosedRuns(issues.slice(0, 4).map((i) => i.id)) : [], range, now),
    issues: async (projectId) => issues.filter((i) => i.projectId === projectId),
    // Sin bloqueos en los datos de ejemplo: la cola son las issues en todo que ninguna corrida tomó; las saltadas salen bloqueadas.
    queue: async (projectId) => {
      const entries = issues
        .filter((i) => i.projectId === projectId && i.status === "todo" && !runs.some((r) => r.subject.id === i.id))
        .map((issue): QueueEntry =>
          skipped.has(issue.id)
            ? { issue, state: "blocked", skipped: true, reason: "saltada a mano: el usuario pidió que el Scheduler no la lance (projects.skipIssue)" }
            : { issue, state: "ready", reason: "lista sobre la branch por defecto", base: { kind: "default" }, dependsOn: [] },
        )
      const rank = (e: QueueEntry) => (e.state === "blocked" ? 1 : 0) * 1000 + (boosted.includes(e.issue.id) ? boosted.indexOf(e.issue.id) : 500)
      return entries.sort((a, b) => rank(a) - rank(b))
    },
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
    pauseRun: async (runId, opts) => {
      const found = detailOf(runId)
      if (found.status !== "running" && found.status !== "paused") throw new Error(`La corrida está ${found.status}: solo se pausa una corrida que corre.`)
      return update(runId, (r) => ({
        status: "paused",
        steps: opts?.now ? r.steps.map((st) => (st.status === "running" || st.status === "leased" ? { ...st, status: "pending", error: "La corrida se pausó con este paso en curso; se retoma." } : st)) : r.steps,
      }))
    },
    resumeRun: async (runId) => {
      const found = detailOf(runId)
      if (found.status !== "paused" && found.status !== "running") throw new Error(`La corrida está ${found.status}: solo se retoma una pausada.`)
      return update(runId, () => ({ status: "running" }))
    },
    cancelRun: async (runId) => update(runId, (r) => (r.endedAt === null ? { status: "canceled", endedAt: Date.now(), steps: cancelOpen(r.steps) } : {})),
    interruptRun: async (runId) => {
      const found = detailOf(runId)
      if (found.status !== "running" && found.status !== "paused") throw new Error(`La corrida está ${found.status}: solo se interrumpe una corrida que corre.`)
      return update(runId, (r) => ({ status: "paused", steps: r.steps.map((st) => (st.status === "running" ? { ...st, status: "pending", error: "La corrida se pausó con este paso en curso; se retoma." } : st)) }))
    },
    retryStep: async (stepId) => {
      const { run: owner, step: target } = ownerOf(stepId)
      return update(owner.id, (r) => ({
        status: r.status === "parked" ? "running" : r.status,
        parkReason: null,
        steps: [...cancelOpen(r.steps), step(nextId++, target.nodeId, "pending", { visit: Math.max(...r.steps.filter((st) => st.nodeId === target.nodeId).map((st) => st.visit)) + 1, round: target.round })],
      }))
    },
    steerStep: async (stepId, message) => {
      const { run: owner, step: target } = ownerOf(stepId)
      if (!message.trim()) throw new Error("El mensaje para el agente está vacío.")
      if (target.status === "done") throw new Error(`El paso "${target.nodeId}" está done: un mensaje solo llega a un agente en curso, pendiente o que falló.`)
      return owner
    },
    forceOutcome: async (stepId, outcome) => {
      const { run: owner, step: target } = ownerOf(stepId)
      return update(owner.id, (r) => ({ steps: r.steps.map((st) => (st.id === target.id ? { ...st, status: "done", outcome, error: null } : st)) }))
    },
    pauseProject: async (projectId) => setProjectStatus(projectId, "paused"),
    resumeProject: async (projectId) => setProjectStatus(projectId, "active"),
    events: async (_after, signal) => ({
      async *[Symbol.asyncIterator]() {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
      },
    }),
    decisions: async (filter = {}) =>
      decisions
        .filter((d) => (!filter.projectId || d.projectId === filter.projectId) && (!filter.runId || d.runId === filter.runId) && (!filter.status || filter.status.includes(d.status)) && (!filter.kind || filter.kind.includes(d.kind)))
        .toSorted((a, b) => b.createdAt - a.createdAt)
        .map((d) => ({ ...d })),
    resolveDecision: async (decisionId, option) => {
      const found = decisions.find((d) => d.id === decisionId)
      if (!found) throw new Error(`No existe la decisión ${decisionId}`)
      if (found.status !== "pending") throw new Error(`La decisión ${decisionId} ya está ${found.status}: no hay nada que resolver.`)
      if (found.options.length && (found.kind === "gate" || found.kind === "needs_human") && !found.options.includes(option)) throw new Error(`"${option}" no es una opción de la decisión ${decisionId}.`)
      Object.assign(found, { status: "answered", resolution: { option }, resolvedBy: "ui", resolvedAt: Date.now() })
      const parked = runs.find((r) => r.id === found.runId && r.status === "parked")
      if (parked && (found.kind === "gate" || found.kind === "needs_human")) Object.assign(parked, option === "cancel" ? { status: "canceled", parkReason: null } : { status: "running", parkReason: null })
      return { ...found }
    },
    learnings: async () => learnings.toSorted((a, b) => (a.id < b.id ? 1 : -1)).map((l) => ({ ...l })),
    approveLearning: async (learningId) => {
      const found = needLearning(learningId)
      found.status = "approved"
      return { ...found }
    },
    rejectLearning: async (learningId) => {
      const found = needLearning(learningId)
      if (found.status === "proposed") found.status = "rejected"
      else if (found.status === "approved") found.status = "archived"
      return { ...found }
    },
    updateLearning: async ({ id: learningId, ...changes }: LearningPatch) => {
      const found = needLearning(learningId)
      if (changes.text && learnings.some((l) => l.id !== found.id && l.text === changes.text && l.projectId === found.projectId && l.repoId === found.repoId)) throw new Error("Ya existe ese texto en el mismo alcance.")
      Object.assign(found, changes)
      return { ...found }
    },
    connections: async () => connections.map((c) => ({ ...c })),
    githubPatForm: async () => ({
      url: "https://github.com/settings/tokens/new?description=Clanker%20Yard&scopes=repo",
      scopes: ["repo"],
    }),
    setGithubPat: async (token) => {
      if (token.startsWith("bad")) throw new Error("GitHub rechazó el token: es inválido, está vencido o fue revocado. Crea uno nuevo y vuelve a pegarlo.")
      return connect({ provider: "github", account: "octocat", scopes: ["repo"], status: "active", expiresAt: now + 90 * day, expiresSoon: false, auth: "pat" })
    },
    // No hay GitHub: la cuenta queda conectada de una vez, como si el usuario ya hubiera aprobado.
    startGithubDeviceFlow: async () => {
      connect({ provider: "github", account: "octocat", scopes: [], status: "active", expiresAt: now + 183 * day, expiresSoon: false, auth: "app" })
      return { userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresIn: 900 }
    },
    githubInstallations: async () => ({ count: 1 }),
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
    defs: async (kind, opts) => defsStore.filter((d) => d.kind === kind && (opts?.includeArchived || d.archivedAt === null)).map((d) => ({ ...d })),
    defVersions: async (kind, defId) => {
      const found = needDef(kind, defId)
      const saved = bodies.get(defId) ?? new Map<number, { body: unknown; source: string; createdAt: number }>()
      // Lo que no se editó desde aquí es el seed: sus versiones viejas comparten el contenido de la primera guardada.
      const firstSaved = Math.min(...saved.keys())
      return Array.from({ length: found.currentVersion }, (_, i) => {
        const version = found.currentVersion - i
        const own = saved.get(version)
        const body = (own ?? (version < firstSaved ? saved.get(firstSaved) : undefined))?.body ?? found.body
        return { ...found, version, body, source: own?.source ?? found.source, createdAt: own?.createdAt ?? (saved.get(firstSaved)?.createdAt ?? found.createdAt) - (Number.isFinite(firstSaved) ? firstSaved - version : -i) * 60_000 }
      })
    },
    agentOptions: async () => ({
      models: [
        { id: "haiku", label: "Haiku", about: "El más rápido y barato; para tareas simples y revisiones livianas." },
        { id: "sonnet", label: "Sonnet", about: "Equilibrado: buena calidad a costo medio." },
        { id: "opus", label: "Opus", about: "Más potente y más caro; para el trabajo difícil." },
      ],
      efforts: [
        { id: "low", about: "Responde casi sin pensar: rápido y barato." },
        { id: "medium", about: "Piensa lo justo." },
        { id: "high", about: "Piensa a fondo: el punto de partida habitual." },
      ],
    }),
    updateDef: async ({ kind, id: defId, body, dryRun }) => {
      const found = writableDef(kind, defId)
      const { parsed, errors } = checkBody(kind, found.slug, body)
      if (errors.length > 0) {
        if (!dryRun) throw new Error(`No se guardó ${kind} "${found.slug}":\n` + errors.map((e) => `  ${e.path || "(raíz)"}: ${e.message}`).join("\n"))
        return { dryRun, errors, warnings: [], changed: false, diff: [], def: null }
      }
      const diff = diffLeaves(found.body, parsed)
      if (dryRun) return { dryRun, errors, warnings: [], changed: diff.length > 0, diff, def: null }
      if (diff.length === 0) return { dryRun, errors, warnings: [], changed: false, diff, def: { ...found } }
      const saved = bodies.get(defId) ?? new Map()
      saved.set(found.currentVersion, { body: found.body, source: found.source, createdAt: found.createdAt })
      found.currentVersion += 1
      found.version = found.currentVersion
      found.body = parsed
      found.source = "ui"
      found.createdAt = Date.now()
      saved.set(found.currentVersion, { body: parsed, source: "ui", createdAt: found.createdAt })
      bodies.set(defId, saved)
      return { dryRun, errors, warnings: [], changed: true, diff, def: { ...found } }
    },
    createDef: async ({ kind, slug, body }) => {
      if (defsStore.some((d) => d.kind === kind && d.slug === slug && d.scope === "user")) throw new Error(`Ya existe ${kind} "${slug}" (user): archívalo o elige otro slug.`)
      const created = def(kind, slug, body, { scope: "user", source: "ui", createdAt: Date.now() })
      defsStore.push(created)
      return { ...created }
    },
    archiveDef: async (kind, defId) => {
      const found = writableDef(kind, defId)
      found.archivedAt ??= Date.now()
      return { ...found }
    },
    restoreDef: async (kind, defId) => {
      const found = writableDef(kind, defId)
      found.archivedAt = null
      return { ...found }
    },
    trackerProjects: async (tracker) => {
      if (tracker !== "linear") throw new Error(`Clanker Yard no sabe listar los proyectos de ${tracker}: escribe el id del proyecto a mano.`)
      const linear = connections.filter((c) => c.provider === "linear")
      if (linear.length === 0) throw new Error("Linear no está conectado: conéctalo en Conexiones para elegir un proyecto.")
      return linear.flatMap((c) => TRACKER_PROJECTS.map((p) => ({ ...p, account: c.account })))
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
      const repo: Repo = { id: id("repo", repoRows.length + 1), name, path, remote: null, defaultBranch: "main", mergeStrategy: null }
      repoRows.push({ repo, recipe: { status: "missing" }, lastTest: null })
      return repo
    },
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** Las hojas que cambian entre dos bodies, como el diff del core; un arreglo se compara entero. */
function diffLeaves(before: unknown, after: unknown, path = ""): DefChange[] {
  if (isRecord(before) && isRecord(after)) return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap((key) => diffLeaves(before[key], after[key], path === "" ? key : `${path}.${key}`))
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ path, before, after }]
}
