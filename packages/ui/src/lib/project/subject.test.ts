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
  expect(subjectOf({ subject: { type: "pr", id: "pr_2" } })).toEqual({ key: "PR", title: "PR que ya no está abierto" })
})
