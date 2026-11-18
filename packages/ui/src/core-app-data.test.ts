import { expect, test, vi } from "vitest"
import { createCoreAppData, type CoreClient } from "./core-app-data"
import { buildOpenPrs } from "./demo/seed-prs"

test("openPrs combina los filtros excluyentes de abiertos y locales", async () => {
  const prs = buildOpenPrs(Date.parse("2026-11-15T12:00:00Z"))
  const remote = prs.filter((p) => p.ref !== null)
  const local = prs.filter((p) => p.local !== null)
  const list = vi.fn().mockResolvedValueOnce(remote).mockResolvedValueOnce(local)
  const data = createCoreAppData({ prs: { list } } as unknown as CoreClient)

  expect(await data.openPrs()).toEqual([...remote, ...local])
  expect(list.mock.calls).toEqual([[{ state: "open" }], [{ state: "local" }]])
})

test("el detalle y el diff por commit usan los procedimientos compartidos y conservan el rango visible", async () => {
  const detail = vi.fn().mockResolvedValue({ id: "pr_test" })
  const commitDiff = vi.fn().mockResolvedValue({ sha: "a".repeat(40) })
  const data = createCoreAppData({ prs: { detail, commitDiff } } as unknown as CoreClient)
  const input = { id: "pr_test", sha: "a".repeat(40), head: "b".repeat(40), base: "c".repeat(40) }

  expect(await data.prDetail(input.id)).toEqual({ id: input.id })
  expect(await data.prCommitDiff(input)).toEqual({ sha: input.sha })
  expect(detail.mock.calls).toEqual([[{ id: input.id }]])
  expect(commitDiff.mock.calls).toEqual([[input]])
})
