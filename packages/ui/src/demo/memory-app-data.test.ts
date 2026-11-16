import { expect, test } from "vitest"
import { openPrsOf } from "@/lib/prs"
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

test("los PRs de ejemplo arman un stack de 4, uno con una base combinada de dos padres, y el resto sueltos", async () => {
  const prs = openPrsOf(await createMemoryAppData(NOW).openPrs())

  const forest = buildStackForest(prs)
  const groups = listStackGroups(forest)
  expect(groups.map((g) => g.prIds.length)).toEqual([4, 3, 1, 1, 1, 1, 1])
  // El PR de la base combinada cuelga de los dos y dice cuáles son.
  const [combined] = forest.combined
  expect(forest.byId.get(combined![0])?.state.key).toBe("payments-api#395")
  expect(combined![1]).toEqual(["payments-api#391", "payments-api#388"])
})

test("marcar hold apaga la oferta de merge y quitarlo la devuelve; mergear un PR en hold se rechaza", async () => {
  const data = createMemoryAppData(NOW)
  const ready = openPrsOf(await data.openPrs()).find((p) => p.state.key === "ledger#421")!

  await data.setPrHold(ready.ref, true)
  const held = openPrsOf(await data.openPrs()).find((p) => p.id === ready.id)!
  expect(held.state).toMatchObject({ hold: true, merge: { offer: false } })
  await expect(data.mergePr(ready.ref)).rejects.toThrow(/no está listo/)

  await data.setPrHold(ready.ref, false)
  expect(openPrsOf(await data.openPrs()).find((p) => p.id === ready.id)!.state.merge.offer).toBe(true)
})

test("las conexiones de ejemplo traen GitHub en regla, Linear vencida y Claude sin configurar", async () => {
  const connections = await createMemoryAppData(NOW).connections()

  expect(connections.map((c) => [c.provider, c.status])).toEqual([
    ["github", "active"],
    ["linear", "expired"],
  ])
})

test("pegar un PAT conecta GitHub, un PAT rechazado dice por qué y no cambia nada", async () => {
  const data = createMemoryAppData(NOW)

  await expect(data.setGithubPat("bad-token")).rejects.toThrow(/rechazó el token/)
  expect(await data.setGithubPat("ghp_ok")).toMatchObject({ provider: "github", status: "active", scopes: ["repo"] })
  expect((await data.connections()).filter((c) => c.provider === "github")).toHaveLength(1)
})

test("conectar Linear deja la cuenta activa y desconectar la quita", async () => {
  const data = createMemoryAppData(NOW)

  await data.linearAuth()
  expect((await data.connections()).find((c) => c.provider === "linear")?.status).toBe("active")

  await data.disconnect("linear", "clanker-yard")
  expect((await data.connections()).some((c) => c.provider === "linear")).toBe(false)
})

test("probar Claude conecta la cuenta y devuelve el plan con sus dos barras", async () => {
  const data = createMemoryAppData(NOW)

  const status = await data.testClaude()

  expect(status).toMatchObject({ state: "ready", plan: "max", usage: { fiveHour: { utilization: 0.15 }, sevenDay: { utilization: 0.42 } } })
  expect((await data.connections()).find((c) => c.provider === "claude")).toMatchObject({ account: "subscription", status: "active" })
})

test("probar la receta de un repo sin receta válida lo rechaza diciendo cuál es", async () => {
  const data = createMemoryAppData(NOW)
  const rows = await data.repos()
  const found = rows.find((r) => r.recipe.status === "found")!
  const missing = rows.find((r) => r.recipe.status === "missing")!

  await expect(data.testRecipe(missing.repo.id)).rejects.toThrow(/web no tiene una receta válida/)
  expect(await data.testRecipe(found.repo.id)).toMatchObject({ ok: true })
  expect((await data.repos()).find((r) => r.repo.id === found.repo.id)?.lastTest?.ok).toBe(true)
})

test("la cola de ejemplo son las issues en todo sin corrida", async () => {
  const data = createMemoryAppData(NOW)
  const [project] = await data.projects()
  const issues = await data.issues(project!.id)
  const runs = await data.runs({ projectId: project!.id })

  const queue = await data.queue(project!.id)

  expect(queue.map((e) => e.issue.id)).toEqual(
    issues.filter((i) => i.status === "todo" && !runs.some((r) => r.subject.id === i.id)).map((i) => i.id),
  )
  expect(queue.every((e) => e.state === "ready")).toBe(true)
})

test("setLanes cambia solo la capacidad que se pide y rechaza menos de 1", async () => {
  const data = createMemoryAppData(NOW)
  const before = await data.lanes()

  const after = await data.setLanes({ maintenance: 3 })
  expect(after.maintenance.capacity).toBe(3)
  expect(after.dev).toEqual(before.dev)
  expect((await data.lanes()).maintenance.capacity).toBe(3)

  await expect(data.setLanes({ dev: 0 })).rejects.toThrow(/entero de 1 o más/)
  expect((await data.lanes()).dev.capacity).toBe(before.dev.capacity)
})
