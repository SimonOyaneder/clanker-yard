import type { ClankerProject, DefRecord } from "@clanker/api"
import { expect, test } from "vitest"
import { SEED_REBASE, SEED_TECHLEAD, SEED_TOY } from "@/demo/seed-flows"
import { allParamSpecs, changedSections, draftOf, flowParamGroups, managedParams, patchOf, undoPatch, validateProjectDraft, type ProjectDraft } from "./project-settings"

const flow = (body: object, slug: string): DefRecord => ({
  id: slug,
  kind: "flow",
  slug,
  scope: "builtin",
  repoId: null,
  archivedAt: null,
  currentVersion: 1,
  version: 1,
  body,
  source: "builtin",
  createdAt: 0,
})
const flows = [flow(SEED_TECHLEAD, "de-issue-a-pr"), flow(SEED_TOY, "juguete"), flow(SEED_REBASE, "rebase-conflicto")]

const project = (extra: Partial<ClankerProject> = {}): ClankerProject => ({
  id: "prj_00000000000000000000000001",
  slug: "ba",
  name: "BA",
  tracker: "linear",
  trackerRef: "boundaries",
  trackerAccount: "clanker-yard",
  defaultFlowId: "de-issue-a-pr",
  defaultProfileId: "medio",
  repos: [{ repoId: "repo_00000000000000000000000001", labels: ["api"] }],
  queueFilter: {},
  conventions: {},
  parallel: 1,
  stackOn: "ci_green",
  stackMode: "remote",
  maxStackDepth: null,
  maintenancePaused: false,
  statusMapping: {},
  status: "active",
  flowParams: {},
  maxCostUsd: null,
  ...extra,
})

const specs = allParamSpecs(flows, "de-issue-a-pr")
const base = (p: ClankerProject) => draftOf(p, managedParams(flows))

test("los parámetros del flujo por defecto salen con su default y los de los flujos que arrancan solos aparecen aparte", () => {
  const groups = flowParamGroups(flows, "de-issue-a-pr")

  expect(groups.own.map((s) => [s.name, s.default])).toEqual([
    ["checkRounds", 3],
    ["externalRounds", 3],
    ["reviewRounds", 3],
  ])
  // checkRounds lo lee también el flujo de rebase, con otro default: se dice para que no sorprenda.
  expect(groups.own[0]!.flows).toEqual([
    { slug: "de-issue-a-pr", default: 3 },
    { slug: "rebase-conflicto", default: 2 },
  ])
  expect(groups.triggered.map((s) => s.name)).toEqual(["conflictRounds", "rebaseNonDraft"])
  // Con un flujo sin parámetros solo quedan los de los flujos que arrancan solos.
  const toy = flowParamGroups(flows, "juguete")
  expect(toy.own).toEqual([])
  expect(toy.triggered.map((s) => s.name)).toEqual(["checkRounds", "conflictRounds", "externalRounds", "rebaseNonDraft"])
})

test("lo que pone el core (repo, base) no se edita, y un parámetro con distinto default por flujo no inventa uno solo", () => {
  const council = flow({ ...SEED_REBASE, id: "council", trigger: { type: "pr.comment" }, params: { externalRounds: { type: "number", default: 1 }, base: { type: "string", default: "main" } } }, "council")
  const all = [...flows, council]

  const { own, triggered } = flowParamGroups(all, "juguete")

  expect(own).toEqual([])
  const external = triggered.find((s) => s.name === "externalRounds")!
  expect(external.default).toBeNull()
  expect(external.flows.map((f) => f.slug).sort()).toEqual(["council", "rebase-conflicto"])
  expect(all.flatMap((f) => allParamSpecs([f], null)).map((s) => s.name)).not.toContain("base")
  expect(validateProjectDraft({ ...base(project()), params: { externalRounds: "0" } }, triggered)["param:externalRounds"]).toContain("cada flujo usa el suyo")
})

test("sin cambios no hay patch; cada sección cambiada produce solo su campo", () => {
  const p = project({ flowParams: { repo: "repo_x", reviewRounds: 5 } })
  const b = base(p)

  expect(patchOf(b, b, p, specs)).toEqual({})
  expect(patchOf({ ...b, trackerRef: "c43b8e70-91d2-4e0c-a6f5-3b1e8d2f6c03" }, b, p, specs)).toEqual({ trackerRef: "c43b8e70-91d2-4e0c-a6f5-3b1e8d2f6c03" })
  expect(patchOf({ ...b, trackerRef: "otro" }, b, project({ tracker: "local" }), specs)).toEqual({})
  expect(patchOf({ ...b, stackOn: "ready", maxCostUsd: "2.5" }, b, p, specs)).toEqual({ stackOn: "ready", maxCostUsd: 2.5 })
  expect(patchOf({ ...b, stackMode: "local" }, b, p, specs)).toEqual({ stackMode: "local" })
  expect(changedSections({ stackMode: "local" })).toEqual(["PRs apilados"])
  expect(patchOf({ ...b, maxCostUsd: "" }, { ...b, maxCostUsd: "3" }, project({ maxCostUsd: 3 }), specs)).toEqual({ maxCostUsd: null })
})

