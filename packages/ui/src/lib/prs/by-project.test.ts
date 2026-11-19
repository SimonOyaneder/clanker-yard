import { expect, test } from "vitest"
import { buildOpenPrs } from "@/demo/seed-prs"
import { groupByProject, projectByPr, type PrProject } from "./by-project"
import { keyOf, openPrsOf } from "./prs"
import { buildStackForest, listStackGroups } from "./stack"

const NOW = Date.parse("2026-11-15T12:00:00Z")

function group(issueProjects: Map<string, PrProject>) {
  const forest = buildStackForest(openPrsOf(buildOpenPrs(NOW)))
  const byProject = groupByProject(listStackGroups(forest), forest.byId, issueProjects)
  return byProject.map((g) => ({ project: g.project?.name ?? null, prCount: g.prCount, keys: g.groups.flatMap((s) => s.prIds.map((id) => keyOf(forest.byId.get(id)!))) }))
}

test("un stack va entero al proyecto de su primer PR con proyecto, de la base hacia arriba", () => {
  // ledger#421 (la base) no tiene proyecto conocido; ledger#424, su hijo, sí: el stack entero sigue a #424.
  const [boundaries] = group(new Map([["iss_eng_9167", { id: "prj_b", name: "Boundaries" }]]))

  expect(boundaries).toEqual({ project: "Boundaries", prCount: 4, keys: ["ledger#421", "ledger#424", "ledger#427", "ledger#426"] })
})

test("los proyectos van por nombre y los PRs sin proyecto al final", () => {
  const groups = group(
    new Map([
      ["iss_eng_9167", { id: "prj_z", name: "Zeta" }],
      ["iss_tw_33", { id: "prj_a", name: "Alfa" }],
    ]),
  )

  expect(groups.map((g) => g.project)).toEqual(["Alfa", "Zeta", null])
  expect(groups[0]?.keys).toEqual(["dashboard#979"])
  expect(groups.reduce((n, g) => n + g.prCount, 0)).toBe(openPrsOf(buildOpenPrs(NOW)).length)
})

test("cada PR toma el proyecto de su stack, también la base sin issue", () => {
  const forest = buildStackForest(openPrsOf(buildOpenPrs(NOW)))
  const byPr = projectByPr(listStackGroups(forest), forest.byId, new Map([["iss_eng_9167", { id: "prj_b", name: "Boundaries" }]]))
  const projectOf = (key: string) => byPr.get([...forest.byId.values()].find((p) => keyOf(p) === key)!.id)?.name ?? null

  expect(projectOf("ledger#421")).toBe("Boundaries")
  expect(projectOf("ledger#426")).toBe("Boundaries")
  expect(projectOf("dashboard#979")).toBeNull()
})
