import type { CachedIssue, CachedPr } from "@clanker/api"
import { expect, test } from "vitest"
import { subjectLabeler } from "@/lib/project/subject"

const issue = { id: "iss_1", ref: { tracker: "linear", key: "ENG-9183" }, title: "Lint de imports entre engines" } as unknown as CachedIssue
const pr = { id: "pr_1", issueId: "iss_1", ref: { account: "octocat", repo: "acme/api", number: 4251 } } as unknown as CachedPr

test("una corrida de issue lleva su clave y su título, o dice que el caché no la tiene", () => {
  const subjectOf = subjectLabeler([issue], [])

  expect(subjectOf({ subject: { type: "issue", id: "iss_1" } })).toEqual({ key: "ENG-9183", title: "Lint de imports entre engines" })
  expect(subjectOf({ subject: { type: "issue", id: "iss_9" } })).toEqual({ key: "iss_9", title: "issue fuera del caché" })
})

test("una corrida sobre un PR lleva repo#número y el título de la issue que lo abrió", () => {
  const subjectOf = subjectLabeler([issue], [pr])

  expect(subjectOf({ subject: { type: "pr", id: "pr_1" } })).toEqual({ key: "api#4251", title: "Lint de imports entre engines" })
  expect(subjectOf({ subject: { type: "pr", id: "pr_2" } })).toEqual({ key: "PR", title: "un PR que Clanker Yard ya no tiene" })
})

test("una corrida sobre un PR local, sin número en GitHub, no tiene repo#número", () => {
  const local = { id: "pr_3", issueId: "iss_1", ref: null, local: { branch: "feat/y", base: "feat/x", title: "feat: y" } } as unknown as CachedPr
  const subjectOf = subjectLabeler([issue], [local])

  expect(subjectOf({ subject: { type: "pr", id: "pr_3" } })).toEqual({ key: "feat/y", title: "feat: y" })
})

test("una corrida sobre un PR que ya se cerró (el restack de una base que mergeó la cola) lo nombra y dice que está cerrado", () => {
  const closed = { id: "pr_4", issueId: null, ref: { account: "octocat", repo: "acme/api", number: 4326 }, state: { state: "closed", title: "Procesar CDA en el adapter" } } as unknown as CachedPr
  const subjectOf = subjectLabeler([issue], [closed])

  expect(subjectOf({ subject: { type: "pr", id: "pr_4" } })).toEqual({ key: "api#4326", title: "Procesar CDA en el adapter (cerrado)" })
})
