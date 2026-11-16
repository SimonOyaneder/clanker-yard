import type { Decision } from "@clanker/api"
import { expect, test } from "vitest"
import { alsoInRuns, groupByStep, notesOfPr } from "./notes"

const note = (n: number, d: Partial<Decision>) => ({ id: `dec_${n}`, title: "t", runId: `run_${n}`, stepRunId: null, subject: null, projectId: "prj_1", ...d }) as unknown as Decision

test("las notas de un PR son las de su sujeto y las de la issue que lo originó", () => {
  const notes = [note(1, { subject: { type: "pr", id: "pr_1" } }), note(2, { subject: { type: "issue", id: "iss_1" } }), note(3, { subject: { type: "pr", id: "pr_2" } }), note(4, {})]

  expect(notesOfPr(notes, { id: "pr_1", issueId: "iss_1" } as never).map((n) => n.id)).toEqual(["dec_1", "dec_2"])
})

test("agrupa por paso en orden de aparición", () => {
  const groups = groupByStep([note(1, { stepRunId: "s1" as never }), note(2, { stepRunId: "s2" as never }), note(3, { stepRunId: "s1" as never })])

  expect(groups.map((g) => [g.stepRunId, g.notes.length])).toEqual([["s1", 2], ["s2", 1]])
})

test("una nota repetida con título igual o muy parecido cuenta las otras corridas, no la propia", () => {
  const mine = note(1, { title: "CI rojo ajeno o flaky" })
  const all = [mine, note(2, { title: "CI rojo ajeno" }), note(3, { title: "ci rojo ajeno o flaky!" }), note(4, { title: "LGTM sin hallazgos" }), note(5, { title: "CI rojo ajeno", runId: "run_2" as never })]

  expect(alsoInRuns(mine, all)).toBe(2)
  expect(alsoInRuns(all[3]!, all)).toBe(0)
})
