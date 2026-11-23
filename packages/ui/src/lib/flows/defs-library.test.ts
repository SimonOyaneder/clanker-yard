import type { ClankerProject, DefRecord } from "@clanker/api"
import { expect, test } from "vitest"
import { duplicateOf, isInternal, libraryRows, repoFilePath, repoOrigin, sourceLabel } from "@/lib/flows/defs-library"
import { SEED_TECHLEAD, SEED_TOY } from "@/demo/seed-flows"

let n = 0
const def = (kind: DefRecord["kind"], slug: string, body: unknown, extra: Partial<DefRecord> = {}): DefRecord => ({
  id: `def_${++n}`,
  kind,
  slug,
  scope: "builtin",
  repoId: null,
  archivedAt: null,
  currentVersion: 1,
  version: 1,
  body,
  source: "builtin",
  createdAt: 0,
  ...extra,
})
const project = (slug: string, flow: string | null, profile: string | null = null) => ({ slug, name: slug, defaultFlowId: flow, defaultProfileId: profile }) as ClankerProject

test("un flujo tuyo con el mismo slug manda: el incluido queda de respaldo y los proyectos cuentan en el tuyo", () => {
  const builtin = def("flow", "de-issue-a-pr", SEED_TECHLEAD)
  const mine = def("flow", "de-issue-a-pr", SEED_TECHLEAD, { scope: "user" })
  const rows = libraryRows("flow", [builtin, mine], [builtin, mine], [project("a", "de-issue-a-pr")])
  const [b, m] = rows
  expect(b).toMatchObject({ overriddenBy: "user", overrides: null, projects: [] })
  expect(m).toMatchObject({ overriddenBy: null, overrides: "builtin" })
  expect(m!.projects.map((p) => p.slug)).toEqual(["a"])
})

test("archivar el tuyo devuelve el mando al incluido", () => {
  const builtin = def("flow", "juguete", SEED_TOY)
  const mine = def("flow", "juguete", SEED_TOY, { scope: "user", archivedAt: 5 })
  const rows = libraryRows("flow", [builtin, mine], [builtin, mine], [project("a", "juguete")])
  expect(rows[0]).toMatchObject({ overriddenBy: null, overrides: null })
  expect(rows[0]!.projects).toHaveLength(1)
  expect(rows[1]).toMatchObject({ overriddenBy: null, projects: [] })
})

test("un rol se usa donde lo usa el flujo del proyecto, también por sus subflujos", () => {
  const toy = def("flow", "juguete", SEED_TOY)
  const parent = def("flow", "padre", { ...SEED_TOY, id: "padre", nodes: { run: { type: "flow", flow: "juguete", params: {}, on: { done: "@done" } } }, start: "run" })
  const role = def("role", "juguete", {})
  const other = def("role", "dev", {})
  const rows = libraryRows("role", [role, other], [toy, parent], [project("a", "padre"), project("b", null)])
  expect(rows[0]!.projects.map((p) => p.slug)).toEqual(["a"])
  expect(rows[1]!.projects).toEqual([])
})

test("un perfil se usa donde es el perfil por defecto", () => {
  const profile = def("profile", "medio", { roles: {} })
  expect(libraryRows("profile", [profile], [], [project("a", null, "medio")])[0]!.projects).toHaveLength(1)
})

test("interno solo si el flujo lo declara", () => {
  expect(isInternal(def("flow", "x", { name: "x", internal: true }))).toBe(true)
  expect(isInternal(def("flow", "x", { name: "x" }))).toBe(false)
  expect(isInternal(def("role", "x", { internal: true }))).toBe(false)
})

test("duplicar un incluido da uno tuyo con el mismo slug", () => {
  const builtin = def("flow", "de-issue-a-pr", SEED_TECHLEAD)
  const copy = duplicateOf(builtin, [builtin])
  expect(copy).toMatchObject({ slug: "de-issue-a-pr", overrides: true, body: { id: "de-issue-a-pr", name: SEED_TECHLEAD.name } })
})

test("duplicar uno tuyo da una copia con slug libre, que el flujo lleva en su id", () => {
  const mine = def("flow", "juguete", SEED_TOY, { scope: "user" })
  const first = def("flow", "juguete-copia", SEED_TOY, { scope: "user" })
  const copy = duplicateOf(mine, [mine, first])
  expect(copy).toMatchObject({ slug: "juguete-copia-2", overrides: false, body: { id: "juguete-copia-2", name: "Juguete (copia)" } })
})

test("duplicar un rol no toca su body", () => {
  const role = def("role", "dev", { prompt: "x" })
  expect(duplicateOf(role, [role]).body).toBe(role.body)
})

test("una def que viene del repo dice archivo y commit; lo demás sigue como estaba", () => {
  expect(repoOrigin("repo:.clanker/flows/mi-flujo.json@0123456789abcdef")).toEqual({ file: ".clanker/flows/mi-flujo.json", commit: "0123456" })
  expect(sourceLabel("repo:.clanker/roles/dev.md@abcdef012345")).toBe("el repo (.clanker/roles/dev.md, commit abcdef0)")
  expect(repoOrigin("ui")).toBeNull()
  expect(sourceLabel("ui")).toBe("esta app")
  expect(repoFilePath("role", "dev")).toBe(".clanker/roles/dev.md")
  expect(repoFilePath("flow", "mi-flujo")).toBe(".clanker/flows/mi-flujo.json")
})
