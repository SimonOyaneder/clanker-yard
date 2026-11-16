import { type ClankerProject, type DefRecord, type DefScope, type DefWriteKind, FlowDef } from "@clanker/api"

// La biblioteca de flujos, roles y perfiles (`docs/design.html#d-flows`): de dónde viene cada def, quién la usa y
// qué pasa al duplicarla. Todo sale de las defs y los proyectos; nada aquí habla con el core.

export const KIND_LABEL: Record<DefWriteKind, { plural: string; singular: string }> = {
  flow: { plural: "Flujos", singular: "flujo" },
  role: { plural: "Roles", singular: "rol" },
  profile: { plural: "Perfiles", singular: "perfil" },
}

export const SCOPE_LABEL: Record<DefScope, string> = { builtin: "Incluido", pack: "Pack", user: "Tuyo", repo: "Del repo" }

export const SCOPE_HINT: Record<DefScope, string> = {
  builtin: "Viene con la app. No se edita: duplícalo para tener uno tuyo.",
  pack: "Lo trae un pack. No se edita: duplícalo para tener uno tuyo.",
  user: "Lo creaste tú (o un agente por ti). Se puede archivar.",
  repo: "Vive en el repo y solo vale ahí. Se puede archivar.",
}

// Quién gana cuando varias defs comparten slug: la de la izquierda (igual que `defs.resolve` del core).
const PRECEDENCE: readonly DefScope[] = ["user", "repo", "pack", "builtin"]

/** `builtin` y `pack` los regenera el core: no se editan ni se archivan. */
export const isReadOnly = (def: Pick<DefRecord, "scope">) => def.scope === "builtin" || def.scope === "pack"

const bodyField = (def: Pick<DefRecord, "body">, field: string): unknown => (typeof def.body === "object" && def.body !== null ? (def.body as Record<string, unknown>)[field] : undefined)

/**
 * Un flujo interno lo lanzan otros flujos o el sistema (feedback de PR, rebase, mantenimiento): no se elige como
 * flujo de un proyecto. Lo marca `internal: true` en el body del flujo.
 */
export const isInternal = (def: DefRecord) => def.kind === "flow" && bodyField(def, "internal") === true

export function nameOf(def: DefRecord): string {
  const name = bodyField(def, "name")
  return typeof name === "string" && name !== "" ? name : def.slug
}

export interface LibraryRow {
  def: DefRecord
  /** Hay una def vigente del mismo slug con más precedencia: la de este scope es la que manda, y esta queda de respaldo. */
  overriddenBy: DefScope | null
  /** Esta def manda sobre otra vigente del mismo slug (`builtin` o `pack`). */
  overrides: DefScope | null
  /** Los proyectos que la usan hoy: solo cuenta la que manda para su slug. */
  projects: ClankerProject[]
  internal: boolean
}

/** Los roles de los nodos `agent` del flujo y de los subflujos que lanza. */
function rolesOfFlow(slug: string, winners: ReadonlyMap<string, DefRecord>, seen = new Set<string>()): Set<string> {
  const roles = new Set<string>()
  const def = winners.get(slug)
  if (!def || seen.has(slug)) return roles
  seen.add(slug)
  const parsed = FlowDef.safeParse(def.body)
  if (!parsed.success) return roles
  for (const top of Object.values(parsed.data.nodes)) {
    const inner = top.type === "parallel" && !Array.isArray(top.branches) ? [top, top.branches.branch] : [top]
    for (const node of inner) {
      if (node.type === "agent") roles.add(node.role)
      else if (node.type === "flow") for (const role of rolesOfFlow(node.flow, winners, seen)) roles.add(role)
    }
  }
  return roles
}

/**
 * Las filas de un kind, con su origen y los proyectos que la usan. `flows` son todos los flujos (con archivados):
 * un rol se usa donde lo usa el flujo de un proyecto.
 */
export function libraryRows(kind: DefWriteKind, defs: readonly DefRecord[], flows: readonly DefRecord[], projects: readonly ClankerProject[]): LibraryRow[] {
  const winners = winnersBySlug(defs)
  const flowWinners = winnersBySlug(flows)
  const usedBy = (def: DefRecord): ClankerProject[] => {
    if (winners.get(def.slug)?.id !== def.id) return []
    if (kind === "flow") return projects.filter((p) => p.defaultFlowId === def.slug)
    if (kind === "profile") return projects.filter((p) => p.defaultProfileId === def.slug)
    return projects.filter((p) => p.defaultFlowId !== null && rolesOfFlow(p.defaultFlowId, flowWinners).has(def.slug))
  }
  return defs.map((def) => {
    const winner = def.archivedAt === null ? winners.get(def.slug) : undefined
    const overriddenBy = winner && winner.id !== def.id ? winner.scope : null
    const lower = winner?.id === def.id ? defs.filter((d) => d.slug === def.slug && d.id !== def.id && d.archivedAt === null && isReadOnly(d)) : []
    return { def, overriddenBy, overrides: lower[0]?.scope ?? null, projects: usedBy(def), internal: isInternal(def) }
  })
}

function winnersBySlug(defs: readonly DefRecord[]): Map<string, DefRecord> {
  const winners = new Map<string, DefRecord>()
  for (const def of defs) {
    if (def.archivedAt !== null) continue
    const current = winners.get(def.slug)
    if (!current || PRECEDENCE.indexOf(def.scope) < PRECEDENCE.indexOf(current.scope)) winners.set(def.slug, def)
  }
  return winners
}

export interface Duplicate {
  slug: string
  body: unknown
  /** El duplicado toma el slug de un incluido o de un pack y pasa a mandar sobre él. */
  overrides: boolean
}

/**
 * Lo que crea "Duplicar": de un incluido o de un pack, uno tuyo con el mismo slug (pasa a mandar); de uno tuyo o del
 * repo, una copia con slug libre (`-copia`, `-copia-2`...), porque el slug ya es tuyo.
 */
export function duplicateOf(def: DefRecord, defs: readonly DefRecord[]): Duplicate {
  const overrides = isReadOnly(def)
  const taken = new Set(defs.filter((d) => d.scope === "user").map((d) => d.slug))
  let slug = def.slug
  if (!overrides) {
    slug = `${def.slug}-copia`
    for (let n = 2; taken.has(slug); n++) slug = `${def.slug}-copia-${n}`
  }
  let body = def.body
  if (def.kind === "flow" && typeof body === "object" && body !== null) {
    // El `id` del flujo es su slug; la copia se distingue también por el nombre.
    const flow = body as { name?: unknown }
    body = { ...flow, id: slug, ...(overrides ? {} : { name: `${nameOf(def)} (copia)` }) }
  }
  return { slug, body, overrides }
}

const SOURCE_LABEL: Record<string, string> = { builtin: "la app", ui: "esta app", cli: "la línea de comandos", mcp: "un agente (MCP)", repo: "el repo", import: "una importación" }

/** Quién guardó una versión, en palabras. */
export const sourceLabel = (source: string) => SOURCE_LABEL[source] ?? source
