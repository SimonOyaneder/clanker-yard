import type { CachedIssue, ClankerProject, RunId, RunStatus } from "@clanker/api"
import { ChevronRight, Plus, Search } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast, Toaster } from "sonner"
import { type AppData, AppDataProvider, useAppData } from "@/app-data"
import { AppSidebar } from "@/components/app-sidebar"
import { CommandPalette } from "@/components/command-palette"
import { Shortcut } from "@/components/common"
import { NewProjectDialog } from "@/components/new-project-dialog"
import { ProjectView, issuesById } from "@/components/project/project-view"
import { RunView, type RunTab } from "@/components/project/run-view"
import { PrsView } from "@/components/prs/prs-view"
import { ShortcutsDialog } from "@/components/shortcuts-dialog"
import { StatusBanner } from "@/components/status-banner"
import { Button } from "@/components/ui/button"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { TooltipProvider } from "@/components/ui/tooltip"
import { LiveProvider, useLive, useLiveQuery } from "@/hooks/use-live"
import { type Host, HostProvider, useHost } from "@/host"
import { type AppActions, AppActionsContext } from "@/lib/app-context"
import { useCoreState } from "@/lib/core-status"
import { issueKey } from "@/lib/format"
import { reviewStatus } from "@/lib/pr-status"
import { readPref, writePref } from "@/lib/prefs"
import { barProjects } from "@/lib/projects"
import { cn } from "@/lib/utils"
import { Hint } from "./components/common"

type Module = "projects" | "prs"
// Dónde está el usuario: lo que guarda el historial de atrás/adelante.
type Loc = { module: Module; slug: string | null; runId: RunId | null }

const sameLoc = (a: Loc, b: Loc) => a.module === b.module && (a.module === "prs" || (a.slug === b.slug && a.runId === b.runId))

const MAX_HISTORY = 50

