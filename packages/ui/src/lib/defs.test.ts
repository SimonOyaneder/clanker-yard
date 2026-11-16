import type { DefRecord } from "@clanker/api"
import { expect, test } from "vitest"
import { defName, defSummary, defaultFlowSlug, defaultProfileSlug, selectableFlows } from "./defs"

const def = (kind: DefRecord["kind"], slug: string, body: unknown): DefRecord => ({
  id: `def_${slug}`,
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
})
const profile = (slug: string, roles: Record<string, [string, string?]>) =>
  def("profile", slug, { roles: Object.fromEntries(Object.entries(roles).map(([role, [model, effort]]) => [role, { model, effort }])) })

test("un perfil se resume con el modelo del dev y los de los reviews, sin repetir", () => {
  const eco = profile("eco", { dev: ["sonnet", "high"], "review-bugs": ["sonnet"], "review-tests": ["haiku"], "review-lore": ["haiku"], committer: ["opus"] })
  expect(defSummary(eco)).toBe("dev sonnet high · reviews sonnet/haiku")
  expect(defSummary(profile("solo", { dev: ["opus"] }))).toBe("dev opus")
  expect(defSummary(profile("vacio", {}))).toBeUndefined()
})

test("un flujo se llama por su nombre y se resume con su descripción si la trae", () => {
  const flow = def("flow", "techlead-clasico", { name: "Techlead clásico" })
  expect(defName(flow)).toBe("Techlead clásico")
  expect(defSummary(flow)).toBeUndefined()
  expect(defSummary(def("flow", "x", { name: "X", description: "Hace x" }))).toBe("Hace x")
  expect(defName(profile("eco", {}))).toBe("eco")
})

test("los defaults son techlead-clasico y eco, y si faltan el primero", () => {
  const flows = [def("flow", "juguete", {}), def("flow", "techlead-clasico", {})]
  const profiles = [profile("medio", {}), profile("eco", {})]
  expect(defaultFlowSlug(flows)).toBe("techlead-clasico")
  expect(defaultFlowSlug(flows.slice(0, 1))).toBe("juguete")
  expect(defaultProfileSlug(profiles)).toBe("eco")
  expect(defaultProfileSlug(profiles.slice(0, 1))).toBe("medio")
  expect(defaultProfileSlug([])).toBe("")
})

test("selectableFlows oculta los internos, salvo el que el proyecto ya tiene", () => {
  const flows = [def("flow", "techlead-clasico", { name: "Flujo principal" }), def("flow", "council", { internal: true }), def("flow", "restack", { internal: true })]

  expect(selectableFlows(flows).map((f) => f.slug)).toEqual(["techlead-clasico"])
  expect(selectableFlows(flows, "council").map((f) => f.slug)).toEqual(["techlead-clasico", "council"])
})
