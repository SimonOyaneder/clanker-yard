import { Profile, Role } from "@clanker/api"
import { expect, test } from "vitest"
import { profileSummary, roleDraftOf, roleFromDraft, slugProblem, splitList, withRole } from "./def-form"

const profile = Profile.parse({
  roles: {
    dev: { model: "opus", effort: "high" },
    "review-bugs": { model: "haiku" },
    "review-tests": { model: "haiku", effort: "low" },
    "review-lore": { model: "sonnet" },
    committer: { model: "sonnet" },
  },
})

test("el resumen dice el dev y los modelos distintos de los reviews", () => {
  expect(profileSummary(profile)).toBe("dev opus high · reviews haiku/sonnet")
  expect(profileSummary(Profile.parse({ roles: { committer: { model: "sonnet" } } }))).toBe("")
})

test("withRole cambia un rol, conserva sus topes y quita el esfuerzo si se pide", () => {
  const capped = Profile.parse({ roles: { dev: { model: "opus", effort: "high", budget: { maxUsd: 5 } } } })
  expect(withRole(capped, "dev", { ...capped.roles.dev!, model: "sonnet" }).roles.dev).toEqual({ model: "sonnet", effort: "high", budget: { maxUsd: 5 } })
  expect(withRole(capped, "dev", { ...capped.roles.dev!, effort: undefined }).roles.dev).toEqual({ model: "opus", budget: { maxUsd: 5 } })
})

test("un slug nuevo es minúsculas con guiones y no repite uno existente", () => {
  expect(slugProblem("mi-perfil", ["eco"])).toBeNull()
  expect(slugProblem("Mi perfil", [])).toMatch(/minúsculas/)
  expect(slugProblem("eco", ["eco"])).toMatch(/Ya existe/)
})

test("splitList separa por comas y líneas, sin vacíos ni repetidos", () => {
  expect(splitList("Read, Grep\nRead\n\n Bash ")).toEqual(["Read", "Grep", "Bash"])
})

const role = Role.parse({
  prompt: "Eres dev.",
  context: [{ kind: "native", sources: ["user"], skills: "all" }, { kind: "pack", id: "lore" }],
  tools: { allow: ["Read"] },
  modes: { plan: { instructions: "x", report: { type: "object" }, outcomes: ["ok"], session: "new" } },
})

test("un rol pasa a borrador y vuelve igual si no se toca nada", () => {
  const draft = roleDraftOf(role)
  expect(draft).toMatchObject({ packs: ["lore"], allTools: false, allow: "Read", deny: "" })
  expect(roleFromDraft(role, draft)).toEqual({ ...role, context: [role.context[0], role.context[1]] })
})

test("cambiar paquetes y herramientas deja intactas las otras fuentes de contexto y los modos", () => {
  const next = roleFromDraft(role, { ...roleDraftOf(role), packs: ["commits", "lore"], allow: "Read, Grep", deny: "Bash" })
  expect(next.context).toEqual([role.context[0], { kind: "pack", id: "commits" }, { kind: "pack", id: "lore" }])
  expect(next.tools).toEqual({ allow: ["Read", "Grep"], deny: ["Bash"] })
  expect(next.modes).toBe(role.modes)
  expect(roleFromDraft(role, { ...roleDraftOf(role), allTools: true }).tools).toBe("all")
  expect(roleFromDraft({ ...role, tools: undefined }, { ...roleDraftOf(role), allTools: true }).tools).toBeUndefined()
})