const LIVE_STATUSES: RunStatus[] = ["queued", "running", "waiting", "parked", "paused"]

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

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
            <Shell />
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

  const [slug, setSlug] = useState<string | null>(() => readPref<string | null>("slug", null))
  const [runId, setRunId] = useState<RunId | null>(null)
  const [module, setModuleState] = useState<Module>(() => (readPref<string>("module", "projects") === "prs" ? "prs" : "projects"))
  const [runTab, setRunTabState] = useState<RunTab>(() => (readPref<string>("runTab", "graph") === "timeline" ? "timeline" : "graph"))
  const [sidebarOpen, setSidebarOpenState] = useState(() => readPref("sidebar", true))
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  // El proyecto guardado puede ya no existir: se cae al primero de la barra.
  const project = projects.find((p) => p.slug === slug) ?? barProjects(projects)[0] ?? projects[0] ?? null
  const projectData = useLiveQuery(project ? `project:${project.id}` : "no-project", async () => {
    if (!project) return null
    const [runs, issues] = await Promise.all([appData.runs({ projectId: project.id }), appData.issues(project.id)])
    return { runs, issues }
  })

  const forcePrs = useRef(false)
  const prs = useLiveQuery(
    "prs",
    () => {
      const force = forcePrs.current
      forcePrs.current = false
      return appData.prs(force)
    },
    { live: false },
  )
  const reloadPrs = prs.reload
  useEffect(() => {
    if (module === "prs") reloadPrs()
  }, [module, reloadPrs])
  const prsNeedingAction = (prs.data?.prs ?? []).filter((p) => reviewStatus(p) === "changes").length
  const prsReady = (prs.data?.prs ?? []).filter((p) => p.merge.ready).length

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
  const here = useRef<Loc>({ module, slug, runId })
  here.current = { module, slug, runId }
  const backStack = useRef<Loc[]>([])
  const forwardStack = useRef<Loc[]>([])
  const apply = useCallback(
    (l: Loc) => {
      setModule(l.module)
      setSlug(l.slug)
      if (l.slug) writePref("slug", l.slug)
      setRunId(l.runId)
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

  const refresh = useCallback(() => {
    if (module === "prs") {
      forcePrs.current = true
      reloadPrs()
    } else {
      live.refresh()
    }
  }, [module, reloadPrs, live])

  const actions = useMemo<AppActions>(
    () => ({
      selectProject,
      openRun: (s, id) => go({ module: "projects", slug: s, runId: id }),
      openNewProject: () => setNewProjectOpen(true),
      startRun: async (p: ClankerProject, issue: CachedIssue) => {
        try {
          const started = await appData.startRun({ projectId: p.id, issueId: issue.id })
          toast.success(`Corrida lanzada para ${issueKey(issue)}`, { action: { label: "Ver", onClick: () => go({ module: "projects", slug: p.slug, runId: started.id }) } })
        } catch (e) {
          toast.error(messageOf(e))
        }
      },
      refresh,
    }),
    [selectProject, go, appData, refresh],
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
    })
    // Una notificación abre el proyecto; llevarla hasta la corrida es de cuando haya notificaciones de corridas.
    const offNav = host.onNavigate(({ slug: s }) => selectProject(s))
    return () => {
      offMenu()
      offNav()
    }
  }, [refresh, go, goBack, goForward, setSidebarOpen, sidebarOpen, selectProject, host])

  // Esc vuelve de una corrida al proyecto, salvo que haya un diálogo o menú abierto.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !runId || module !== "projects") return
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return
      go({ runId: null })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [runId, module, go])

  // G y L cambian entre el grafo y la línea de tiempo de la corrida abierta, como las teclas de Linear.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!runId || module !== "projects" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      const tab = e.key === "g" ? "graph" : e.key === "l" ? "timeline" : null
      if (!tab || (e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable='true']")) return
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return
      setRunTab(tab)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [runId, module, setRunTab])

  const detail = projectData.data
  const openRun = runId && detail ? detail.runs.find((r) => r.id === runId) : undefined
  const openRunIssue = openRun && detail ? issuesById(detail.issues).get(openRun.subject.id) : undefined

  return (
    <AppActionsContext.Provider value={actions}>
      <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen} className="h-full min-h-0">
        <AppSidebar
          projects={projects}
          liveRuns={liveRunsQuery.data ?? []}
          selected={project?.slug ?? null}
          prsActive={module === "prs"}
          prsBadge={prs.data ? (prsNeedingAction ? { count: prsNeedingAction, tone: "red" } : prsReady ? { count: prsReady, tone: "green" } : { count: prs.data.prs.length, tone: "muted" }) : null}
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
              {module === "prs" ? (
                <span className="truncate px-1.5 font-medium">Stacks de PR</span>
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

          {module === "prs" ? (
            <main className={cn("min-h-0 flex-1 overflow-hidden transition-opacity", stale && "pointer-events-none opacity-50")}>
              <PrsView data={prs.data ?? null} error={prs.error} onRefresh={refresh} />
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
                ) : !detail ? (
                  projectData.error ? (
                    <Problem message={projectData.error} onRetry={projectData.reload} />
                  ) : (
                    <Loading />
                  )
                ) : runId ? (
                  <RunPane key={runId} runId={runId} issue={openRunIssue} tab={runTab} onTab={setRunTab} onBack={() => go({ runId: null })} />
                ) : (
                  <ProjectView project={project} runs={detail.runs} issues={detail.issues} />
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
        onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        prs={prs.data?.prs ?? []}
        onGoPrs={() => go({ module: "prs" })}
        onRunTab={runId && module === "projects" ? setRunTab : null}
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
    </AppActionsContext.Provider>
  )
}

function RunPane({ runId, issue, tab, onTab, onBack }: { runId: RunId; issue: CachedIssue | undefined; tab: RunTab; onTab: (tab: RunTab) => void; onBack: () => void }) {
  const appData = useAppData()
  const run = useLiveQuery(`run:${runId}`, () => appData.run(runId))
  if (run.data) return <RunView run={run.data} issue={issue} tab={tab} onTabChange={onTab} />
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
