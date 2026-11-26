import { LIVE_RUN_STATUSES, type CachedIssue, type Decision, type DecisionId, type IssueId, type RunDetail, type RunId, type Repo } from "@clanker/api"
import { ChevronLeft, ChevronRight, Search } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { toast, Toaster } from "sonner"
import { type AppData, AppDataProvider, useAppData } from "@/app-data"
import { AppSidebar } from "@/components/app-sidebar"
import { CommandPalette } from "@/components/command-palette"
import { Shortcut } from "@/components/common"
import { ConnectionsView } from "@/components/connections/connections-view"
import { InboxView } from "@/components/inbox/inbox-view"
import { AppSettingsView } from "@/components/app-settings/app-settings-view"
import { FlowsView } from "@/components/flows/flows-view"
import { LearningsView } from "@/components/learnings/learnings-view"
import { NewProjectDialog } from "@/components/new-project-dialog"
import { type ProjectTab, ProjectFrame, ProjectView } from "@/components/project/project-view"
import { IssueView } from "@/components/project/issue-view"
import { ProjectSettingsTab, type SettingsControls } from "@/components/project-settings/settings-view"
import { ProjectSummaryTab } from "@/components/summary/summary-view"
import { RunCommandsProvider, useRunCommands } from "@/components/run/run-commands"
import type { StepTab } from "@/components/run/step-panel"
import { RunView, type RunTab } from "@/components/run/run-view"
import { PrCommandsProvider } from "@/components/prs/pr-commands"
import { type PrControls, PrView } from "@/components/prs/pr-view"
import { PrsView } from "@/components/prs/prs-view"
import { ReviewInbox } from "@/components/prs/review-inbox"
import { SetupChecklist } from "@/components/setup-checklist"
import { ShortcutsDialog } from "@/components/shortcuts-dialog"
import { StatusBanner } from "@/components/status-banner"
import { Button } from "@/components/ui/button"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useClaudePlan } from "@/hooks/use-claude-plan"
import { useCodexPlan } from "@/hooks/use-codex-plan"
import { useDecisionResolver } from "@/hooks/use-decision-resolver"
import { useHostBridge } from "@/hooks/use-host-bridge"
import { useNavHistory } from "@/hooks/use-nav-history"
import { useShellShortcuts } from "@/hooks/use-shell-shortcuts"
import { useInbox } from "@/hooks/use-inbox"
import { useLearningsView } from "@/hooks/use-learnings-view"
import { useLearningTriage } from "@/hooks/use-learning-triage"
import { useLinearLogin } from "@/hooks/use-linear-login"
import { useSummaryControls } from "@/hooks/use-summary-controls"
import { LiveProvider, useLive, useLiveQuery } from "@/hooks/use-live"
import { useProjectActions } from "@/hooks/use-project-actions"
import { useProjectData } from "@/hooks/use-project-data"
import { type Host, HostProvider, useHost } from "@/host"
import { type AppActions, AppActionsContext, MODULES, type Module } from "@/lib/app-context"
import { needsAttention } from "@/lib/connections"
import { useCoreState } from "@/lib/core-status"
import { ACTIONABLE_KINDS, NOTE_KINDS, parksRun } from "@/lib/decisions"
import { issueKey } from "@/lib/format"
import { reviewStatus } from "@/lib/prs/pr-status"
import { keyOf, openPrsOf, type OpenPr } from "@/lib/prs/prs"
import { runCaps } from "@/lib/project/run-commands"
import { shapeOf } from "@/lib/run-graph"
import { withPending } from "@/lib/learnings"
import { PR_TRIGGERS, REPO_TRIGGERS, RUN_TRIGGERS } from "@/lib/live-triggers"
import { readPref, writePref } from "@/lib/prefs"
import { barProjects } from "@/lib/projects"
import { type SetupStep, type SetupStepId, setupSteps } from "@/lib/setup"
import { cn, messageOf } from "@/lib/utils"
import { Hint } from "./components/common"
import { PageLoadError } from "@/components/page-load-error"

// Dónde está el usuario: lo que guarda el historial de atrás/adelante. `decision` es el `:decision?` de `/inbox/:decision?`,
// `tab` el `:tab` de `/p/:proyecto/:tab` y `prId` el PR abierto en Stacks de PR.
type Loc = { module: Module; slug: string | null; issueId: IssueId | null; runId: RunId | null; decision: DecisionId | null; tab: ProjectTab; prId: string | null }

