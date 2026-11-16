import type { Connection } from "@clanker/api"

export type SetupStepId = "github" | "linear" | "claude" | "repo" | "project"

export interface SetupStep {
  id: SetupStepId
  label: string
  /** Para qué sirve, en una línea. */
  hint: string
  done: boolean
}

/**
 * Lo que hace falta para lanzar la primera corrida, en el orden en que conviene hacerlo. Una conexión cuenta aunque haya
 * vencido: eso ya lo avisa el punto rojo de Conexiones, y esto es solo la configuración inicial.
 */
export function setupSteps({ connections, repos, projects }: { connections: readonly Pick<Connection, "provider">[]; repos: number; projects: number }): SetupStep[] {
  const connected = (provider: Connection["provider"]) => connections.some((c) => c.provider === provider)
  return [
    { id: "github", label: "Conectar GitHub", hint: "Los agentes hacen push y abren los PRs con tu cuenta.", done: connected("github") },
    { id: "linear", label: "Conectar Linear", hint: "De ahí salen las issues que se trabajan.", done: connected("linear") },
    { id: "claude", label: "Probar Claude", hint: "Los agentes usan tu Claude Code; la prueba lo detecta.", done: connected("claude") },
    { id: "repo", label: "Agregar un repo", hint: "El checkout local donde trabajan los agentes.", done: repos > 0 },
    { id: "project", label: "Crear un proyecto", hint: "Junta un proyecto de Linear con el flujo que lo trabaja.", done: projects > 0 },
  ]
}
