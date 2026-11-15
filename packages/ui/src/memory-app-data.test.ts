import { expect, test } from "vitest"
import { issueIdOf } from "@/lib/format"
import { buildStackForest, listStackGroups } from "@/lib/stack"
import { createMemoryAppData } from "@/memory-app-data"
import type { Result } from "@/types"

const NOW = Date.parse("2026-11-15T12:00:00Z")

function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(r.error)
  return r.data
}

test("archivar y desarchivar un loop se ve en el siguiente snapshot", async () => {
  const data = createMemoryAppData(NOW)
  const archived = async (slug: string) => unwrap(await data.snapshot()).loops.find((l) => l.slug === slug)?.archived

  expect(await archived("soporte")).toBe(false)
  unwrap(await data.setArchived("soporte", true))
  expect(await archived("soporte")).toBe(true)
  unwrap(await data.setArchived("soporte", false))
  expect(await archived("soporte")).toBe(false)
})

test("un loop que no existe responde con un error que dice cuál", async () => {
  const data = createMemoryAppData(NOW)

  expect(await data.setArchived("nada", true)).toEqual({ ok: false, error: "No existe el loop nada" })
  expect(await data.summary("nada")).toEqual({ ok: false, error: "No existe el loop nada" })
  expect(await data.issue("nada", "ENG-1")).toEqual({ ok: false, error: "No existe el loop nada" })
})

test("cada issue que muestra el snapshot (slot, historial o cola) abre su detalle", async () => {
  const data = createMemoryAppData(NOW)
  const { loops } = unwrap(await data.snapshot())

  for (const loop of loops) {
    const ids = [
      ...loop.slots.map((s) => s.issueId),
      ...loop.history.map((h) => issueIdOf(h.issueId)),
      ...(loop.queueItems ?? []).map((q) => q.id),
    ]
    for (const id of ids) {
      const detail = unwrap(await data.issue(loop.slug, id))
      expect(detail.issueId).toBe(id)
    }
  }
})

test("el detalle de un slot trae su equipo y el de una issue en cola viene sin equipo", async () => {
  const data = createMemoryAppData(NOW)

  const slot = unwrap(await data.issue("boundaries-de-engines", "ENG-9178"))
  expect(slot.slot?.slot).toBe("A")
  expect(slot.team.map((m) => m.role)).toContain("techlead")
  expect(slot.steps.find((s) => s.status === "current")?.label).toBe("Review")

  const queued = unwrap(await data.issue("boundaries-de-engines", "ENG-9183"))
  expect(queued.team).toEqual([])
  expect(queued.steps.every((s) => s.status === "todo")).toBe(true)
})

test("el resumen cuenta los PRs del historial por columna", async () => {
  const data = createMemoryAppData(NOW)
  const { loops } = unwrap(await data.snapshot())
  const loop = loops.find((l) => l.slug === "boundaries-de-engines")!
  const summary = unwrap(await data.summary(loop.slug))

  expect(summary.issuesRecorded).toBe(loop.history.length)
  expect(summary.prs.mergeado).toBe(loop.history.filter((h) => h.column === "mergeado").length)
  expect(summary.prs.problema).toBe(1)
  expect(summary.totalUsd).toBeCloseTo(summary.teamsUsd + summary.emUsd)
})

test("los PRs de ejemplo arman un stack de 4 con su raíz y el resto sueltos", async () => {
  const data = createMemoryAppData(NOW)
  const { prs } = unwrap(await data.prs(false))

  const groups = listStackGroups(buildStackForest(prs))
  expect(groups[0]?.prIds).toHaveLength(4)
  expect(groups.filter((g) => g.prIds.length === 1)).toHaveLength(prs.length - 4)
})

test("lanzar o detener un EM responde que salió bien sin tocar el snapshot", async () => {
  const data = createMemoryAppData(NOW)
  const before = unwrap(await data.snapshot()).loops

  expect(unwrap(await data.runLoop("soporte", "watch")).name).toBe("clanker · soporte")
  expect(await data.stop("bg-2c19")).toEqual({ ok: true, data: null })
  expect(unwrap(await data.snapshot()).loops).toEqual(before)
})
