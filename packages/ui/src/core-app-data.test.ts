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
