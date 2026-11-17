import type { Client, EventType } from "@clanker/api"
import type { AppData } from "@/app-data"
import { messageOf } from "@/lib/utils"

/** Lo que la UI usa de la API; lo cumple tanto el cliente real como un `createRouterClient` en un test. */
export type CoreClient = Pick<Client, "system" | "projects" | "issues" | "runs" | "decisions" | "prs" | "artifacts" | "events" | "learnings" | "connections" | "repos" | "metrics" | "defs" | "trackers" | "packs">

// Lo que mueve lo que la UI muestra (proyectos, issues, corridas y sus pasos, las sesiones de agente que el
// panel del paso y su transcript siguen en vivo, las decisiones de la bandeja, los learnings, conexiones y pruebas de receta).
const LIVE_EVENTS = [
  "project.created",
  "project.updated",
  "project.paused",
  "project.resumed",
  "project.archived",
  "project.defaults_changed",
  "lanes.changed",
  "repo.added",
  "issue.synced",
  "pr.opened",
  "issue.queued",
  "issue.claimed",
  "issue.skipped",
  "breaker.opened",
  "breaker.closed",
  "pr.changed",
  "pr.merged",
  "run.started",
  "run.status",
  "run.parked",
  "run.requeued",
  "run.borrowed",
  "run.returned",
  "run.finished",
  "step.started",
  "step.waiting",
  "step.finished",
  "step.retrying",
  "step.commanded",
  "agent.started",
  "agent.activity",
  "agent.usage",
  "agent.ended",
  "decision.opened",
  "decision.resolved",
  "def.versioned",
  "def.archived",
  "def.restored",
  "learning.proposed",
  "learning.approved",
  "learning.rejected",
  "learning.updated",
  "pack.installed",
  "pack.removed",
  "connection.changed",
  "connection.login_failed",
  "recipe.test_started",
  "recipe.test_output",
  "recipe.test_finished",
] as const satisfies readonly EventType[]

