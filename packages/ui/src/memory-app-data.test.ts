import { expect, test } from "vitest"
import { buildStackForest, listStackGroups } from "@/lib/stack"
import { createMemoryAppData } from "@/memory-app-data"

const NOW = Date.parse("2026-11-15T12:00:00Z")

test("lanzar una corrida la deja primera en la lista del proyecto, en curso", async () => {
  const data = createMemoryAppData(NOW)
  const [project] = await data.projects()
  const issue = (await data.issues(project!.id)).find((i) => i.status === "todo")!

  const started = await data.startRun({ projectId: project!.id, issueId: issue.id })
  const [first] = await data.runs({ projectId: project!.id })

  expect(first).toMatchObject({ id: started.id, status: "running", subject: { id: issue.id } })
  expect((await data.run(started.id)).steps).toHaveLength(1)
})

test("un proyecto pausado rechaza lanzar corridas diciendo cuál es", async () => {
  const data = createMemoryAppData(NOW)
  const paused = (await data.projects()).find((p) => p.status === "paused")!
  const [issue] = await data.issues(paused.id)

  await expect(data.startRun({ projectId: paused.id, issueId: issue!.id })).rejects.toThrow(/SOPORTE no está activo/)
})

test("los PRs de ejemplo arman un stack de 4 con su raíz y el resto sueltos", async () => {
  const { prs } = await createMemoryAppData(NOW).prs(false)

  const groups = listStackGroups(buildStackForest(prs))
  expect(groups[0]?.prIds).toHaveLength(4)
  expect(groups.filter((g) => g.prIds.length === 1)).toHaveLength(prs.length - 4)
})
