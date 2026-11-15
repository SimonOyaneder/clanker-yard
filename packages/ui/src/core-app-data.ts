import type { Client, EventType } from "@clanker/api"
import type { AppData } from "@/app-data"

/** Lo que la UI usa de la API; lo cumple tanto el cliente real como un `createRouterClient` en un test. */
export type CoreClient = Pick<Client, "projects" | "issues" | "runs" | "artifacts" | "events">

// Lo que mueve lo que la UI muestra (proyectos, issues, corridas y sus pasos, y las sesiones de agente
// que el panel del paso y su transcript siguen en vivo).
const LIVE_EVENTS = [
  "project.created",
  "project.updated",
  "project.paused",
  "project.resumed",
  "project.archived",
  "issue.synced",
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
  "agent.started",
  "agent.activity",
  "agent.usage",
  "agent.ended",
] as const satisfies readonly EventType[]

/** El `AppData` real: la API del core por el cliente oRPC. */
export function createCoreAppData(client: CoreClient): AppData {
  return {
    projects: () => client.projects.list(),
    createProject: (input) => client.projects.create(input),
    issues: (projectId) => client.issues.list({ projectId }),
    runs: (filter) => client.runs.list(filter),
    run: (id) => client.runs.get({ id }),
    step: (id) => client.runs.step({ id }),
    transcript: (sessionId, cursor) => client.runs.transcript({ sessionId, cursor }),
    artifact: async (hash) => (await client.artifacts.get({ hash })).content.text(),
    startRun: (input) => client.runs.start(input),
    events: (after, signal) => client.events.stream({ after, filter: { types: [...LIVE_EVENTS] } }, { signal }),
    // El core todavía no sirve PRs (el caché de PRs con sus eventos es de una fase posterior).
    prs: () => Promise.reject(new Error("El core todavía no sirve PRs: llegan con el caché de PRs.")),
  }
}
