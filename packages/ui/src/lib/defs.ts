import type { DefRecord } from "@clanker/api"
import { isInternal } from "./flows/defs-library"

/** El nombre legible de un flujo (`name` de su body) y, si la def no lo trae (un perfil), su slug. */
export function defName(def: DefRecord): string {
  const name = (def.body as { name?: unknown } | null)?.name
  return typeof name === "string" && name !== "" ? name : def.slug
}

interface RoleBody {
  model?: unknown
  effort?: unknown
}

/**
 * Una línea que dice qué es la def: de un perfil, el modelo del dev y el de los reviews ("dev sonnet high · reviews
 * sonnet/haiku"); de un flujo, su `description` si el body la trae. `undefined` si no hay nada que decir.
 */
export function defSummary(def: DefRecord): string | undefined {
  const body = def.body as { description?: unknown; roles?: Record<string, RoleBody> } | null
  if (def.kind === "flow") return typeof body?.description === "string" && body.description !== "" ? body.description : undefined
  if (def.kind !== "profile" || !body?.roles) return undefined
  const roles = Object.entries(body.roles).filter((entry): entry is [string, RoleBody & { model: string }] => typeof entry[1].model === "string")
  const dev = roles.find(([role]) => role === "dev")?.[1]
  const reviewModels = [...new Set(roles.filter(([role]) => role.startsWith("review-")).map(([, spec]) => spec.model))]
  const parts = [
    ...(dev ? [`dev ${dev.model}${typeof dev.effort === "string" ? ` ${dev.effort}` : ""}`] : []),
    ...(reviewModels.length > 0 ? [`reviews ${reviewModels.join(", ")}`] : []),
  ]
  return parts.length > 0 ? parts.join(" · ") : undefined
}

/** Los flujos que se ofrecen como flujo de un proyecto: sin los internos, salvo `keep` (el que el proyecto ya tiene). */
export function selectableFlows(flows: DefRecord[], keep?: string | null): DefRecord[] {
  return flows.filter((f) => !isInternal(f) || f.slug === keep)
}

/** El flujo que se preselecciona al crear un proyecto: `techlead-clasico` si existe y si no el primero ("" si no hay ninguno). */
export function defaultFlowSlug(flows: DefRecord[]): string {
  return (flows.find((f) => f.slug === "techlead-clasico") ?? flows[0])?.slug ?? ""
}

/** El perfil que se preselecciona: `eco` si existe y si no el primero. No hay relación entre un flujo y un perfil que lo prefiera. */
export function defaultProfileSlug(profiles: DefRecord[]): string {
  return (profiles.find((p) => p.slug === "eco") ?? profiles[0])?.slug ?? ""
}
