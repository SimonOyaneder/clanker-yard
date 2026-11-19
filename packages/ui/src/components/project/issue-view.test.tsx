// @vitest-environment jsdom
import type { CachedIssue, CachedPr } from "@clanker/api"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import { AppDataProvider } from "@/app-data"
import { PrCommandsProvider } from "@/components/prs/pr-commands"
import { TooltipProvider } from "@/components/ui/tooltip"
import { createMemoryAppData } from "@/demo/memory-app-data"
import { HostProvider, type Host } from "@/host"
import { AppActionsContext, type AppActions } from "@/lib/app-context"
import { openPrsOf } from "@/lib/prs/prs"
import { IssueView } from "./issue-view"

afterEach(cleanup)

async function setup(local = false) {
  const data = createMemoryAppData()
  const projects = await data.projects()
  const [project, other] = projects
  const [first] = await data.issues(project!.id)
  const [related] = await data.issues(other!.id)
  const issue: CachedIssue = { ...first!, body: "Descripción completa", ref: { ...first!.ref, tracker: local ? "local" : "linear" }, relations: { blocks: [], blockedBy: [], related: [related!.ref] } }
  const prs = openPrsOf(await data.openPrs())
  const remote = prs.find((p) => p.state)!
  const localPr = prs.find((p) => p.local)!
  const closed: CachedPr = { ...remote, id: "closed", issueId: issue.id, state: { ...remote.state!, state: "merged" } }
  const issuePrs: CachedPr[] = local ? [] : [{ ...localPr, issueId: issue.id }, closed]
  const runs = await data.runs({ projectId: project!.id })
  const actions = { openExternal: vi.fn(), openIssue: vi.fn(), openRun: vi.fn() }
  const openPr = vi.fn()
  render(
    <AppDataProvider value={{ ...data, issue: async () => issue, issuePrs: async () => issuePrs }}>
      <HostProvider value={{ openExternal: actions.openExternal } as unknown as Host}>
        <AppActionsContext.Provider value={actions as unknown as AppActions}>
          <TooltipProvider>
            <PrCommandsProvider prs={prs} projects={projects} onOpenRun={actions.openRun} onOpenPr={openPr}>
              <IssueView id={issue.id} slug={project!.slug} openPrs={prs} issues={[issue, related!]} runs={local ? [] : runs} />
            </PrCommandsProvider>
          </TooltipProvider>
        </AppActionsContext.Provider>
      </HostProvider>
    </AppDataProvider>,
  )
  await screen.findByText("Descripción completa")
  return { issue, related, localPr, closed, openPr, actions, project: project!, runs }
}

test("la ficha abre Linear, el PR local, el mergeado en GitHub, su corrida y la issue de otro proyecto", async () => {
  const { issue, related, localPr, closed, openPr, actions, project, runs } = await setup()
  fireEvent.click(screen.getByRole("button", { name: "Abrir en Linear" }))
  expect(actions.openExternal).toHaveBeenCalledWith(issue.ref.url)
  fireEvent.click(screen.getByRole("button", { name: new RegExp(localPr.local!.title) }))
  expect(openPr).toHaveBeenCalledWith(localPr.id)
  fireEvent.click(screen.getByRole("button", { name: /GitHub/ }))
  expect(actions.openExternal).toHaveBeenCalledWith(closed.state!.url)
  fireEvent.click(screen.getByRole("button", { name: /Relacionada con/ }))
  expect(actions.openIssue).toHaveBeenCalledWith(related)
  fireEvent.click(screen.getAllByRole("button", { name: /techlead-clasico/ })[0]!)
  expect(actions.openRun).toHaveBeenCalledWith(project.slug, runs.find((r) => r.subject.id === issue.id)!.id)
})

test("una issue local sin PR ni corridas muestra solo sus destinos disponibles", async () => {
  await setup(true)
  expect(screen.queryByRole("button", { name: /Abrir en/ })).toBeNull()
  expect(screen.queryByRole("heading", { name: /Pull requests|Corridas/ })).toBeNull()
  expect(screen.getByRole("button", { name: /Relacionada con/ })).toBeTruthy()
})
