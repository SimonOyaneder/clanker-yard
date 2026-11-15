import type { ClankerProject, Conventions, DefRecord, ProjectPatch, StackOn, StatusCategory } from "@clanker/api"
import { FlowDef } from "@clanker/api"

// El modelo de la pestaña Ajustes: lo que el formulario edita (`Draft`, solo texto y listas), cómo sale de un proyecto,
// qué le falta para guardarse y qué `ProjectPatch` produce. Un campo vacío siempre significa "el default": el del
// core (la cola mira `todo`, excluye `no-clanker`) o el del flujo (un parámetro sin valor usa su `default`).

export const STATUS_CATEGORIES: readonly StatusCategory[] = ["backlog", "todo", "in_progress", "in_review", "done", "canceled"]

export const CATEGORY_LABELS: Record<StatusCategory, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "En progreso",
  in_review: "En review",
  done: "Hecha",
  canceled: "Cancelada",
}

export const STACK_ON_OPTIONS: { value: StackOn; label: string; hint: string }[] = [
  { value: "ready", label: "Lista", hint: "Cuando el flujo del bloqueante terminó bien." },
  { value: "ci_green", label: "CI verde", hint: "Cuando su PR está abierto, en draft o no, y el CI pasó aunque falte el LGTM." },
  { value: "any_open", label: "PR abierto", hint: "Apenas el bloqueante tiene un PR abierto." },
]

/** Los valores que acepta `rebaseNonDraft`: la política del flujo que rebasea un PR en conflicto. */
const PARAM_CHOICES: Record<string, { value: string; label: string }[]> = {
  rebaseNonDraft: [
    { value: "auto", label: "Rebasear sin preguntar" },
    { value: "ask", label: "Pedir mi OK antes de rebasear" },
  ],
}

/** El nombre humano y la ayuda de los parámetros que los flujos del core declaran; uno desconocido sale con su nombre. */
const PARAM_TEXT: Record<string, { label: string; help: string }> = {
  reviewRounds: { label: "Rondas de review", help: "Cuántas veces los reviewers pueden devolver el trabajo al dev antes de seguir con lo que quede." },
  checkRounds: { label: "Rondas de checks", help: "Cuántas veces se corrigen los tests o el lint rojos antes de seguir." },
  externalRounds: { label: "Rondas de feedback externo", help: "Cuántas rondas de comentarios del bot, el CI y las personas atiende el flujo de un PR." },
  conflictRounds: { label: "Rondas de conflicto", help: "Cuántas vueltas puede dar un agente resolviendo los conflictos de un rebase." },
  rebaseNonDraft: { label: "Rebase de un PR fuera de draft", help: "Si el rebase de un PR que ya no está en draft se hace solo o espera tu OK." },
}

export const paramLabel = (name: string): string => PARAM_TEXT[name]?.label ?? name
export const paramHelp = (name: string): string | undefined => PARAM_TEXT[name]?.help
export const paramChoices = (name: string) => PARAM_CHOICES[name]

/** Un parámetro con default de un flujo, editable en Ajustes. */
export interface ParamSpec {
  name: string
  type: "number" | "string" | "boolean"
  /** El default que usa el flujo por defecto, o el que comparten todos los que lo leen; `null` si cada flujo usa el suyo. */
  default: string | number | boolean | null
  /** Cada flujo que declara el parámetro, con su default. */
  flows: { slug: string; default: string | number | boolean }[]
}

export interface FlowParamGroups {
  /** Los del flujo por defecto: las corridas que lanza el Scheduler. */
  own: ParamSpec[]
  /** Los que solo declaran flujos que arrancan solos (rebase, feedback de un PR): el proyecto los pisa igual. */
  triggered: ParamSpec[]
}

const scalar = (value: unknown): value is string | number | boolean => ["string", "number", "boolean"].includes(typeof value)

/** Los parámetros que el core pone en cada corrida (el repo, su base, el PR): `flowParams` no los edita desde Ajustes. */
const SET_BY_CORE = new Set(["repo", "base", "branch", "pr"])