const sameLoc = (a: Loc, b: Loc) =>
  a.module === b.module &&
  (a.module === "inbox"
    ? a.decision === b.decision
    : a.module === "prs"
      ? a.prId === b.prId
      : a.module !== "projects" || (a.slug === b.slug && a.issueId === b.issueId && a.runId === b.runId && a.tab === b.tab))


const NO_REPOS: readonly Repo[] = []

// La UI no sabe de dónde vienen los datos ni quién la aloja: `appData` y `host` se los da quien la monta.
export function App({ appData, host }: { appData: AppData; host: Host }) {
  // El tema lo decide el host (macOS vía nativeTheme, o el navegador): seguimos prefers-color-scheme.
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const syncTheme = () => document.documentElement.classList.toggle("dark", media.matches)
    syncTheme()
    media.addEventListener("change", syncTheme)
    return () => media.removeEventListener("change", syncTheme)
  }, [])

  return (
    <AppDataProvider value={appData}>
      <HostProvider value={host}>
        <LiveProvider>
          <TooltipProvider delayDuration={400} skipDelayDuration={150}>
            <RunCommandsProvider>
              <Shell />
            </RunCommandsProvider>
            <Toaster theme="system" position="bottom-right" closeButton toastOptions={{ className: "!text-[13px]" }} />
          </TooltipProvider>
        </LiveProvider>
      </HostProvider>
    </AppDataProvider>
  )
}

