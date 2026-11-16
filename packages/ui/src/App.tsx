import type { CachedIssue, ClankerProject, Decision, DecisionId, RunDetail, RunId, RunStatus } from "@clanker/api"
import { ChevronRight, Plus, Search } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast, Toaster } from "sonner"
import { type AppData, AppDataProvider, useAppData } from "@/app-data"
import { AppSidebar } from "@/components/app-sidebar"
import { CommandPalette } from "@/components/command-palette"
import { Shortcut } from "@/components/common"
import { ConnectionsView } from "@/components/connections/connections-view"
import { InboxView } from "@/components/inbox/inbox-view"
import { LearningsView } from "@/components/learnings/learnings-view"
import { NewProjectDialog } from "@/components/new-project-dialog"
import { PROJECT_TABS, type ProjectTab, ProjectFrame, ProjectView, issuesById } from "@/components/project/project-view"
import { ProjectSettingsTab, type SettingsControls } from "@/components/project/settings-view"
import { ProjectSummaryTab } from "@/components/project/summary-view"
import { RunCommandsProvider, useRunCommands } from "@/components/project/run-commands"
import { STEP_TAB_KEYS, type StepTab } from "@/components/project/step-panel"
import { RunView, type RunTab } from "@/components/project/run-view"
import { PrCommandsProvider } from "@/components/prs/pr-commands"
import { PrsView } from "@/components/prs/prs-view"
import { ShortcutsDialog } from "@/components/shortcuts-dialog"
import { StatusBanner } from "@/components/status-banner"
import { Button } from "@/components/ui/button"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useClaudePlan } from "@/hooks/use-claude-plan"
import { useDecisionResolver } from "@/hooks/use-decision-resolver"
import { useInbox } from "@/hooks/use-inbox"
import { useLearningsView } from "@/hooks/use-learnings-view"
import { useLearningTriage } from "@/hooks/use-learning-triage"
import { useLinearLogin } from "@/hooks/use-linear-login"
import { useSummaryControls } from "@/hooks/use-summary-controls"
import { LiveProvider, useLive, useLiveQuery } from "@/hooks/use-live"
import { type Host, HostProvider, useHost } from "@/host"
import { type AppActions, AppActionsContext } from "@/lib/app-context"
import { connectionOf, needsAttention } from "@/lib/connections"
import { useCoreState } from "@/lib/core-status"
import { parksRun } from "@/lib/decisions"
import { issueKey } from "@/lib/format"
import { reviewStatus } from "@/lib/pr-status"
import { openPrsOf } from "@/lib/prs"
import { runCaps } from "@/lib/run-commands"
import { shapeOf } from "@/lib/run-graph"
import { withPending } from "@/lib/learnings"
import { readPref, writePref } from "@/lib/prefs"
import { messageOf, undoable } from "@/lib/undoable"
import { barProjects } from "@/lib/projects"
import { cn } from "@/lib/utils"
import { Hint } from "./components/common"

type Module = "projects" | "prs" | "connections" | "inbox" | "learnings"
// Dónde está el usuario: lo que guarda el historial de atrás/adelante. `decision` es el `:decision?` de `/inbox/:decision?`
// y `tab` el `:tab` de `/p/:proyecto/:tab`.
type Loc = { module: Module; slug: string | null; runId: RunId | null; decision: DecisionId | null; tab: ProjectTab }

const sameLoc = (a: Loc, b: Loc) =>
  a.module === b.module && (a.module === "inbox" ? a.decision === b.decision : a.module !== "projects" || (a.slug === b.slug && a.runId === b.runId && a.tab === b.tab))

const MODULES: readonly Module[] = ["projects", "prs", "connections", "inbox", "learnings"]

// Estas decisiones avisan con una notificación nativa: alguien las tiene que atender. Las notas esperan en la bandeja.
const NOTIFY_KINDS = new Set(["gate", "needs_human", "alert"])

const MAX_HISTORY = 50

