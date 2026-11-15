import type { Client, EventType } from "@clanker/api"
import type { AppData } from "@/app-data"

/** Lo que la UI usa de la API; lo cumple tanto el cliente real como un `createRouterClient` en un test. */
export type CoreClient = Pick<Client, "projects" | "issues" | "runs" | "artifacts" | "events" | "connections" | "repos">

// Lo que mueve lo que la UI muestra (proyectos, issues, corridas y sus pasos, las sesiones de agente que el
// panel del paso y su transcript siguen en vivo, conexiones y pruebas de receta).
const LIVE_EVENTS = [
  "project.created",
  "project.updated",
  "project.paused",
  "project.resumed",
  "project.archived",
  "issue.synced",
  "pr.opened",
  "issue.queued",
  "issue.claimed",
  "issue.skipped",
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
  "connection.changed",
  "recipe.test_started",
  "recipe.test_output",
  "recipe.test_finished",
] as const satisfies readonly EventType[]

const EVENTS_PAGE = 500

/** Cómo terminó la última prueba de receta de cada repo, según los eventos `recipe.test_finished`. */
async function lastRecipeTests(client: CoreClient): Promise<Map<string, { ok: boolean; at: number }>> {
  const last = new Map<string, { ok: boolean; at: number }>()
  let after = 0
  for (;;) {
    const page = await client.events.list({ after, limit: EVENTS_PAGE, filter: { types: ["recipe.test_finished"] } })
    for (const event of page) {
      const repoId = event.payload.repoId
      if (typeof repoId === "string") last.set(repoId, { ok: event.payload.ok === true, at: event.ts })
    }
    if (page.length < EVENTS_PAGE) return last
    after = page[page.length - 1]!.seq
  }
}

/** El `AppData` real: la API del core por el cliente oRPC. */
export function createCoreAppData(client: CoreClient): AppData {
  return {
    projects: () => client.projects.list(),
    createProject: (input) => client.projects.create(input),
    issues: (projectId) => client.issues.list({ projectId }),
    queue: (projectId) => client.projects.queue({ id: projectId }),
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
    steerStep: (stepId, message) => client.runs.steerStep({ stepId, message }),
    forceOutcome: (stepId, outcome) => client.runs.forceOutcome({ stepId, outcome }),
    pauseProject: (id) => client.projects.pause({ id }),
    resumeProject: (id) => client.projects.resume({ id }),
    events: (after, signal) => client.events.stream({ after, filter: { types: [...LIVE_EVENTS] } }, { signal }),
    // El core todavía no sirve PRs (el caché de PRs con sus eventos es de una fase posterior).
    prs: () => Promise.reject(new Error("El core todavía no sirve PRs: llegan con el caché de PRs.")),
    connections: () => client.connections.list(),
    githubPatForm: () => client.connections.githubPatForm(),
    setGithubPat: (token) => client.connections.setPat({ token }),
    linearAuth: async () => (await client.connections.linearAuth()).url,
    testClaude: (mode) => client.connections.testClaude(mode ? { mode } : {}),
    setClaudeApiKey: (key) => client.connections.setClaudeApiKey({ key }),
    disconnect: (provider, account) => client.connections.disconnect({ provider, account }),
    repos: async () => {
      const [repos, tests] = await Promise.all([client.repos.list(), lastRecipeTests(client)])
      return Promise.all(
        repos.map(async (repo) => {
          // `detect` sobre la propia carpeta del repo devuelve su receta; si la carpeta ya no existe, eso es lo que dice la fila.
          const recipe = await client.repos.detect({ folder: repo.path }).then(
            ([found]) => found?.recipe ?? ({ status: "missing" } as const),
            (e: unknown) => ({ status: "invalid", message: e instanceof Error ? e.message : String(e) }) as const,
          )
          return { repo, recipe, lastTest: tests.get(repo.id) ?? null }
        }),
      )
    },
    testRecipe: (repoId) => client.repos.testRecipe({ repoId }),
    addRepo: (path) => client.repos.add({ path }),
  }
}