function Shell() {
  const appData = useAppData()
  const host = useHost()
  const live = useLive()
  const core = useCoreState(host.core)
  // Con el core caído lo que se ve es lo último que llegó: se atenúa y no se opera sobre eso.
  const stale = !!core && core.status !== "live"

  const projectsQuery = useLiveQuery("projects", () => appData.projects(), { on: ["project.*", "repo.added"] })
  const liveRunsQuery = useLiveQuery("live-runs", () => appData.runs({ status: [...LIVE_RUN_STATUSES] }), { on: ["run.*", "step.*"] })
  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data])
  const commands = useRunCommands()
  const connectionsQuery = useLiveQuery("connections", () => appData.connections(), { on: ["connection.*", "breaker.*"] })
  const connections = useMemo(() => connectionsQuery.data ?? [], [connectionsQuery.data])
  const [decisionId, setDecisionId] = useState<DecisionId | null>(null)
  const [prId, setPrId] = useState<string | null>(null)
  const [prControls, setPrControls] = useState<PrControls | null>(null)
  const decisionsQuery = useLiveQuery("decisions", () => appData.decisions({ kind: ACTIONABLE_KINDS }), { on: ["decision.*"] })
  const decisions = useMemo(() => decisionsQuery.data ?? [], [decisionsQuery.data])
  const resolver = useDecisionResolver(decisions, decisionsQuery.reload)
  const { undo, resolve: resolveNow } = resolver
  const inbox = useInbox(decisions, resolver.resolving, decisionId)
  const inboxBadge = inbox.pending.length ? { count: inbox.pending.length, parks: inbox.pending.some(parksRun) } : null
  // Los learnings: lo que espera su plazo de deshacer ya cuenta como aprobado o rechazado, en la lista y en el badge.
  const learningsQuery = useLiveQuery("learnings", () => appData.learnings(), { on: ["learning.*"] })
  const triage = useLearningTriage(learningsQuery.data, learningsQuery.reload)
  const learnings = useMemo(() => withPending(learningsQuery.data ?? [], triage.pending), [learningsQuery.data, triage.pending])
  const undoLearnings = triage.undo
  const learningsView = useLearningsView(learnings, triage.apply)
  const toReview = learnings.filter((l) => l.status === "proposed").length
  const claudePlan = useClaudePlan(connectionsQuery.data, connectionsQuery.reload)
  const linearConnections = useMemo(() => connections.filter((c) => c.provider === "linear"), [connections])
  const linearLogin = useLinearLogin(linearConnections, connectionsQuery.reload)
  const startLinearLogin = linearLogin.start
  const testClaude = claudePlan.test
  const codexPlan = useCodexPlan(connectionsQuery.data, connectionsQuery.reload)
  const testCodex = codexPlan.test
  const [codexDisconnect, setCodexDisconnect] = useState(false)
  // El punto rojo de Conexiones: algo vencido, revocado o caído.
  const connectionsAlert = needsAttention(connections, claudePlan.status, codexPlan.status)

  const [slug, setSlug] = useState<string | null>(() => readPref<string | null>("slug", null))
  const [issueId, setIssueId] = useState<IssueId | null>(null)
  const [runId, setRunId] = useState<RunId | null>(null)
  const [tab, setTab] = useState<ProjectTab>("operation")
  const [module, setModuleState] = useState<Module>(() => MODULES.find((m) => m === readPref<string>("module", "projects")) ?? "projects")
  const [runTab, setRunTabState] = useState<RunTab>(() => (readPref<string>("runTab", "graph") === "timeline" ? "timeline" : "graph"))
  // El panel del paso: qué nodo y qué pestaña. El nodo es de una corrida, así que al abrir otra se cierra.
  const [stepSel, setStepSel] = useState<{ runId: RunId; node: string } | null>(null)
  const [stepTab, setStepTab] = useState<StepTab>("transcript")
  const stepNode = runId && stepSel?.runId === runId ? stepSel.node : null
  const setStepNode = useCallback((node: string | null) => setStepSel(node && runId ? { runId, node } : null), [runId])
  const [sidebarOpen, setSidebarOpenState] = useState(() => readPref("sidebar", true))
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  // Ajustes del proyecto: la sección a la que llevar al abrir y lo que la pestaña deja guardar o descartar a la paleta.
  const [settingsFocus, setSettingsFocus] = useState<string | null>(null)
  const [settingsControls, setSettingsControls] = useState<SettingsControls | null>(null)
  const clearSettingsFocus = useCallback(() => setSettingsFocus(null), [])

  // El proyecto guardado puede ya no existir: se cae al primero de la barra.
  const project = projects.find((p) => p.slug === slug) ?? barProjects(projects)[0] ?? projects[0] ?? null
  const summaryVisible = module === "projects" && !runId && !issueId && tab === "summary" && !!project
  const summaryControls = useSummaryControls(summaryVisible)
  const projectData = useProjectData(project)

  // Los PRs vienen del caché del core (`prs.list`) y se releen con cada `pr.changed`: nada de polling en la UI.
  const prsQuery = useLiveQuery("prs", () => appData.openPrs(), { on: PR_TRIGGERS })
  const notesQuery = useLiveQuery("agent-notes", () => appData.decisions({ kind: NOTE_KINDS }), { on: ["decision.*"] })
  const reposQuery = useLiveQuery("repos", () => appData.repos(), { on: REPO_TRIGGERS })
  const reloadPrs = prsQuery.reload
  useEffect(() => {
    if (module === "prs") reloadPrs()
  }, [module, reloadPrs])
  const openPrs = useMemo(() => openPrsOf(prsQuery.data ?? []), [prsQuery.data])
  const viewedPr = prId === null ? undefined : openPrs.find((p) => p.id === prId)
  // La configuración inicial, cuando ya llegó todo lo que la decide (antes, ni el pie ni la bienvenida la muestran a medias).
  const setup = useMemo(
    () =>
      connectionsQuery.data && reposQuery.data && projectsQuery.data
        ? setupSteps({ connections: connectionsQuery.data, repos: reposQuery.data.length, projects: projectsQuery.data.length })
        : null,
    [connectionsQuery.data, reposQuery.data, projectsQuery.data],
  )
  const unreadPrs = (prsQuery.data?.length ?? 0) - openPrs.length
  const prsNeedingAction = openPrs.filter((p) => reviewStatus(p) === "changes").length
  const prsReady = openPrs.filter((p) => p.state?.merge.ready && !p.state.hold).length
  // Un PR o una relación puede llevar a una issue de otro proyecto.
  const allIssues = useLiveQuery(`issue-index:${projects.map((p) => p.id).join(",")}`, async () => {
    const lists = await Promise.all(projects.map((p) => appData.issues(p.id)))
    return lists.flat()
  }, { on: ["issue.*"] })

  const issueKeys = useMemo(() => new Map(allIssues.data?.map((i) => [i.id, issueKey(i)])), [allIssues.data])
  const issueProjects = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, { id: p.id, name: p.name }]))
    return new Map(allIssues.data?.flatMap((i) => {
      const owner = byId.get(i.projectId)
      return owner ? [[i.id, owner] as const] : []
    }))
  }, [projects, allIssues.data])
  const prIssue = viewedPr?.issueId ? allIssues.data?.find((i) => i.id === viewedPr.issueId) : undefined

  const setModule = useCallback((m: Module) => {
    setModuleState(m)
    writePref("module", m)
  }, [])
  const setRunTab = useCallback((tab: RunTab) => {
    setRunTabState(tab)
    writePref("runTab", tab)
  }, [])
  const setSidebarOpen = useCallback((open: boolean) => {
    setSidebarOpenState(open)
    writePref("sidebar", open)
  }, [])

  // Historial como el de un navegador: ⌘[ / ⌘], ⌘← / ⌘→ y los botones de pulgar del mouse.
  const apply = useCallback(
    (l: Loc) => {
      setModule(l.module)
      setSlug(l.slug)
      if (l.slug) writePref("slug", l.slug)
      setIssueId(l.issueId)
      setRunId(l.runId)
      setDecisionId(l.decision)
      setTab(l.tab)
      setPrId(l.prId)
    },
    [setModule],
  )
  const { go, replace, goBack, goForward, canGoBack, canGoForward } = useNavHistory<Loc>({ module, slug, issueId, runId, decision: decisionId, tab, prId }, apply, sameLoc)

  const selectProject = useCallback((s: string) => go({ module: "projects", slug: s, issueId: null, runId: null }), [go])
  const barSlugs = barProjects(projects).map((p) => p.slug)

  const goConnections = useCallback(() => go({ module: "connections" }), [go])
  const goInbox = useCallback(() => go({ module: "inbox", decision: null }), [go])
  const goLearnings = useCallback(() => go({ module: "learnings" }), [go])
  const openPr = useCallback((id: string) => go({ module: "prs", prId: id }), [go])
  const closePr = useCallback(() => go({ module: "prs", prId: null }), [go])
  const openDecision = useCallback((id: DecisionId) => go({ module: "inbox", decision: id }), [go])
  // J y K recorren la lista sin llenar el historial de atrás/adelante: reemplazan el lugar en vez de sumar uno.
  const selectDecision = useCallback((id: DecisionId) => replace({ module: "inbox", decision: id }), [replace])
  const { items: inboxItems, current: inboxCurrent } = inbox
  const resolveDecision = useCallback(
    (d: Decision, option: string) => {
      // Resolver una decisión pasa a la que sigue en la lista (o a la anterior si era la última).
      const at = inboxItems.findIndex((i) => i.id === d.id)
      const next = inboxItems[at + 1] ?? inboxItems[at - 1]
      if (d.id === inboxCurrent?.id && next) selectDecision(next.id)
      resolveNow(d, option)
    },
    [inboxItems, inboxCurrent, selectDecision, resolveNow],
  )
  const connectLinear = useCallback(() => {
    goConnections()
    void startLinearLogin()
  }, [goConnections, startLinearLogin])
  const probeClaude = useCallback(async () => {
    goConnections()
    const status = await testClaude()
    if (status) toast(`Claude: ${status.state === "ready" ? "lista" : (status.message ?? status.state)}`)
  }, [goConnections, testClaude])
  const probeCodex = useCallback(async () => {
    goConnections()
    const status = await testCodex()
    if (status) toast(`Codex: ${status.state === "ready" ? "lista" : (status.message ?? status.state)}`)
  }, [goConnections, testCodex])
  const disconnectCodex = useCallback(() => {
    goConnections()
    setCodexDisconnect(true)
  }, [goConnections])

  const goTab = useCallback((to: ProjectTab) => go({ module: "projects", runId: null, issueId: null, tab: to }), [go])
  // Cada paso de la configuración lleva a donde se hace: Linear y Claude además arrancan el login o la prueba.
  const runSetupStep = useCallback(
    (id: SetupStepId) => {
      if (id === "project") setNewProjectOpen(true)
      else if (id === "linear") connectLinear()
      else if (id === "claude") void probeClaude()
      else goConnections()
    },
    [connectLinear, probeClaude, goConnections],
  )
  const refresh = useCallback(() => {
    if (module === "prs") {
      if (viewedPr) prControls?.reload()
      // Relee cada PR de GitHub; los cambios llegan solos como `pr.changed`.
      appData.refreshPrs(openPrs.flatMap((p) => p.ref ? [p.ref] : [])).then(reloadPrs, (e: unknown) => {
        toast.error(messageOf(e))
        reloadPrs()
      })
    } else {
      live.refresh()
    }
  }, [module, reloadPrs, live, appData, openPrs, viewedPr, prControls])

  const openRun = useCallback((s: string, id: RunId) => go({ module: "projects", slug: s, issueId: null, runId: id }), [go])
  const projectActions = useProjectActions(openRun)
  const actions = useMemo<AppActions>(
    () => ({
      goModule: (to) => (to === "inbox" ? goInbox() : go({ module: to, prId: null })),
      openPalette: () => setPaletteOpen(true),
      openShortcuts: () => setShortcutsOpen(true),
      toggleSidebar: () => setSidebarOpen(!sidebarOpen),
      selectProject,
      openIssue: (issue) => {
        const owner = projects.find((p) => p.id === issue.projectId)
        if (owner) go({ module: "projects", slug: owner.slug, runId: null, issueId: issue.id })
      },
      openRun,
      openDecision,
      openNewProject: () => setNewProjectOpen(true),
      goConnections,
      connectLinear,
      testClaude: probeClaude,
      testCodex: probeCodex,
      disconnectCodex,
      ...projectActions,
      editQueueFilters: () => {
        setSettingsFocus("queue")
        go({ module: "projects", runId: null, issueId: null, tab: "settings" })
      },
      editFlow: () => {
        setSettingsFocus("flow")
        go({ module: "projects", runId: null, issueId: null, tab: "settings" })
      },
      editTrackerProject: () => {
        setSettingsFocus("tracker")
        go({ module: "projects", runId: null, issueId: null, tab: "settings" })
      },
      openExternal: host.openExternal,
      refresh,
    }),
    [projects, selectProject, openRun, go, goInbox, host, refresh, goConnections, connectLinear, probeClaude, probeCodex, disconnectCodex, openDecision, setSidebarOpen, sidebarOpen, projectActions],
  )

  useHostBridge({
    onMenu: (action) => {
      if (action === "new-project") setNewProjectOpen(true)
      else if (action === "command") setPaletteOpen((o) => !o)
      else if (action === "refresh") {
        refresh()
        toast("Actualizado", { duration: 1200 })
      } else if (action === "toggle-sidebar") setSidebarOpen(!sidebarOpen)
      else if (action === "back") goBack()
      else if (action === "forward") goForward()
      else if (action === "shortcuts") setShortcutsOpen(true)
      else if (action === "go-prs") go({ module: "prs", prId: null })
      else if (action === "go-reviews") go({ module: "reviews" })
      else if (action === "go-inbox") goInbox()
      else if (action === "go-learnings") goLearnings()
    },
    // Una notificación de una decisión abre esa decisión y nada más; la de un proyecto abre el proyecto.
    openDecision,
    selectProject,
  })

  // La corrida abierta, leída aquí para que sus atajos y la paleta sepan qué se le puede pedir.
  const runQuery = useLiveQuery<RunDetail | undefined>(runId ? `run:${runId}` : "no-run", () => (runId ? appData.run(runId) : Promise.resolve(undefined)), { on: RUN_TRIGGERS })
  const openRunDetail = runId ? runQuery.data : undefined
  const caps = useMemo(() => (openRunDetail ? runCaps(openRunDetail, shapeOf(openRunDetail.flowDef, openRunDetail.steps)) : null), [openRunDetail])

  useShellShortcuts({
    toggleMaintenance: projectActions.toggleMaintenance,
    module,
    barSlugs,
    selectProject,
    goInbox,
    goLearnings,
    goConnections,
    goTab,
    connectLinear,
    probeClaude,
    probeCodex,
    retryBreakers: () => void actions.retryBreakers(module === "projects" ? project : null),
    undoDecision: undo,
    undoLearnings,
    selectDecision,
    runId,
    run: openRunDetail,
    caps,
    commands,
    project,
    stepNode,
    closeStep: () => setStepNode(null),
    issueId,
    closeDetail: () => go({ runId: null, issueId: null }),
    setRunTab,
    setStepTab,
  })

  const detail = projectData.data
  const runPr = openRunDetail?.subject.type === "pr"
    ? openPrs.find((p) => p.id === openRunDetail.subject.id)
    : openPrs.find((p) => p.runId === runId && runId !== null)
  const runIssueId = openRunDetail?.subject.type === "issue" ? openRunDetail.subject.id : runPr?.issueId
  const openRunIssue = detail?.issues.find((i) => i.id === runIssueId)
  const currentIssue = detail?.issues.find((i) => i.id === issueId)

  return (
    <AppActionsContext.Provider value={actions}>
      <PrCommandsProvider prs={openPrs} projects={projects} onOpenRun={actions.openRun} onOpenPr={openPr}>
      <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen} className="h-full min-h-0">
        <AppSidebar
          projects={projects}
          liveRuns={liveRunsQuery.data ?? []}
          selected={project?.slug ?? null}
          module={module}
          inboxBadge={inboxBadge}
          learningsBadge={toReview}
          connectionsAlert={connectionsAlert}
          plan={claudePlan}
          codexPlan={codexPlan}
          setup={setup ? { steps: setup, onStep: runSetupStep } : null}
          prsBadge={prsQuery.data ? (prsNeedingAction ? { count: prsNeedingAction, tone: "red" } : prsReady ? { count: prsReady, tone: "green" } : { count: openPrs.length, tone: "muted" }) : null}
          connected={live.connected}
          error={projectsQuery.error}
          core={core}
        />
        <SidebarInset className="min-h-0 overflow-hidden">
          {host.core && core && core.status !== "live" ? <StatusBanner core={host.core} state={core} /> : null}
          <header className={cn("drag flex h-11 flex-none items-center gap-2 border-b pr-3", sidebarOpen ? "pl-3" : "pl-[84px]")}>
            <Hint label={sidebarOpen ? "Ocultar barra lateral" : "Mostrar barra lateral"} keys="⌘B" side="bottom">
              <SidebarTrigger className="size-7 text-muted-foreground" />
            </Hint>
            <div className="flex items-center" role="group" aria-label="Historial">
              <Hint label="Atrás" keys="⌘←" side="bottom">
                <Button size="icon-xs" variant="ghost" aria-label="Atrás" disabled={!canGoBack} onClick={goBack}><ChevronLeft /></Button>
              </Hint>
              <Hint label="Adelante" keys="⌘→" side="bottom">
                <Button size="icon-xs" variant="ghost" aria-label="Adelante" disabled={!canGoForward} onClick={goForward}><ChevronRight /></Button>
              </Hint>
            </div>
            <nav aria-label="Ubicación" className="flex min-w-0 flex-1 items-center gap-1 text-[13px]">
              {module === "inbox" ? (
                inbox.current && decisionId ? (
                  <>
                    <button type="button" onClick={goInbox} className="truncate rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
                      Bandeja
                    </button>
                    <ChevronRight className="size-3.5 flex-none text-muted-foreground" />
                    <span className="truncate px-1 font-medium">{inbox.current.title}</span>
                  </>
                ) : (
                  <span className="truncate px-1.5 font-medium">Bandeja</span>
                )
              ) : module === "learnings" ? (
                <span className="truncate px-1.5 font-medium">Learnings</span>
              ) : module === "prs" ? (
                viewedPr ? (
                  <>
                    <button type="button" onClick={closePr} className="truncate rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
                      Stacks de PR
                    </button>
                    <ChevronRight className="size-3.5 flex-none text-muted-foreground" />
                    <span className="flex-none font-mono text-xs text-muted-foreground">{keyOf(viewedPr)}</span>
                  </>
                ) : (
                  <span className="truncate px-1.5 font-medium">Stacks de PR</span>
                )
              ) : module === "reviews" ? (
                <span className="truncate px-1.5 font-medium">Mis reviews</span>
              ) : module === "connections" ? (
                <span className="truncate px-1.5 font-medium">Conexiones</span>
              ) : module === "flows" ? (
                <span className="truncate px-1.5 font-medium">Flujos</span>
              ) : module === "settings" ? (
                <span className="truncate px-1.5 font-medium">Ajustes</span>
              ) : project ? (
                runId || issueId ? (
                  <>
                    <button type="button" onClick={() => selectProject(project.slug)} className="truncate rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
                      {project.name}
                    </button>
                    <ChevronRight className="size-3.5 flex-none text-muted-foreground" />
                    {runId && openRunIssue ? (
                      <>
                        <Button size="xs" variant="ghost" onClick={() => actions.openIssue(openRunIssue)}>{issueKey(openRunIssue)}</Button>
                        <ChevronRight className="size-3.5 flex-none text-muted-foreground" />
                      </>
                    ) : null}
                    <span aria-current="page" className="truncate px-1 font-medium">{issueId ? (currentIssue ? issueKey(currentIssue) : "Issue") : "Corrida"}</span>
                  </>
                ) : (
                  <span className="truncate px-1.5 font-medium">{project.name}</span>
                )
              ) : null}
            </nav>
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className="flex h-7 w-56 items-center gap-2 rounded-md border bg-background px-2 text-xs text-muted-foreground hover:bg-accent"
            >
              <Search className="size-3.5" />
              <span className="flex-1 text-left">Buscar o ejecutar…</span>
              <Shortcut keys="⌘K" />
            </button>
          </header>

          {module === "inbox" ? (
            <main className={cn("min-h-0 flex-1 overflow-hidden transition-opacity", stale && "pointer-events-none opacity-50")}>
              <QueryGate query={decisionsQuery} pad>
                {() => <InboxView inbox={inbox} decisions={decisions} projects={projects} onSelect={selectDecision} onResolve={resolveDecision} />}
              </QueryGate>
            </main>
          ) : module === "learnings" ? (
            <main className={cn("min-h-0 flex-1 overflow-hidden transition-opacity", stale && "pointer-events-none opacity-50")}>
              <QueryGate query={learningsQuery} pad>
                {() => <LearningsView learnings={learnings} projects={projects} view={learningsView} onEdited={learningsQuery.reload} />}
              </QueryGate>
            </main>
          ) : module === "prs" ? (
            <main className={cn("min-h-0 flex-1 overflow-hidden transition-opacity", stale && "pointer-events-none opacity-50")}>
              {viewedPr ? <PrView key={viewedPr.id} pr={viewedPr} issue={prIssue} onBack={closePr} onControls={setPrControls} /> : <PrsView prs={openPrs} unread={unreadPrs} issueKeys={issueKeys} issueProjects={issueProjects} loaded={prsQuery.data !== undefined && reposQuery.data !== undefined} error={prsQuery.error} registered={reposQuery.data?.map((r) => r.repo) ?? NO_REPOS} notes={notesQuery.data} onOpenConnections={goConnections} onRefresh={refresh} />}
            </main>
          ) : module === "reviews" ? (
            <main className="min-h-0 flex-1 overflow-y-auto"><ReviewInbox /></main>
          ) : module === "flows" ? (
            <main className={cn("min-h-0 flex-1 overflow-hidden transition-opacity", stale && "pointer-events-none opacity-50")}>
              <FlowsView projects={projects} />
            </main>
          ) : module === "settings" ? (
            <main className={cn("min-h-0 flex-1 overflow-y-auto transition-opacity", stale && "pointer-events-none opacity-50")}>
              <div className="px-6 pt-5 pb-10">
                <AppSettingsView />
              </div>
            </main>
          ) : module === "connections" ? (
            <main className={cn("min-h-0 flex-1 overflow-y-auto transition-opacity", stale && "pointer-events-none opacity-50")}>
              <div className="px-6 pt-5 pb-10">
                <QueryGate query={connectionsQuery}>
                  {() => <ConnectionsView connections={connections} projects={projects} plan={claudePlan} codexPlan={codexPlan} codexDisconnect={codexDisconnect} onCodexDisconnectChange={setCodexDisconnect} linearLogin={linearLogin} onChanged={connectionsQuery.reload} />}
                </QueryGate>
              </div>
            </main>
          ) : (
            <main className={cn("min-h-0 flex-1 overflow-y-auto transition-opacity", stale && "pointer-events-none opacity-50")}>
              <div className="px-6 pt-5 pb-10">
                {!projectsQuery.data ? (
                  <QueryGate query={projectsQuery}>{() => null}</QueryGate>
                ) : !project ? (
                  <Welcome steps={setup} onStep={runSetupStep} />
                ) : issueId ? (
                  <QueryGate query={projectData}>
                    {(data) => <IssueView id={issueId} slug={project.slug} issues={allIssues.data ?? data.issues} runs={data.runs} openPrs={openPrs} />}
                  </QueryGate>
                ) : runId ? (
                  <QueryGate query={projectData}>
                    {() => <RunPane key={runId} query={runQuery} issue={openRunIssue} pr={runPr} tab={runTab} onTab={setRunTab} node={stepNode} onNode={setStepNode} stepTab={stepTab} onStepTab={setStepTab} onBack={() => go({ runId: null })} />}
                  </QueryGate>
                ) : (
                  <ProjectFrame project={project} tab={tab} onTab={goTab}>
                    {tab === "summary" ? (
                      <ProjectSummaryTab project={project} controls={summaryControls} onOpenOperation={() => goTab("operation")} />
                    ) : tab === "settings" ? (
                      <ProjectSettingsTab project={project} focus={settingsFocus} onFocused={clearSettingsFocus} onControls={setSettingsControls} />
                    ) : (
                      <QueryGate query={projectData}>{(data) => <ProjectView project={project} {...data} />}</QueryGate>
                    )}
                  </ProjectFrame>
                )}
              </div>
            </main>
          )}
        </SidebarInset>
      </SidebarProvider>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        projects={projects}
        current={project}
        runs={detail?.runs ?? []}
        issues={detail?.issues ?? []}
        queue={module === "projects" && !runId && !issueId ? (detail?.queue ?? []) : null}
        prs={openPrs}
        contextIssue={module === "prs" ? prIssue : module === "projects" ? currentIssue ?? openRunIssue : undefined}
        prsActive={module === "prs"}
        pr={module === "prs" && viewedPr ? prControls : null}
        learnings={module === "learnings" ? { view: learningsView, onUndo: triage.canUndo ? () => void triage.undo() : null } : null}
        pendingDecisions={inbox.pending}
        onUndoDecision={resolver.canUndo ? () => void undo() : null}
        onDecision={module === "inbox" && inbox.current?.status === "pending" ? { decision: inbox.current, onResolve: resolveDecision, onRespond: () => inbox.setResponding(true) } : null}
        projectTab={project && module === "projects" ? { tab, onTab: goTab } : null}
        settings={module === "projects" && !runId && !issueId && tab === "settings" ? settingsControls : null}
        summary={summaryVisible ? summaryControls : null}
        onRunTab={runId && module === "projects" ? setRunTab : null}
        runCaps={runId && module === "projects" && openRunDetail ? { id: openRunDetail.id, caps: caps! } : null}
        onStep={stepNode ? { onTab: setStepTab, onClose: () => setStepNode(null) } : null}
      />
      <NewProjectDialog
        open={newProjectOpen}
        onOpenChange={setNewProjectOpen}
        onOpenConnections={() => {
          setNewProjectOpen(false)
          goConnections()
        }}
        onCreated={(created) => {
          setNewProjectOpen(false)
          live.refresh()
          selectProject(created.slug)
          toast.success(`Creé ${created.name}`)
        }}
      />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      </PrCommandsProvider>
    </AppActionsContext.Provider>
  )
}