const AUTOMATIC_TRIGGERS = new Set(["pr.comment", "pr.conflict", "pr.merged", "pr.base_rewritten"])

/**
 * Cada parámetro con default de los flujos vigentes, agrupado por nombre. Con `readersOnly` solo cuentan los flujos que
 * leen los `flowParams` del proyecto: el por defecto y los que arrancan solos (`startTriggers`); los demás reciben sus params de quien los lanza.
 */
export function allParamSpecs(flows: readonly DefRecord[], defaultFlow: string | null, { readersOnly = false } = {}): ParamSpec[] {
  const byName = new Map<string, ParamSpec>()
  for (const def of flows) {
    const parsed = FlowDef.safeParse(def.body)
    if (!parsed.success) continue
    if (readersOnly && def.slug !== defaultFlow && !AUTOMATIC_TRIGGERS.has(parsed.data.trigger.type)) continue
    for (const [name, spec] of Object.entries(parsed.data.params ?? {})) {
      if (typeof spec === "string" || !scalar(spec.default) || SET_BY_CORE.has(name)) continue
      const found = byName.get(name) ?? { name, type: typeof spec.default as ParamSpec["type"], default: spec.default, flows: [] }
      found.flows.push({ slug: def.slug, default: spec.default })
      byName.set(name, found)
    }
  }
  return [...byName.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((spec) => {
      const mine = spec.flows.find((f) => f.slug === defaultFlow)
      const agreed = spec.flows.every((f) => f.default === spec.flows[0]!.default)
      return { ...spec, default: mine ? mine.default : agreed ? spec.flows[0]!.default : null }
    })
}

/** Qué parámetros se editan según el flujo por defecto: los suyos, y los que solo leen los flujos que arrancan solos. */
export function flowParamGroups(flows: readonly DefRecord[], defaultFlow: string | null): FlowParamGroups {
  const specs = allParamSpecs(flows, defaultFlow, { readersOnly: true })
  const own = specs.filter((s) => s.flows.some((f) => f.slug === defaultFlow))
  return { own, triggered: specs.filter((s) => !own.includes(s)) }
}

export interface ConventionsDraft {
  commentPrefix: string
  councilPrefix: string
  commits: "" | "conventional"
  noAiAttribution: "" | "yes" | "no"
  prTemplate: string
  omitSections: string[]
}

export interface Draft {
  repos: { repoId: string; labels: string[] }[]
  status: StatusCategory[]
  labels: string[]
  excludeLabels: string[]
  statusMapping: Record<string, StatusCategory>
  defaultFlowId: string | null
  defaultProfileId: string | null
  /** Un texto por parámetro: vacío es el default del flujo. Incluye los que hoy ningún flujo declara, para no perderlos. */
  params: Record<string, string>
  conventions: ConventionsDraft
  stackOn: StackOn
  /** Vacío es sin tope. */
  maxCostUsd: string
}

/** Los nombres de parámetro que Ajustes administra: los demás `flowParams` (el `repo` de un flujo, por ejemplo) no se tocan. */
export const managedParams = (flows: readonly DefRecord[]): string[] => allParamSpecs(flows, null).map((s) => s.name)

export function draftOf(project: ClankerProject, managed: readonly string[]): Draft {
  const c = project.conventions
  return {
    repos: project.repos.map((r) => ({ repoId: r.repoId, labels: [...r.labels] })),
    status: [...(project.queueFilter.status ?? [])],
    labels: [...(project.queueFilter.labels ?? [])],
    excludeLabels: [...(project.queueFilter.excludeLabels ?? [])],
    statusMapping: { ...project.statusMapping },
    defaultFlowId: project.defaultFlowId,
    defaultProfileId: project.defaultProfileId,
    params: Object.fromEntries(managed.filter((name) => name in project.flowParams).map((name) => [name, String(project.flowParams[name])])),
    conventions: {
      commentPrefix: c.commentPrefix ?? "",
      councilPrefix: c.councilPrefix ?? "",
      commits: c.commits ?? "",
      noAiAttribution: c.noAiAttribution === undefined ? "" : c.noAiAttribution ? "yes" : "no",
      prTemplate: c.pr?.template ?? "",
      omitSections: [...(c.pr?.omitSections ?? [])],
    },
    stackOn: project.stackOn,
    maxCostUsd: project.maxCostUsd === null ? "" : String(project.maxCostUsd),
  }
}

/** Compara por valor sin importar el orden de las claves. */
export function same(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).sort(([x], [y]) => x.localeCompare(y)).map(([k, v]) => [k, canonical(v)]))
        : value
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

