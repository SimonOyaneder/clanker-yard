import type { PackInfo, ProjectDefaults, Repo } from "@clanker/api"
import { expect, test } from "vitest"
import { defaultsPatch, defaultsProblems, draftOfDefaults, orgsWithoutPack, undoDefaults } from "@/lib/app-settings"

const defaults: ProjectDefaults = { defaultFlowId: "techlead", defaultProfileId: null, parallel: 2, maxCostUsd: null }

test("el patch lleva solo lo que cambió, con el tope vacío como null", () => {
  const base = draftOfDefaults(defaults)

  expect(defaultsPatch(base, base)).toEqual({})
  expect(defaultsPatch({ ...base, parallel: " 3 ", defaultProfileId: "max" }, base)).toEqual({ parallel: 3, defaultProfileId: "max" })
  expect(defaultsPatch({ ...base, maxCostUsd: "7.5" }, base)).toEqual({ maxCostUsd: 7.5 })
  const capped = draftOfDefaults({ ...defaults, maxCostUsd: 5 })
  expect(defaultsPatch({ ...capped, maxCostUsd: "" }, capped)).toEqual({ maxCostUsd: null })
})

test("deshacer vuelve a lo que había solo en los campos que se cambiaron", () => {
  expect(undoDefaults(defaults, { parallel: 3, defaultFlowId: null })).toEqual({ parallel: 2, defaultFlowId: "techlead" })
})

test("dice qué corregir en corridas a la vez y en el tope", () => {
  const base = draftOfDefaults(defaults)

  expect(defaultsProblems(base)).toEqual({})
  expect(Object.keys(defaultsProblems({ ...base, parallel: "0", maxCostUsd: "abc" })).sort()).toEqual(["maxCostUsd", "parallel"])
  expect(defaultsProblems({ ...base, maxCostUsd: "" })).toEqual({})
})

const repo = (name: string, remote: string | null): Repo => ({ id: `repo_${name}` as Repo["id"], name, path: `/code/${name}`, remote, defaultBranch: "main", mergeStrategy: null })
const pack = (githubOrgs: string[]): PackInfo => ({ id: "base", version: 2, origin: "factory", activate: { githubOrgs } })

test("avisa las orgs con repos que ningún pack cubre, sin distinguir mayúsculas y sin contar repos sin remoto de GitHub", () => {
  const repos = [repo("api", "Base-Org/api"), repo("web", "acme/web"), repo("docs", "acme/docs"), repo("local", null)]

  expect(orgsWithoutPack(repos, [pack(["base-org"])])).toEqual([{ org: "acme", repos: ["web", "docs"] }])
  expect(orgsWithoutPack(repos, [])).toHaveLength(2)
  expect(orgsWithoutPack(repos, [pack(["base-org", "ACME"])])).toEqual([])
})