function RunPane({
  query: run,
  issue,
  pr,
  tab,
  onTab,
  node,
  onNode,
  stepTab,
  onStepTab,
  onBack,
}: {
  query: { data: RunDetail | undefined; error: string | null; reload: () => void }
  issue: CachedIssue | undefined
  pr: OpenPr | undefined
  tab: RunTab
  onTab: (tab: RunTab) => void
  node: string | null
  onNode: (nodeId: string | null) => void
  stepTab: StepTab
  onStepTab: (tab: StepTab) => void
  onBack: () => void
}) {
  if (run.data) return <RunView run={run.data} issue={issue} pr={pr} tab={tab} onTabChange={onTab} node={node} onNodeChange={onNode} stepTab={stepTab} onStepTab={onStepTab} />
  if (run.error) {
    return (
      <Problem
        message={run.error}
        onRetry={run.reload}
        extra={
          <Button size="sm" variant="ghost" onClick={onBack}>
            Volver al proyecto
          </Button>
        }
      />
    )
  }
  return <Loading />
}

/**
 * Lo que se ve de una lectura del core: `children` con sus datos, el error con reintentar o el esqueleto mientras
 * carga. Con `pad` el error y el esqueleto llevan el margen de una vista que ocupa todo el alto.
 */
function QueryGate<T>({ query, pad = false, children }: { query: { data: T | undefined; error: string | null; reload: () => void }; pad?: boolean; children: (data: NonNullable<T>) => React.ReactNode }) {
  if (query.data !== undefined && query.data !== null) return <>{children(query.data)}</>
  const pending = query.error ? <Problem message={query.error} onRetry={query.reload} /> : <Loading />
  return pad ? <div className="px-6 pt-5">{pending}</div> : pending
}

function Loading() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-8 w-72" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-80 w-full" />
    </div>
  )
}

function Problem({ message, onRetry, extra }: { message: string; onRetry: () => void; extra?: React.ReactNode }) {
  return <PageLoadError title="No pude leer del core" message={message} onRetry={onRetry} extra={extra} className="mt-24" />
}

// Sin proyectos: qué es la app y los pasos para lanzar la primera corrida, los mismos del pie de la barra lateral.
function Welcome({ steps, onStep }: { steps: readonly SetupStep[] | null; onStep: (id: SetupStepId) => void }) {
  return (
    <div className="mx-auto mt-16 flex max-w-md flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <h2 className="text-base font-semibold">Bienvenido a Clanker Yard</h2>
        <p className="text-muted-foreground">
          Toma issues de Linear y las lleva hasta un PR en GitHub con un equipo de agentes de Claude: uno planifica, otro implementa y varios revisan. Lo que necesita tu
          criterio te espera en la Bandeja; el resto sigue solo.
        </p>
      </div>
      {steps ? <SetupChecklist steps={steps} onStep={onStep} /> : <Skeleton className="h-60 w-full" />}
    </div>
  )
}