/** El `AppData` real: la API del core por el cliente oRPC. */
export function createCoreAppData(client: CoreClient): AppData {
  return {
    projects: () => client.projects.list(),
    createProject: (input) => client.projects.create(input),
    updateProject: (input) => client.projects.update(input),
    skipIssue: async (input) => void (await client.projects.skipIssue(input)),
    boostIssue: async (input) => void (await client.projects.boostIssue(input)),
    lanes: () => client.system.lanes(),
    setLanes: (patch) => client.system.setLanes(patch),
    projectDefaults: () => client.projects.defaults(),
    setProjectDefaults: (patch) => client.projects.setDefaults(patch),
    packs: () => client.packs.list(),
    installPack: (path) => client.packs.install({ path }),
    removePack: (id) => client.packs.remove({ id }),
    coreInfo: async () => {
      const { dataDir, linearClientId, githubApp } = await client.system.info()
      return { dataDir, linearClientId, githubApp }
    },
    breakers: () => client.system.breakers(),
    openPrs: async () => [...await client.prs.list({ state: "open" }), ...await client.prs.list({ state: "local" })],
    refreshPrs: async (refs) => {
      // El core lee de a una request: en serie y sin cortar en el primer fallo, que se reporta al final.
      const failures: string[] = []
      for (const ref of refs) {
        await client.prs.refresh(ref).catch((e: unknown) => failures.push(`${ref.repo}#${ref.number}: ${messageOf(e)}`))
      }
      if (failures.length) throw new Error(`No pude actualizar ${failures.length === 1 ? "un PR" : `${failures.length} PRs`}: ${failures.join("; ")}`)
    },
    setPrHold: async (input) => void (await client.prs.setHold(input)),
    mergePr: async (ref) => void (await client.prs.merge(ref)),
    requestPrReview: async (ref) => void (await client.prs.requestReview(ref)),
    rebasePr: async (ref) => void (await client.prs.rebase(ref)),
    issues: (projectId) => client.issues.list({ projectId }),
    queue: (projectId) => client.projects.queue({ id: projectId }),
    projectMetrics: async (projectId, range) => {
      const scope = { projectId, ...range }
      const [summary, byDay, byModel, byStep, byIssue, roles] = await Promise.all([
        client.projects.summary({ id: projectId, ...range }),
        client.metrics.byDay({ ...scope, utcOffsetMinutes: -new Date().getTimezoneOffset() }),
        client.metrics.byModel(scope),
        client.metrics.byStep(scope),
        client.metrics.byIssue(scope),
        client.metrics.byRole({ projectId }),
      ])
      return { summary, byDay, byModel, byStep, byIssue, roles: roles.map((r) => r.role).sort() }
    },
    runs: (filter) => client.runs.list(filter),
    run: (id) => client.runs.get({ id }),
    step: (id) => client.runs.step({ id }),
    transcript: (sessionId, cursor) => client.runs.transcript({ sessionId, cursor }),
    artifact: async (hash) => (await client.artifacts.get({ hash })).content.text(),
    startRun: (input) => client.runs.start(input),
    pauseRun: (id, opts) => client.runs.pause({ id, now: opts?.now ?? false }),
    resumeRun: (id) => client.runs.resume({ id }),
    cancelRun: (id) => client.runs.cancel({ id }),
    interruptRun: (id) => client.runs.interrupt({ id }),
    retryStep: (stepId) => client.runs.retryStep({ stepId }),
    steerStep: (input) => client.runs.steerStep(input),
    forceOutcome: (input) => client.runs.forceOutcome(input),
    pauseProject: (id) => client.projects.pause({ id }),
    resumeProject: (id) => client.projects.resume({ id }),
    events: (after, signal) => client.events.stream({ after, filter: { types: [...LIVE_EVENTS] } }, { signal }),
    decisions: (filter) => client.decisions.list(filter),
    resolveDecision: (input) => client.decisions.resolve(input),
    learnings: () => client.learnings.list(),
    proposeLearning: (learning) => client.learnings.propose(learning),
    approveLearning: (id) => client.learnings.approve({ id }),
    rejectLearning: (id) => client.learnings.reject({ id }),
    updateLearning: (patch) => client.learnings.update(patch),
    screenLearnings: () => client.learnings.screen({}),
    archiveLearnings: (ids) => client.learnings.archive({ ids }),
    connections: () => client.connections.list(),
    githubPatForm: () => client.connections.githubPatForm(),
    setGithubPat: (token) => client.connections.setPat({ token }),
    startGithubDeviceFlow: () => client.connections.startDeviceFlow(),
    githubInstallations: () => client.connections.githubInstallations(),
    linearAuth: async () => (await client.connections.linearAuth()).url,
    testClaude: (mode) => client.connections.testClaude(mode ? { mode } : {}),
    setClaudeApiKey: (key) => client.connections.setClaudeApiKey({ key }),
    disconnect: (input) => client.connections.disconnect(input),
    defs: (kind, opts) => client.defs.list({ kind, includeArchived: opts?.includeArchived ?? false }),
    defVersions: async (kind, id) => {
      const current = await client.defs.get({ kind, id })
      const older = Array.from({ length: current.currentVersion - 1 }, (_, i) => client.defs.get({ kind, id, version: current.currentVersion - 1 - i }))
      return [current, ...(await Promise.all(older))]
    },
    createDef: async ({ kind, slug, body }) => {
      const { def } = await client.defs.create({ kind, slug, scope: "user", body, dryRun: false })
      if (!def) throw new Error(`El core no devolvió el ${kind} ${slug} que acaba de crear.`)
      return def
    },
    agentOptions: () => client.defs.agentOptions(),
    updateDef: (input) => client.defs.update(input),
    archiveDef: (input) => client.defs.archive(input),
    restoreDef: (input) => client.defs.restore(input),
    trackerProjects: (tracker) => client.trackers.projects({ tracker }),
    repos: () => client.repos.overview(),
    testRecipe: (repoId) => client.repos.testRecipe({ repoId }),
    addRepo: (path) => client.repos.add({ path }),
    exportDefToRepo: (input) => client.defs.exportToRepo(input),
    syncRepoConfig: (repoId) => client.repos.syncConfig({ repoId }),
    exportProjectConfig: (id) => client.projects.exportConfig({ id }),
    importProjectConfig: ({ projectId, config, dryRun }) => client.projects.importConfig({ id: projectId, config, dryRun }),
  }
}