export type Problems = Record<string, string>

/** Qué impide guardar y cómo arreglarlo, por campo (`repo:<id>`, `labels`, `param:<nombre>`...). Sin problemas, `{}`. */
export function validate(draft: Draft, params: readonly ParamSpec[]): Problems {
  const problems: Problems = {}

  const owner = new Map<string, string>()
  for (const { repoId, labels } of draft.repos) {
    for (const label of labels) {
      const other = owner.get(label)
      if (other !== undefined && other !== repoId) problems[`repo:${repoId}`] = `El label "${label}" ya manda a otro repo del proyecto: déjalo en uno solo.`
      owner.set(label, repoId)
    }
  }

  const both = draft.labels.find((label) => draft.excludeLabels.includes(label))
  if (both !== undefined) problems.excludeLabels = `"${both}" está en los labels que se piden y en los que se excluyen: la cola quedaría vacía. Quítalo de uno.`

  for (const spec of params) {
    const text = (draft.params[spec.name] ?? "").trim()
    if (text === "") continue
    if (spec.type === "number") {
      const n = Number(text)
      const integer = spec.flows.every((f) => Number.isInteger(f.default))
      const usual = spec.default === null ? "cada flujo usa el suyo" : `el flujo usa ${spec.default}`
      if (!Number.isFinite(n) || (integer ? !Number.isInteger(n) || n < 1 : n <= 0)) {
        problems[`param:${spec.name}`] = integer
          ? `Escribe un entero de 1 en adelante (${usual}), o déjalo vacío para usar ese valor.`
          : `Escribe un número mayor que 0 (${usual}), o déjalo vacío para usar ese valor.`
      }
    } else if (spec.type === "boolean" && text !== "true" && text !== "false") {
      problems[`param:${spec.name}`] = "Elige sí o no, o déjalo vacío para usar el default del flujo."
    } else if (paramChoices(spec.name) && !paramChoices(spec.name)!.some((c) => c.value === text)) {
      problems[`param:${spec.name}`] = `Elige ${paramChoices(spec.name)!.map((c) => `"${c.value}"`).join(" o ")}, o déjalo vacío para usar el default del flujo.`
    }
  }

  const cost = draft.maxCostUsd.trim()
  if (cost !== "" && !(Number(cost) > 0 && Number.isFinite(Number(cost)))) {
    problems.maxCostUsd = "Escribe un monto en dólares mayor que 0 (por ejemplo 5), o déjalo vacío para no poner tope."
  }

  const template = draft.conventions.prTemplate.trim()
  if (template && (template.startsWith("/") || template.split("/").includes(".."))) {
    problems.prTemplate = "Escribe una ruta relativa al pack o al repo, sin `/` al inicio ni `..`."
  }
  return problems
}

const trimmed = (text: string) => text.trim()

function conventionsOf(draft: ConventionsDraft, current: Conventions): Conventions {
  const c = draft
  return {
    ...(trimmed(c.commentPrefix) && { commentPrefix: trimmed(c.commentPrefix) }),
    ...(trimmed(c.councilPrefix) && { councilPrefix: trimmed(c.councilPrefix) }),
    ...(c.commits && { commits: c.commits }),
    ...(c.noAiAttribution && { noAiAttribution: c.noAiAttribution === "yes" }),
    ...((trimmed(c.prTemplate) || c.omitSections.length) && {
      pr: { ...(trimmed(c.prTemplate) && { template: trimmed(c.prTemplate) }), ...(c.omitSections.length && { omitSections: c.omitSections }) },
    }),
    // El contexto por rol no se edita aquí: se conserva tal cual.
    ...(current.context && { context: current.context }),
  }
}

