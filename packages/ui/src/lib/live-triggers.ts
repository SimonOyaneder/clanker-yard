import type { EventType } from "@clanker/api"

/**
 * Qué eventos le importan a una consulta en vivo: un tipo exacto (`run.finished`) o todos los de un prefijo (`run.*`).
 * Cada tipo que se nombre aquí tiene que estar en `LIVE_EVENTS` (`core-app-data.ts`), o nunca llega.
 */
export type LiveTrigger = EventType | `${string}.*`

/** Los PRs del caché: lo que Watch lee, publica o guarda local. */
export const PR_TRIGGERS: readonly LiveTrigger[] = ["pr.*", "chat.proposal", "chat.apply_started", "chat.apply_finished"]
/** Los repos registrados, con su receta, su última prueba y su remoto (que depende de la cuenta de GitHub). */
export const REPO_TRIGGERS: readonly LiveTrigger[] = ["repo.added", "recipe.test_finished", "connection.changed"]
/** Flujos, roles y perfiles: los de un pack cambian al instalarlo o sacarlo. */
export const DEF_TRIGGERS: readonly LiveTrigger[] = ["def.*", "pack.*"]
/**
 * El detalle de una corrida: pasos, decisiones y el costo de sus agentes. `agent.activity` (cada 2 s por sesión) no
 * cambia nada de eso: lo sigue solo el transcript.
 */
export const RUN_TRIGGERS: readonly LiveTrigger[] = ["run.*", "step.*", "agent.started", "agent.usage", "agent.ended", "decision.*"]
/** Lo que muestra la operación de un proyecto (corridas, issues, cola, decisiones, carriles, breakers y PRs). */
export const PROJECT_TRIGGERS: readonly LiveTrigger[] = ["project.*", "issue.*", "run.*", "step.started", "step.finished", "decision.*", "lanes.changed", "breaker.*", "pr.*"]