const NO_ISSUE_KEYS: ReadonlyMap<string, string> = new Map()

const LIVE_STATUSES: RunStatus[] = ["queued", "running", "waiting", "parked", "paused"]

// Las acciones de `AppActions` no devuelven nada: el fallo ya salió en el toast.
const reversible = async (...args: Parameters<typeof undoable>): Promise<void> => void (await undoable(...args))

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

  const projectsQuery = useLiveQuery("projects", () => appData.projects())
  const liveRunsQuery = useLiveQuery("live-runs", () => appData.runs({ status: LIVE_STATUSES }))
  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data])
  const commands = useRunCommands()
  const connectionsQuery = useLiveQuery("connections", () => appData.connections())
  const connections = useMemo(() => connectionsQuery.data ?? [], [connectionsQuery.data])
  const [decisionId, setDecisionId] = useState<DecisionId | null>(null)
  const decisionsQuery = useLiveQuery("decisions", () => appData.decisions())
  const decisions = useMemo(() => decisionsQuery.data ?? [], [decisionsQuery.data])
  const resolver = useDecisionResolver(decisions, decisionsQuery.reload)
  const { undo, resolve: resolveNow } = resolver
  const inbox = useInbox(decisions, resolver.resolving, decisionId)
  const inboxBadge = inbox.pending.length ? { count: inbox.pending.length, parks: inbox.pending.some(parksRun) } : null
  // Los learnings: lo que espera su plazo de deshacer ya cuenta como aprobado o rechazado, en la lista y en el badge.
  const learningsQuery = useLiveQuery("learnings", () => appData.learnings())
  const triage = useLearningTriage(learningsQuery.data, learningsQuery.reload)
  const learnings = useMemo(() => withPending(learningsQuery.data ?? [], triage.pending), [learningsQuery.data, triage.pending])
  const undoLearnings = triage.undo
  const learningsView = useLearningsView(learnings, triage.apply)
  const toReview = learnings.filter((l) => l.status === "proposed").length
  const claudePlan = useClaudePlan(connectionsQuery.data, connectionsQuery.reload)
  const linearLogin = useLinearLogin(connectionOf(connections, "linear"), connectionsQuery.reload)
  const startLinearLogin = linearLogin.start
  const testClaude = claudePlan.test
  // El punto rojo de Conexiones: algo vencido, revocado o caído.
  const connectionsAlert = needsAttention(connections, claudePlan.status)

  const [slug, setSlug] = useState<string | null>(() => readPref<string | null>("slug", null))
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
  const summaryVisible = module === "projects" && !runId && tab === "summary" && !!project
  const summaryControls = useSummaryControls(summaryVisible)
  const projectData = useLiveQuery(project ? `project:${project.id}` : "no-project", async () => {
    if (!project) return null
    const [runs, issues, queue, decisions, lanes, breakers, prs] = await Promise.all([
      appData.runs({ projectId: project.id }),
      appData.issues(project.id),
      // Una cola que no se puede calcular (el tracker sin cuenta conectada) no esconde el resto de la operación.
      appData.queue(project.id).then(
        (entries) => ({ queue: entries }),
        (e: unknown) => ({ queue: [], queueError: messageOf(e) }),
      ),
      appData.decisions({ projectId: project.id, status: ["pending"] }),
      appData.lanes(),
      appData.breakers(),
      appData.openPrs(),
    ])
    return { runs, issues, ...queue, decisions, lanes, breakers, prs }
  })

  // Los PRs vienen del caché del core (`prs.list`) y se releen con cada `pr.changed`: nada de polling en la UI.
  const prsQuery = useLiveQuery("prs", () => appData.openPrs())
  const reloadPrs = prsQuery.reload
  useEffect(() => {
    if (module === "prs") reloadPrs()
  }, [module, reloadPrs])
  const openPrs = useMemo(() => openPrsOf(prsQuery.data ?? []), [prsQuery.data])
  const unreadPrs = (prsQuery.data?.length ?? 0) - openPrs.length
  const prsNeedingAction = openPrs.filter((p) => reviewStatus(p) === "changes").length
  const prsReady = openPrs.filter((p) => p.state.merge.ready && !p.state.hold).length
  // La clave de la issue que originó cada PR del sistema: se pide de todos los proyectos, no del abierto.
  const issueKeysQuery = useLiveQuery(`pr-issue-keys:${projects.map((p) => p.id).join(",")}`, async () => {
    const lists = await Promise.all(projects.map((p) => appData.issues(p.id)))
    return new Map(lists.flat().map((issue) => [issue.id, issueKey(issue)]))
  })

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

  // Historial como el de un navegador: ⌘[ / ⌘] y los botones de pulgar del mouse.
  const here = useRef<Loc>({ module, slug, runId, decision: decisionId, tab })
  here.current = { module, slug, runId, decision: decisionId, tab }
  const backStack = useRef<Loc[]>([])
  const forwardStack = useRef<Loc[]>([])
  const apply = useCallback(
    (l: Loc) => {
      setModule(l.module)
      setSlug(l.slug)
      if (l.slug) writePref("slug", l.slug)
      setRunId(l.runId)
      setDecisionId(l.decision)
      setTab(l.tab)
    },
    [setModule],
  )
  const go = useCallback(
    (to: Partial<Loc>) => {
      const cur = here.current
      const next = { ...cur, ...to }
      if (!sameLoc(cur, next)) {
        backStack.current = [...backStack.current, cur].slice(-MAX_HISTORY)
        forwardStack.current = []
      }
      here.current = next
      apply(next)
    },
    [apply],
  )
  const goBack = useCallback(() => {
    const prev = backStack.current.pop()
    if (!prev) return
    forwardStack.current.push(here.current)
    here.current = prev
    apply(prev)
  }, [apply])
  const goForward = useCallback(() => {
    const next = forwardStack.current.pop()
    if (!next) return
    backStack.current.push(here.current)
    here.current = next
    apply(next)
  }, [apply])

  const selectProject = useCallback((s: string) => go({ module: "projects", slug: s, runId: null }), [go])
  const barSlugs = barProjects(projects).map((p) => p.slug)

  // Botones 4 y 5 del mouse (los de pulgar de un MX Master): en el DOM son button 3 y 4.
  useEffect(() => {
    const isNav = (e: MouseEvent) => e.button === 3 || e.button === 4
    const onDown = (e: MouseEvent) => {
      if (isNav(e)) e.preventDefault()
    }
    const onUp = (e: MouseEvent) => {
      if (!isNav(e)) return
      e.preventDefault()
      if (e.button === 3) goBack()
      else goForward()
    }
    // ⌘← / ⌘→ como en Safari y Finder: en teclados como el español, [ y ] van con ⌥. En un campo de
    // texto no: ahí ⌘← / ⌘→ mueven el cursor al inicio o al final de la línea.
    const onKey = (e: KeyboardEvent) => {
      // ⌘[ / ⌘] por tecla física: Logi Options+ los manda con el código de la tecla de un teclado US,
      // que en el layout español no produce "[" ni "]".
      if (e.metaKey && !e.ctrlKey && !e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight")) {
        e.preventDefault()
        if (e.code === "BracketLeft") goBack()
        else goForward()
        return
      }
      if (!e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return
      const digit = /^Digit([1-9])$/.exec(e.code)?.[1]
      const target = digit ? barSlugs[Number(digit) - 1] : undefined
      if (target) {
        e.preventDefault()
        selectProject(target)
        return
      }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
      const t = e.target as HTMLElement | null
      if (t?.closest("input, textarea, select, [contenteditable='true']")) return
      e.preventDefault()
      if (e.key === "ArrowLeft") goBack()
      else goForward()
    }
    window.addEventListener("mousedown", onDown)
    window.addEventListener("mouseup", onUp)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("mousedown", onDown)
      window.removeEventListener("mouseup", onUp)
      window.removeEventListener("keydown", onKey)
    }
    // `barSlugs` es un array nuevo en cada render: su contenido manda, no su identidad.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goBack, goForward, selectProject, barSlugs.join(",")])

  const goConnections = useCallback(() => go({ module: "connections" }), [go])
  const goInbox = useCallback(() => go({ module: "inbox", decision: null }), [go])
  const goLearnings = useCallback(() => go({ module: "learnings" }), [go])
  const openDecision = useCallback((id: DecisionId) => go({ module: "inbox", decision: id }), [go])
  // J y K recorren la lista sin llenar el historial de atrás/adelante: reemplazan el lugar en vez de sumar uno.
  const selectDecision = useCallback(
    (id: DecisionId) => {
      const next = { ...here.current, module: "inbox" as const, decision: id }
      here.current = next
      apply(next)
    },
    [apply],
  )
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

  // G y luego I, A o C (como en Linear) va a la Bandeja, a Learnings o a Conexiones; ⇧⌘I y ⇧⌘A también van a la Bandeja y
  // a Learnings, ⇧⌘L conecta Linear y ⇧⌘T prueba Claude.
  useEffect(() => {
    let armed: ReturnType<typeof setTimeout> | undefined
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey && (e.code === "KeyL" || e.code === "KeyT" || e.code === "KeyI" || e.code === "KeyA")) {
        e.preventDefault()
        if (e.code === "KeyL") connectLinear()
        else if (e.code === "KeyI") goInbox()
        else if (e.code === "KeyA") goLearnings()
        else void probeClaude()
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
      if ((e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable='true'], [role='dialog']")) return
      const key = e.key.toLowerCase()
      if (armed && (key === "c" || key === "i" || key === "a")) {
        e.preventDefault()
        if (key === "c") goConnections()
        else if (key === "a") goLearnings()
        else goInbox()
      }
      clearTimeout(armed)
      armed = key === "g" ? setTimeout(() => (armed = undefined), 1000) : undefined
    }
    window.addEventListener("keydown", onKey)
    return () => {
      clearTimeout(armed)
      window.removeEventListener("keydown", onKey)
    }
  }, [goConnections, goInbox, goLearnings, connectLinear, probeClaude])

  // ⇧⌘1, ⇧⌘2 y ⇧⌘3: Operación, Resumen y Ajustes del proyecto (también desde una corrida: vuelve al proyecto).
  const goTab = useCallback((to: ProjectTab) => go({ module: "projects", runId: null, tab: to }), [go])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || !e.shiftKey || e.altKey || e.ctrlKey) return
      const target = { Digit1: PROJECT_TABS[0], Digit2: PROJECT_TABS[1], Digit3: PROJECT_TABS[2] }[e.code]
      if (!target) return
      e.preventDefault()
      goTab(target)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [goTab])

  const refresh = useCallback(() => {
    if (module === "prs") {
      // Relee cada PR de GitHub; los cambios llegan solos como `pr.changed`.
      appData.refreshPrs(openPrs.map((p) => p.ref)).then(reloadPrs, (e: unknown) => {
        toast.error(messageOf(e))
        reloadPrs()
      })
    } else {
      live.refresh()
    }
  }, [module, reloadPrs, live, appData, openPrs])

  const actions = useMemo<AppActions>(
    () => ({
      selectProject,
      openRun: (s, id) => go({ module: "projects", slug: s, runId: id }),
      openDecision,
      openNewProject: () => setNewProjectOpen(true),
      goConnections,
      connectLinear,
      testClaude: probeClaude,
      startRun: async (p: ClankerProject, issue: CachedIssue) => {
        try {
          const started = await appData.startRun({ projectId: p.id, issueId: issue.id })
          toast.success(`Corrida lanzada para ${issueKey(issue)}`, { action: { label: "Ver", onClick: () => go({ module: "projects", slug: p.slug, runId: started.id }) } })
        } catch (e) {
          toast.error(messageOf(e))
        }
      },
      setParallel: (p, parallel) =>
        reversible(
          `${p.name}: ${parallel} ${parallel === 1 ? "corrida" : "corridas"} a la vez en dev`,
          () => appData.updateProject(p.id, { parallel }),
          () => appData.updateProject(p.id, { parallel: p.parallel }),
        ),
      skipIssue: (p, issue, skipped) =>
        reversible(
          skipped ? `No tomaré ${issueKey(issue)}` : `${issueKey(issue)} vuelve a la cola`,
          () => appData.skipIssue(p.id, issue.id, skipped),
          () => appData.skipIssue(p.id, issue.id, !skipped),
        ),
      boostIssue: (p, issue) =>
        reversible(
          `${issueKey(issue)} sube al principio de la cola`,
          () => appData.boostIssue(p.id, issue.id, true),
          () => appData.boostIssue(p.id, issue.id, false),
        ),
      editQueueFilters: () => {
        setSettingsFocus("queue")
        go({ module: "projects", runId: null, tab: "settings" })
      },
      openExternal: host.openExternal,
      refresh,
    }),
    [selectProject, go, appData, host, refresh, goConnections, connectLinear, probeClaude, openDecision],
  )

  // Menú nativo (accelerators) y clicks en notificaciones.
  useEffect(() => {
    const offMenu = host.onMenu((action) => {
      if (action === "new-project") setNewProjectOpen(true)
      else if (action === "command") setPaletteOpen((o) => !o)
      else if (action === "refresh") {
        refresh()
        toast("Actualizado", { duration: 1200 })
      } else if (action === "toggle-sidebar") setSidebarOpen(!sidebarOpen)
      else if (action === "back") goBack()
      else if (action === "forward") goForward()
      else if (action === "shortcuts") setShortcutsOpen(true)
      else if (action === "go-prs") go({ module: "prs" })
      else if (action === "go-inbox") goInbox()
      else if (action === "go-learnings") goLearnings()
    })
    // Una notificación de una decisión abre esa decisión y nada más; la de un proyecto abre el proyecto.
    const offNav = host.onNavigate((target) => ("decisionId" in target ? openDecision(target.decisionId as DecisionId) : selectProject(target.slug)))
    return () => {
      offMenu()
      offNav()
    }
  }, [refresh, go, goBack, goForward, goInbox, goLearnings, openDecision, setSidebarOpen, sidebarOpen, selectProject, host])

  // Una decisión que alguien tiene que atender avisa con una notificación nativa, si la ventana no está a la vista.
  // Solo abre la decisión: aprobar o rechazar se hace en la bandeja.
  useEffect(
    () =>
      live.subscribe((event) => {
        const { decisionId: id, kind, title } = event.payload as { decisionId?: string; kind?: string; title?: string }
        if (event.type !== "decision.opened" || !id || !title || !NOTIFY_KINDS.has(kind ?? "") || document.hasFocus()) return
        host.notify({ title: kind === "alert" ? "Alerta en Clanker Yard" : "Una corrida te espera", body: title, target: { decisionId: id } })
      }),
    [live, host],
  )

  // Z deshace la última decisión que se respondió, mientras no se haya mandado al core.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "z" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat) return
      if ((e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable='true'], [role='dialog']")) return
      const undone = undo()
      if (!undone) {
        // Sin una decisión que deshacer, Z devuelve la última de learnings que todavía no se mandó.
        if (undoLearnings()) e.preventDefault()
        return
      }
      e.preventDefault()
      if (module === "inbox") selectDecision(undone)
      else toast("Volvió a la bandeja", { duration: 1500 })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [undo, undoLearnings, module, selectDecision])

  // Esc sube un nivel: del panel del paso a la corrida y de la corrida al proyecto, salvo que haya un diálogo o menú abierto.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !runId || module !== "projects") return
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return
      if (stepNode) setStepNode(null)
      else go({ runId: null })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [runId, module, go, stepNode, setStepNode])

  // G y L cambian entre el grafo y la línea de tiempo de la corrida abierta, como las teclas de Linear;
  // con el panel de un paso abierto, T, B, R, A e I eligen su pestaña.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!runId || module !== "projects" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      if ((e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable='true']")) return
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return
      const key = e.key.toLowerCase()
      const tab = key === "g" ? "graph" : key === "l" ? "timeline" : null
      if (tab) return setRunTab(tab)
      const step = stepNode ? STEP_TAB_KEYS[key] : undefined
      // La pestaña principal depende del nodo (transcript o comando): `transcript` cae a la primera de las suyas.
      if (step) setStepTab(step === "main" ? "transcript" : step)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [runId, module, setRunTab, stepNode])

  // La corrida abierta, leída aquí para que sus atajos y la paleta sepan qué se le puede pedir.
  const runQuery = useLiveQuery<RunDetail | undefined>(runId ? `run:${runId}` : "no-run", () => (runId ? appData.run(runId) : Promise.resolve(undefined)))
  const openRunDetail = runId ? runQuery.data : undefined
  const caps = useMemo(() => (openRunDetail ? runCaps(openRunDetail, shapeOf(openRunDetail.flowDef, openRunDetail.steps)) : null), [openRunDetail])

  // ⌘. interrumpe, ⇧⌘. pausa o retoma, ⇧⌘R reintenta el paso fallido, ⇧⌘⌫ cancela la corrida abierta y ⇧⌘Y pausa o reanuda el proyecto.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.ctrlKey || module !== "projects") return
      const run = runId && openRunDetail?.id === runId ? openRunDetail : undefined
      if (!e.shiftKey && e.code === "Period" && run && caps?.interrupt) commands.interrupt(run.id)
      else if (e.shiftKey && e.code === "Period" && run && caps?.pause) commands.pause(run.id)
      else if (e.shiftKey && e.code === "Period" && run && caps?.resume) commands.resume(run.id)
      else if (e.shiftKey && e.code === "KeyR" && caps?.failedStep) commands.retry(caps.failedStep.id, caps.failedStep.nodeId)
      else if (e.shiftKey && e.key === "Backspace" && run && caps?.cancel) commands.cancel(run.id)
      else if (e.shiftKey && e.code === "KeyY" && !runId && project?.status === "active") commands.pauseProject(project)
      else if (e.shiftKey && e.code === "KeyY" && !runId && project?.status === "paused") commands.resumeProject(project)
      else return
      e.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [module, runId, openRunDetail, caps, commands, project])

  const detail = projectData.data
  const openRun = runId && detail ? detail.runs.find((r) => r.id === runId) : undefined
  const openRunIssue = openRun && detail ? issuesById(detail.issues).get(openRun.subject.id) : undefined

  return (
    <AppActionsContext.Provider value={actions}>
      <PrCommandsProvider prs={openPrs} projects={projects} onOpenRun={actions.openRun}>
      <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen} className="h-full min-h-0">
        <AppSidebar
          projects={projects}
          liveRuns={liveRunsQuery.data ?? []}
          selected={project?.slug ?? null}
          inboxActive={module === "inbox"}
          inboxBadge={inboxBadge}
          onSelectInbox={goInbox}
          learningsActive={module === "learnings"}
          learningsBadge={toReview}
          onSelectLearnings={goLearnings}
          prsActive={module === "prs"}
          connectionsActive={module === "connections"}
          connectionsAlert={connectionsAlert}
          onSelectConnections={goConnections}
          plan={claudePlan}
          prsBadge={prsQuery.data ? (prsNeedingAction ? { count: prsNeedingAction, tone: "red" } : prsReady ? { count: prsReady, tone: "green" } : { count: openPrs.length, tone: "muted" }) : null}
          onSelectPrs={() => go({ module: "prs" })}
          connected={live.connected}
          error={projectsQuery.error}
          core={core}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenShortcuts={() => setShortcutsOpen(true)}
        />
        <SidebarInset className="min-h-0 overflow-hidden">
          {host.core && core && core.status !== "live" ? <StatusBanner core={host.core} state={core} /> : null}
          <header className={cn("drag flex h-11 flex-none items-center gap-2 border-b pr-3", sidebarOpen ? "pl-3" : "pl-[84px]")}>
            <Hint label={sidebarOpen ? "Ocultar barra lateral" : "Mostrar barra lateral"} keys="⌘B" side="bottom">
              <SidebarTrigger className="size-7 text-muted-foreground" />
            </Hint>
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
                <span className="truncate px-1.5 font-medium">Stacks de PR</span>
              ) : module === "connections" ? (
                <span className="truncate px-1.5 font-medium">Conexiones</span>
              ) : project ? (
                runId ? (
                  <>
                    <button type="button" onClick={() => go({ runId: null })} className="truncate rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
                      {project.name}
                    </button>
                    <ChevronRight className="size-3.5 flex-none text-muted-foreground" />
                    <span className="flex-none font-mono text-xs text-muted-foreground">{openRunIssue ? issueKey(openRunIssue) : "corrida"}</span>
                    {openRunIssue ? <span className="truncate px-1 font-medium">{openRunIssue.title}</span> : null}
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
              {decisionsQuery.data ? (
                <InboxView inbox={inbox} decisions={decisions} projects={projects} onSelect={selectDecision} onResolve={resolveDecision} />
              ) : decisionsQuery.error ? (
                <div className="px-6 pt-5">
                  <Problem message={decisionsQuery.error} onRetry={decisionsQuery.reload} />
                </div>
              ) : (
                <div className="px-6 pt-5">
                  <Loading />
                </div>
              )}
            </main>
          ) : module === "learnings" ? (
            <main className={cn("min-h-0 flex-1 overflow-hidden transition-opacity", stale && "pointer-events-none opacity-50")}>
              {learningsQuery.data ? (
                <LearningsView learnings={learnings} projects={projects} view={learningsView} onEdited={learningsQuery.reload} />
              ) : learningsQuery.error ? (
                <div className="px-6 pt-5">
                  <Problem message={learningsQuery.error} onRetry={learningsQuery.reload} />
                </div>
              ) : (
                <div className="px-6 pt-5">
                  <Loading />
                </div>
              )}
            </main>
          ) : module === "prs" ? (
            <main className={cn("min-h-0 flex-1 overflow-hidden transition-opacity", stale && "pointer-events-none opacity-50")}>
              <PrsView prs={openPrs} unread={unreadPrs} issueKeys={issueKeysQuery.data ?? NO_ISSUE_KEYS} loaded={prsQuery.data !== undefined} error={prsQuery.error} onRefresh={refresh} />
            </main>
          ) : module === "connections" ? (
            <main className={cn("min-h-0 flex-1 overflow-y-auto transition-opacity", stale && "pointer-events-none opacity-50")}>
              <div className="px-6 pt-5 pb-10">
                {connectionsQuery.data ? (
                  <ConnectionsView connections={connections} plan={claudePlan} linearLogin={linearLogin} onChanged={connectionsQuery.reload} />
                ) : connectionsQuery.error ? (
                  <Problem message={connectionsQuery.error} onRetry={connectionsQuery.reload} />
                ) : (
                  <Loading />
                )}
              </div>
            </main>
          ) : (
            <main className={cn("min-h-0 flex-1 overflow-y-auto transition-opacity", stale && "pointer-events-none opacity-50")}>
              <div className="px-6 pt-5 pb-10">
                {!projectsQuery.data ? (
                  projectsQuery.error ? (
                    <Problem message={projectsQuery.error} onRetry={projectsQuery.reload} />
                  ) : (
                    <Loading />
                  )
                ) : !project ? (
                  <NoProjects onCreate={() => setNewProjectOpen(true)} />
                ) : runId ? (
                  !detail ? (
                    projectData.error ? (
                      <Problem message={projectData.error} onRetry={projectData.reload} />
                    ) : (
                      <Loading />
                    )
                  ) : (
                    <RunPane key={runId} query={runQuery} issue={openRunIssue} tab={runTab} onTab={setRunTab} node={stepNode} onNode={setStepNode} stepTab={stepTab} onStepTab={setStepTab} onBack={() => go({ runId: null })} />
                  )
                ) : (
                  <ProjectFrame project={project} tab={tab} onTab={goTab}>
                    {tab === "summary" ? (
                      <ProjectSummaryTab project={project} controls={summaryControls} onOpenOperation={() => goTab("operation")} />
                    ) : tab === "settings" ? (
                      <ProjectSettingsTab project={project} focus={settingsFocus} onFocused={clearSettingsFocus} onControls={setSettingsControls} />
                    ) : detail ? (
                      <ProjectView project={project} {...detail} />
                    ) : projectData.error ? (
                      <Problem message={projectData.error} onRetry={projectData.reload} />
                    ) : (
                      <Loading />
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
        queue={module === "projects" && !runId ? (detail?.queue ?? []) : null}
        onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        prs={openPrs}
        prsActive={module === "prs"}
        onGoPrs={() => go({ module: "prs" })}
        onGoInbox={goInbox}
        onGoLearnings={goLearnings}
        learnings={module === "learnings" ? { view: learningsView, onUndo: triage.canUndo ? () => void triage.undo() : null } : null}
        pendingDecisions={inbox.pending}
        onOpenDecision={openDecision}
        onUndoDecision={resolver.canUndo ? () => void undo() : null}
        onDecision={module === "inbox" && inbox.current?.status === "pending" ? { decision: inbox.current, onResolve: resolveDecision, onRespond: () => inbox.setResponding(true) } : null}
        projectTab={project && module === "projects" ? { tab, onTab: goTab } : null}
        settings={module === "projects" && !runId && tab === "settings" ? settingsControls : null}
        summary={summaryVisible ? summaryControls : null}
        onRunTab={runId && module === "projects" ? setRunTab : null}
        runCaps={runId && module === "projects" && openRunDetail ? { id: openRunDetail.id, caps: caps! } : null}
        onStep={stepNode ? { onTab: setStepTab, onClose: () => setStepNode(null) } : null}
      />
      <NewProjectDialog
        open={newProjectOpen}
        onOpenChange={setNewProjectOpen}
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
  tab: RunTab
  onTab: (tab: RunTab) => void
  node: string | null
  onNode: (nodeId: string | null) => void
  stepTab: StepTab
  onStepTab: (tab: StepTab) => void
  onBack: () => void
}) {
  if (run.data) return <RunView run={run.data} issue={issue} tab={tab} onTabChange={onTab} node={node} onNodeChange={onNode} stepTab={stepTab} onStepTab={onStepTab} />
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
  return (
    <div role="alert" className="mx-auto mt-24 flex max-w-md flex-col items-center gap-3 text-center">
      <h2 className="text-base font-semibold">No pude leer del core</h2>
      <p className="text-muted-foreground">{message}</p>
      <div className="flex gap-2">
        <Button size="sm" onClick={onRetry}>
          Reintentar
        </Button>
        {extra}
      </div>
    </div>
  )
}

function NoProjects({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="mx-auto mt-24 flex max-w-sm flex-col items-center gap-3 text-center">
      <h2 className="text-base font-semibold">Sin proyectos</h2>
      <p className="text-muted-foreground">Un proyecto junta una cola de issues de un tracker con el flujo que las trabaja. Crea el primero para lanzar corridas.</p>
      <Button onClick={onCreate}>
        <Plus /> Crear proyecto
      </Button>
    </div>
  )
}