function paramValue(spec: ParamSpec | undefined, text: string): string | number | boolean {
  if (spec?.type === "number") return Number(text)
  if (spec?.type === "boolean") return text === "true"
  return text
}

/**
 * Lo que cambió el formulario respecto de `base`, como `projects.update`: solo las secciones distintas. `specs`
 * da el tipo de cada parámetro; los `flowParams` que el formulario no administra (el `repo` de un flujo) quedan igual.
 */
export function patchOf(draft: Draft, base: Draft, project: ClankerProject, specs: readonly ParamSpec[]): ProjectPatch {
  const patch: ProjectPatch = {}
  if (!same(draft.repos, base.repos)) patch.repos = draft.repos.map((r) => ({ repoId: r.repoId as ClankerProject["repos"][number]["repoId"], labels: r.labels }))
  if (!same([draft.status, draft.labels, draft.excludeLabels], [base.status, base.labels, base.excludeLabels])) {
    patch.queueFilter = {
      ...(draft.status.length && { status: draft.status }),
      ...(draft.labels.length && { labels: draft.labels }),
      ...(draft.excludeLabels.length && { excludeLabels: draft.excludeLabels }),
    }
  }
  if (!same(draft.statusMapping, base.statusMapping)) patch.statusMapping = draft.statusMapping
  if (draft.defaultFlowId !== base.defaultFlowId) patch.defaultFlowId = draft.defaultFlowId
  if (draft.defaultProfileId !== base.defaultProfileId) patch.defaultProfileId = draft.defaultProfileId
  if (!same(draft.params, base.params)) {
    const names = new Set(Object.keys({ ...draft.params, ...base.params }))
    const kept = Object.fromEntries(Object.entries(project.flowParams).filter(([name]) => !names.has(name)))
    const set = Object.fromEntries(
      [...names].flatMap((name) => {
        const text = (draft.params[name] ?? "").trim()
        if (text === "") return []
        // Un valor que no se tocó conserva su tipo original.
        return [[name, text === base.params[name] ? project.flowParams[name] : paramValue(specs.find((s) => s.name === name), text)]]
      }),
    )
    patch.flowParams = { ...kept, ...set }
  }
  if (!same(draft.conventions, base.conventions)) patch.conventions = conventionsOf(draft.conventions, project.conventions)
  if (draft.stackOn !== base.stackOn) patch.stackOn = draft.stackOn
  if (draft.maxCostUsd !== base.maxCostUsd) patch.maxCostUsd = draft.maxCostUsd.trim() === "" ? null : Number(draft.maxCostUsd)
  return patch
}

/** El patch que devuelve cada campo de `patch` a como está en `project`: lo que hace "Deshacer". */
export function undoPatch(project: ClankerProject, patch: ProjectPatch): ProjectPatch {
  const before: ProjectPatch = {}
  for (const field of Object.keys(patch) as (keyof ProjectPatch)[]) {
    ;(before as Record<string, unknown>)[field] = project[field as keyof ClankerProject]
  }
  return before
}

/** Cada campo que cambió, con el nombre de la sección en que se edita, para el toast. */
export function changedSections(patch: ProjectPatch): string[] {
  const names: [keyof ProjectPatch, string][] = [
    ["repos", "repos"],
    ["queueFilter", "filtros de la cola"],
    ["statusMapping", "mapeo de estados"],
    ["defaultFlowId", "flujo"],
    ["defaultProfileId", "perfil"],
    ["flowParams", "parámetros del flujo"],
    ["conventions", "convenciones"],
    ["stackOn", "apilado"],
    ["maxCostUsd", "tope de gasto"],
  ]
  return names.filter(([field]) => field in patch).map(([, label]) => label)
}
