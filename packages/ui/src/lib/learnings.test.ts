import type { Learning } from "@clanker/api"
import { expect, test } from "vitest"
import { capsOf, countByStatus, matches, NO_FILTERS, rolesOf, scopeFromKey, scopeKey, statusAfter, targetsOf, triageMessage, visibleLearnings, withPending } from "@/lib/learnings"

const lrn = (n: number, l: Partial<Learning> = {}): Learning => ({
  id: `lrn_${String(n).padStart(26, "0")}` as Learning["id"],
  projectId: "prj_1" as Learning["projectId"],
  repoId: null,
  text: `texto ${n}`,
  roles: [],
  tags: [],
  status: "proposed",
  source: "import",
  sourceRunId: null,
  createdAt: n,
  ...l,
})

const learnings = [
  lrn(1, { text: "El scope va explícito", roles: ["review-bugs"], tags: ["scope"] }),
  lrn(2, { text: "Correr los checks antes del commit", source: "agent" }),
  lrn(3, { text: "Un repo tiene su receta", projectId: null, repoId: "rep_1" as Learning["repoId"], source: "human" }),
  lrn(4, { text: "Ya aprobado", status: "approved", roles: ["dev", "review-bugs"] }),
  lrn(5, { text: "Ya rechazado", status: "rejected" }),
]

test("los filtros se combinan: alcance, rol, origen y texto (en el texto o en los tags)", () => {
  const ids = (f: Partial<typeof NO_FILTERS>) => learnings.filter((l) => matches(l, { ...NO_FILTERS, ...f })).map((l) => l.id.slice(-1))

  expect(ids({ scope: { kind: "repo", id: "rep_1" as never } })).toEqual(["3"])
  expect(ids({ scope: { kind: "project", id: "prj_1" as never } })).toEqual(["1", "2", "4", "5"])
  expect(ids({ role: "review-bugs" })).toEqual(["1", "4"])
  // El rol vacío es "valen para todos": los que no nombran ninguno.
  expect(ids({ role: "" })).toEqual(["2", "3", "5"])
  expect(ids({ source: "agent" })).toEqual(["2"])
  expect(ids({ query: "SCOPE" })).toEqual(["1"])
  expect(ids({ query: "  checks " })).toEqual(["2"])
  expect(ids({ source: "import", role: "review-bugs" })).toEqual(["1", "4"])
})

test("los contadores de cada estado respetan los filtros y la lista va del más reciente al más antiguo", () => {
  expect(countByStatus(learnings, NO_FILTERS)).toEqual({ proposed: 3, approved: 1, rejected: 1, archived: 0 })
  expect(countByStatus(learnings, { ...NO_FILTERS, source: "import" })).toEqual({ proposed: 1, approved: 1, rejected: 1, archived: 0 })
  expect(visibleLearnings(learnings, "proposed", NO_FILTERS).map((l) => l.text)).toEqual(["Un repo tiene su receta", "Correr los checks antes del commit", "El scope va explícito"])
})

test("los roles del filtro salen de los datos, sin repetir y ordenados", () => {
  expect(rolesOf(learnings)).toEqual(["dev", "review-bugs"])
})

test("el alcance del filtro viaja como texto y vuelve igual", () => {
  expect(scopeFromKey(scopeKey({ kind: "project", id: "prj_1" as never }))).toEqual({ kind: "project", id: "prj_1" })
  expect(scopeFromKey(scopeKey({ kind: "repo", id: "rep_1" as never }))).toEqual({ kind: "repo", id: "rep_1" })
  expect(scopeFromKey(scopeKey(null))).toBeNull()
})

test("lo que espera su plazo de deshacer se ve ya en el estado al que lleva, como lo deja el core", () => {
  expect(statusAfter("approve", "rejected")).toBe("approved")
  expect(statusAfter("reject", "proposed")).toBe("rejected")
  expect(statusAfter("reject", "approved")).toBe("archived")
  expect(statusAfter("reject", "rejected")).toBe("rejected")

  const shown = withPending(learnings, new Map([[learnings[0]!.id, "approve" as const], [learnings[3]!.id, "reject" as const]]))
  expect(shown.map((l) => l.status)).toEqual(["approved", "proposed", "proposed", "archived", "rejected"])
  // Sin nada pendiente devuelve la misma lista, sin copiarla.
  expect(withPending(learnings, new Map())).toBe(learnings)
})

test("A y R actúan sobre lo marcado y, sin marcados, sobre el que está a la vista; solo donde el core lo admite", () => {
  const [one, two] = learnings
  expect(targetsOf([], one!).map((l) => l.id)).toEqual([one!.id])
  expect(targetsOf([one!, two!], learnings[2]!).map((l) => l.id)).toEqual([one!.id, two!.id])
  expect(targetsOf([], null)).toEqual([])

  expect(capsOf({ status: "proposed" })).toEqual({ approve: true, reject: true })
  expect(capsOf({ status: "approved" })).toEqual({ approve: false, reject: true })
  expect(capsOf({ status: "rejected" })).toEqual({ approve: true, reject: false })
  expect(capsOf({ status: "archived" })).toEqual({ approve: true, reject: false })
})

test("el aviso de deshacer dice qué pasó: aprobar, rechazar o retirar, uno o varios", () => {
  const long = lrn(9, { text: "a".repeat(100) })
  expect(triageMessage("approve", [one(), lrn(2)])).toBe("Aprobaste 2 learnings")
  expect(triageMessage("reject", [lrn(1)])).toBe("Rechazaste «texto 1»")
  expect(triageMessage("reject", [lrn(1, { status: "approved" })])).toBe("Retiraste «texto 1»")
  expect(triageMessage("approve", [long])).toBe(`Aprobaste «${"a".repeat(55)}…»`)
})

function one() {
  return lrn(1)
}