test("el tope de pisos distingue 0 de vacío y rechaza negativos y fracciones", () => {
  const p = project({ maxStackDepth: 2 })
  const b = base(p)
  for (const bad of ["-1", "1.5", "dos"]) expect(validateProjectDraft({ ...b, maxStackDepth: bad }, specs).maxStackDepth).toBeDefined()
  for (const [text, value] of [["0", 0], ["", null]] as const) {
    const draft = { ...b, maxStackDepth: text }
    expect(validateProjectDraft(draft, specs)).toEqual({})
    expect(patchOf(draft, b, p, specs)).toEqual({ maxStackDepth: value })
  }
})

test("las corridas a la vez del proyecto piden un entero de 1 en adelante y se guardan como número", () => {
  const p = project({ parallel: 2 })
  const b = base(p)

  for (const bad of ["0", "-1", "1.5", "dos", ""]) expect(validateProjectDraft({ ...b, parallel: bad }, specs).parallel).toContain("entero de 1 en adelante")
  expect(validateProjectDraft({ ...b, parallel: " 3 " }, specs).parallel).toBeUndefined()
  expect(patchOf({ ...b, parallel: "4" }, b, p, specs)).toEqual({ parallel: 4 })
  expect(patchOf({ ...b, parallel: " 2 " }, b, p, specs)).toEqual({})
})

test("los parámetros se guardan con su tipo, un campo vacío vuelve al default y los flowParams ajenos quedan igual", () => {
  const p = project({ flowParams: { repo: "repo_x", reviewRounds: 5, checkRounds: 4 } })
  const b = base(p)

  const patch = patchOf({ ...b, params: { ...b.params, reviewRounds: "7", checkRounds: "", rebaseNonDraft: "ask" } }, b, p, specs)

  expect(patch.flowParams).toEqual({ repo: "repo_x", reviewRounds: 7, rebaseNonDraft: "ask" })
})

test("un parámetro que no se tocó conserva su valor original aunque se cambie otro", () => {
  const p = project({ flowParams: { reviewRounds: 5, rebaseNonDraft: "ask" } })
  const b = base(p)

  expect(patchOf({ ...b, params: { ...b.params, reviewRounds: "6" } }, b, p, specs).flowParams).toEqual({ reviewRounds: 6, rebaseNonDraft: "ask" })
})

test("los filtros de la cola omiten lo vacío (rige el default del core) y las convenciones conservan el contexto por rol", () => {
  const p = project({ conventions: { commentPrefix: "[x]", context: { "*": ["rule:git-safety"] } } })
  const b = base(p)

  const patch = patchOf(
    { ...b, status: ["todo", "in_review"], labels: ["clanker"], excludeLabels: [], conventions: { ...b.conventions, commentPrefix: "", noAiAttribution: "yes", omitSections: ["Capturas"] } },
    b,
    p,
    specs,
  )

  expect(patch.queueFilter).toEqual({ status: ["todo", "in_review"], labels: ["clanker"] })
  expect(patch.conventions).toEqual({ noAiAttribution: true, pr: { omitSections: ["Capturas"] }, context: { "*": ["rule:git-safety"] } })
})

test("el mapeo de estados y el flujo y perfil por defecto se guardan y 'automática' lo quita", () => {
  const p = project({ statusMapping: { "In Staging": "in_review" } })
  const b = base(p)

  expect(patchOf({ ...b, statusMapping: {}, defaultFlowId: null, defaultProfileId: "juguete" }, b, p, specs)).toEqual({
    statusMapping: {},
    defaultFlowId: null,
    defaultProfileId: "juguete",
  })
})

test("deshacer devuelve cada campo cambiado a como estaba, incluso una cola vacía", () => {
  const p = project({ maxCostUsd: 2, repos: [{ repoId: "repo_00000000000000000000000001", labels: ["api"] }] })
  const patch = { maxCostUsd: null, queueFilter: { labels: ["a"] }, repos: [] }

  expect(undoPatch(p, patch)).toEqual({ maxCostUsd: 2, queueFilter: {}, repos: p.repos })
  expect(changedSections(patch)).toEqual(["repos", "filtros de la cola", "tope de gasto"])
})

test("un label en dos repos, en pedidos y excluidos, un parámetro inválido y un tope inválido dicen qué cambiar", () => {
  const b = base(project())
  const draft: ProjectDraft = {
    ...b,
    repos: [
      { repoId: "repo_a", labels: ["api"] },
      { repoId: "repo_b", labels: ["api", "web"] },
    ],
    labels: ["clanker"],
    excludeLabels: ["clanker"],
    params: { reviewRounds: "0", rebaseNonDraft: "maybe", checkRounds: "2.5", externalRounds: "3" },
    maxCostUsd: "-1",
    conventions: { ...b.conventions, prTemplate: "/etc/pr.md" },
  }

  const problems = validateProjectDraft(draft, [...flowParamGroups(flows, "de-issue-a-pr").own, ...flowParamGroups(flows, "de-issue-a-pr").triggered])

  expect(problems["repo:repo_b"]).toContain('"api"')
  expect(problems.excludeLabels).toContain('"clanker"')
  expect(problems["param:reviewRounds"]).toContain("entero de 1 en adelante")
  expect(problems["param:checkRounds"]).toContain("entero")
  expect(problems["param:rebaseNonDraft"]).toContain('"auto" o "ask"')
  expect(problems["param:externalRounds"]).toBeUndefined()
  expect(problems.maxCostUsd).toContain("mayor que 0")
  expect(problems.prTemplate).toContain("relativa")
  expect(validateProjectDraft(b, specs)).toEqual({})
})
