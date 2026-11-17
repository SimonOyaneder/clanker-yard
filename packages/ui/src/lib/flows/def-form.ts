import type { ContextSource, Profile, ProfileRole, Role, ToolPolicy } from "@clanker/api"

// Lo que los formularios de perfil y de rol necesitan para convertir el body de la def en campos y de vuelta.
// Nada aquí valida: eso lo hace `defs.update` con `dryRun` antes de guardar.

/** Una línea que dice qué modelo usa el perfil para lo que más pesa en el costo: "dev opus high · reviews haiku". */
export function profileSummary(profile: Profile): string {
  const { dev, ...others } = profile.roles
  const reviews = [...new Set(Object.entries(others).filter(([role]) => role.startsWith("review-")).map(([, spec]) => spec.model))]
  return [dev ? `dev ${dev.model}${dev.effort ? ` ${dev.effort}` : ""}` : null, reviews.length > 0 ? `reviews ${reviews.join(", ")}` : null].filter(Boolean).join(" · ")
}

/** El perfil con ese rol reemplazado; un `effort` en `undefined` se quita (queda el esfuerzo por defecto del modelo). */
export function withRole(profile: Profile, role: string, spec: ProfileRole): Profile {
  const { effort, ...rest } = spec
  return { ...profile, roles: { ...profile.roles, [role]: effort === undefined ? rest : { ...rest, effort } } }
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/

/** `null` si sirve como slug de una def nueva; si no, qué corregir. */
export function slugProblem(slug: string, taken: readonly string[]): string | null {
  if (!SLUG.test(slug)) return "Usa solo minúsculas, números y guiones, empezando por una letra o un número."
  if (taken.includes(slug)) return `Ya existe "${slug}": elige otro nombre.`
  return null
}

/** Los ids separados por comas o saltos de línea, sin vacíos ni repetidos. */
export const splitList = (text: string): string[] => [...new Set(text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean))]

/** Lo que el formulario de un rol edita; el resto del rol (modos, esquema de salida, hooks) no se toca. */
export interface RoleDraft {
  prompt: string
  /** Ids de los paquetes de contexto (`ContextSource` de kind `pack`). */
  packs: string[]
  /** `true` si el rol puede usar todas las herramientas. */
  allTools: boolean
  allow: string
  deny: string
}

export function roleDraftOf(role: Role): RoleDraft {
  const tools = role.tools
  const restricted = tools !== undefined && tools !== "all" && (tools.allow !== undefined || tools.deny !== undefined)
  return {
    prompt: role.prompt,
    packs: role.context.flatMap((c) => (c.kind === "pack" ? [c.id] : [])),
    allTools: !restricted,
    allow: restricted && typeof tools === "object" ? (tools.allow ?? []).join("\n") : "",
    deny: restricted && typeof tools === "object" ? (tools.deny ?? []).join("\n") : "",
  }
}

/** El rol con lo que el formulario cambió. Las otras fuentes de contexto (`native`, `repo`, `file`) quedan donde estaban. */
export function roleFromDraft(role: Role, draft: RoleDraft): Role {
  const others: ContextSource[] = role.context.filter((c) => c.kind !== "pack")
  const rest = { ...role }
  delete rest.tools
  const allow = splitList(draft.allow)
  const deny = splitList(draft.deny)
  const restricted = !draft.allTools && (allow.length > 0 || deny.length > 0)
  const tools: ToolPolicy | undefined = restricted ? { ...(allow.length > 0 ? { allow } : {}), ...(deny.length > 0 ? { deny } : {}) } : role.tools === undefined ? undefined : "all"
  return { ...rest, prompt: draft.prompt, context: [...others, ...draft.packs.map((id): ContextSource => ({ kind: "pack", id }))], ...(tools === undefined ? {} : { tools }) }
}
