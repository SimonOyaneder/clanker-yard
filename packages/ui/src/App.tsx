import { ChevronRight, Search } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast, Toaster } from "sonner"
import type { Loop } from "@/types"
import { type AppData, AppDataProvider, useAppData } from "@/app-data"
import { AppSidebar } from "@/components/app-sidebar"
import { CommandPalette } from "@/components/command-palette"
import { Shortcut } from "@/components/common"
import { IssueView } from "@/components/issue/issue-view"
import { type LoopTab, LoopView } from "@/components/loop/loop-view"
import { NewLoopDialog } from "@/components/new-loop-dialog"
import { PrsView } from "@/components/prs/prs-view"
import { ShortcutsDialog } from "@/components/shortcuts-dialog"
import { StatusBanner } from "@/components/status-banner"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { TooltipProvider } from "@/components/ui/tooltip"
import { type Host, HostProvider, useHost } from "@/host"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { usePoll } from "@/hooks/use-poll"
import { type AppActions, AppActionsContext, isRunning, lastSession } from "@/lib/app-context"
import { useCoreState } from "@/lib/core-status"
import { reportLaunch } from "@/lib/launch"
import { readPref, writePref } from "@/lib/prefs"
import { reviewStatus } from "@/lib/pr-status"
import { cn } from "@/lib/utils"
import { Hint } from "./components/common"

type View = { kind: "loop" } | { kind: "issue"; issueId: string }
type Module = "loops" | "prs"
// Dónde está el usuario: lo que guarda el historial de atrás/adelante.
type Loc = { module: Module; slug: string | null; view: View }

function sameLoc(a: Loc, b: Loc): boolean {
  if (a.module !== b.module) return false
  if (a.module === "prs") return true
  if (a.slug !== b.slug || a.view.kind !== b.view.kind) return false
  return a.view.kind !== "issue" || (b.view.kind === "issue" && a.view.issueId === b.view.issueId)
}

const MAX_HISTORY = 50

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
        <TooltipProvider delayDuration={400} skipDelayDuration={150}>
          <Shell />
          <Toaster theme="system" position="bottom-right" closeButton toastOptions={{ className: "!text-[13px]" }} />
        </TooltipProvider>
      </HostProvider>
    </AppDataProvider>
  )
}

function Shell() {
  const appData = useAppData()
  const host = useHost()
  const { data, error, updatedAt, refresh } = usePoll(() => appData.snapshot(), [])
  const core = useCoreState(host.core)
  // Con el core caído lo que se ve es lo último que llegó: se atenúa y no se opera sobre eso.
  const stale = !!core && core.status !== "live"
  const [slug, setSlug] = useState<string | null>(() => readPref<string | null>("slug", null))
  const [view, setView] = useState<View>({ kind: "loop" })
  const [tab, setTabState] = useState<LoopTab>(() => readPref<LoopTab>("tab", "operacion"))
  const [sidebarOpen, setSidebarOpenState] = useState(() => readPref("sidebar", true))
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [newLoopOpen, setNewLoopOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [stopTarget, setStopTarget] = useState<Loop | null>(null)
  const [module, setModuleState] = useState<Module>(() => readPref<Module>("module", "loops"))

  // PRs de GitHub cada 5 min (la cuota de GraphQL es compartida con gh y el vigilante), y al entrar
  // al módulo o volver a la ventana si los datos tienen más de 1 min. ⌘R fuerza.
  const forcePrs = useRef(false)
  const prs = usePoll(
    () => {
      const force = forcePrs.current
      forcePrs.current = false
      return appData.prs(force)
    },
    [],
    5 * 60_000,
    5 * 60_000,
  )
  const refreshPrsData = prs.refresh
  const refreshPrs = useCallback(() => {
    forcePrs.current = true
    refreshPrsData()
  }, [refreshPrsData])
  const setModule = useCallback((m: Module) => {
    setModuleState(m)
    writePref("module", m)
  }, [])
  const prsUpdatedAt = prs.updatedAt
  const refreshPrsIfStale = useCallback(() => {
    if (!prsUpdatedAt || Date.now() - prsUpdatedAt > 60_000) refreshPrsData()
  }, [prsUpdatedAt, refreshPrsData])
  useEffect(() => {
    if (module === "prs") refreshPrsIfStale()
  }, [module, refreshPrsIfStale])
  useEffect(() => {
    const onFocus = () => {
      if (module === "prs") refreshPrsIfStale()
    }
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [module, refreshPrsIfStale])
  const prsNeedingAction = (prs.data?.prs ?? []).filter((p) => reviewStatus(p) === "changes").length
  const prsReady = (prs.data?.prs ?? []).filter((p) => p.merge.ready).length

  const loops = useMemo(() => data?.loops ?? [], [data])
  const inBar = useMemo(() => loops.filter((l) => !l.archived || isRunning(l)), [loops])
  const loop = loops.find((l) => l.slug === slug) ?? null

  // Si el loop guardado ya no existe, el primero de la barra.
  useEffect(() => {
    const first = inBar[0] ?? loops[0]
    if (data && !loop && first) setSlug(first.slug)
  }, [data, loop, loops, inBar])

  const setTab = useCallback((t: LoopTab) => {
    setTabState(t)
    writePref("tab", t)
  }, [])
  const setSidebarOpen = useCallback((open: boolean) => {
    setSidebarOpenState(open)
    writePref("sidebar", open)
  }, [])

  // Historial como el de un navegador: ⌘[ / ⌘] y los botones de pulgar del mouse.
  const here = useRef<Loc>({ module, slug, view })
  here.current = { module, slug, view }
  const backStack = useRef<Loc[]>([])
  const forwardStack = useRef<Loc[]>([])
  const apply = useCallback(
    (l: Loc) => {
      setModule(l.module)
      setSlug(l.slug)
      if (l.slug) writePref("slug", l.slug)
      setView(l.view)
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
  }, [goBack, goForward])

  const selectLoop = useCallback((s: string) => go({ module: "loops", slug: s, view: { kind: "loop" } }), [go])

  const actions = useMemo<AppActions>(
    () => ({
      selectLoop,
      openIssue: (s, issueId) => go({ module: "loops", slug: s, view: { kind: "issue", issueId } }),
      setArchived: async (l, value) => {
        const r = await appData.setArchived(l.slug, value)
        if (!r.ok) {
          toast.error(r.error)
          return
        }
        if (value && l.slug === slug && !isRunning(l)) {
          const next = inBar.find((x) => x.slug !== l.slug)
          if (next) selectLoop(next.slug)
        }
        toast.success(value ? `Archivé ${l.title}` : `${l.title} vuelve a la barra`, {
          action: value ? { label: "Deshacer", onClick: () => void appData.setArchived(l.slug, false).then(refresh) } : undefined,
        })
        refresh()
      },
      requestStop: (l) => setStopTarget(l),
      resume: (l) => {
        const s = lastSession(l)
        return s ? reportLaunch(appData.resume(l.slug, s.id), "EM reanudado") : Promise.resolve(false)
      },
      run: (l) => reportLaunch(appData.runLoop(l.slug, "run"), "Loop lanzado"),
      watch: (l) => reportLaunch(appData.runLoop(l.slug, "watch"), "Vigilante lanzado"),
      openLinear: (l) => {
        if (l.projectUrl) host.openExternal(l.projectUrl)
      },
      openNewLoop: () => setNewLoopOpen(true),
      refresh,
    }),
    [selectLoop, slug, inBar, refresh, go, appData, host],
  )

  // Menú nativo (accelerators) y clicks en notificaciones.
  useEffect(() => {
    const offMenu = host.onMenu((action) => {
      if (action === "new-loop") setNewLoopOpen(true)
      else if (action === "command") setPaletteOpen((o) => !o)
      else if (action === "refresh") {
        if (module === "prs") refreshPrs()
        else refresh()
        toast("Actualizado", { duration: 1200 })
      } else if (action === "toggle-sidebar") setSidebarOpen(!sidebarOpen)
      else if (action === "back") goBack()
      else if (action === "forward") goForward()
      else if (action === "tab:operacion" || action === "tab:resumen") {
        go({ module: "loops", view: { kind: "loop" } })
        setTab(action === "tab:operacion" ? "operacion" : "resumen")
      } else if (action === "shortcuts") setShortcutsOpen(true)
      else if (action === "go-prs") go({ module: "prs" })
    })
    const offNav = host.onNavigate(({ slug: s, issueId }) => (issueId ? actions.openIssue(s, issueId) : selectLoop(s)))
    return () => {
      offMenu()
      offNav()
    }
  }, [refresh, refreshPrs, module, go, goBack, goForward, setSidebarOpen, sidebarOpen, setTab, selectLoop, actions, host])

  // Esc vuelve desde una issue, salvo que haya un diálogo o menú abierto.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || view.kind !== "issue" || module !== "loops") return
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return
      go({ view: { kind: "loop" } })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [view.kind, module, go])

  const issueTitle =
    view.kind === "issue" && loop
      ? (loop.slots.find((s) => s.issueId === view.issueId)?.title ??
        loop.history.find((h) => h.issueId.startsWith(view.issueId))?.title ??
        loop.queueItems?.find((q) => q.id === view.issueId)?.title ??
        null)
      : null

  return (
    <AppActionsContext.Provider value={actions}>
      <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen} className="h-full min-h-0">
        <AppSidebar
          loops={loops}
          starting={data?.starting ?? []}
          selected={slug}
          prsActive={module === "prs"}
          prsBadge={prs.data ? (prsNeedingAction ? { count: prsNeedingAction, tone: "red" } : prsReady ? { count: prsReady, tone: "green" } : { count: prs.data.prs.length, tone: "muted" }) : null}
          onSelectPrs={() => go({ module: "prs" })}
          updatedAt={updatedAt}
          error={error}
          core={core}
          planUsage={data?.planUsage ?? null}
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
              ) : loop ? (
                view.kind === "issue" ? (
                  <>
                    <button type="button" onClick={() => go({ view: { kind: "loop" } })} className="truncate rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
                      {loop.title}
                    </button>
                    <ChevronRight className="size-3.5 flex-none text-muted-foreground" />
                    <span className="flex-none font-mono text-xs text-muted-foreground">{view.issueId}</span>
                    {issueTitle ? <span className="truncate px-1 font-medium">{issueTitle}</span> : null}
                  </>
                ) : (
                  <span className="truncate px-1.5 font-medium">{loop.title}</span>
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
              <PrsView data={prs.data} error={prs.error} onRefresh={refreshPrs} />
            </main>
          ) : (
          <main className={cn("min-h-0 flex-1 overflow-y-auto transition-opacity", stale && "pointer-events-none opacity-50")}>
            <div className="px-6 pt-5 pb-10">
              {error && !data ? <p className="text-[13px] text-destructive">{error}</p> : null}
              {!data ? (
                <div className="flex flex-col gap-4">
                  <Skeleton className="h-8 w-72" />
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-80 w-full" />
                </div>
              ) : !loops.length ? (
                <div className="mx-auto mt-24 flex max-w-sm flex-col items-center gap-3 text-center">
                  <h2 className="text-base font-semibold">Todavía no hay loops</h2>
                  <p className="text-muted-foreground">Lanza uno con ⌘N o corre /clanker-loop en Claude Code y aparece acá.</p>
                </div>
              ) : loop && view.kind === "issue" ? (
                <IssueView key={`${loop.slug}-${view.issueId}`} slug={loop.slug} issueId={view.issueId} projectUrl={loop.projectUrl} />
              ) : loop ? (
                <LoopView loop={loop} tab={tab} onTabChange={setTab} onOpenIssue={(id) => actions.openIssue(loop.slug, id)} />
              ) : null}
            </div>
          </main>
          )}
        </SidebarInset>
      </SidebarProvider>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        loops={[...inBar, ...loops.filter((l) => !inBar.includes(l))]}
        current={loop}
        onTab={(t) => {
          go({ module: "loops", view: { kind: "loop" } })
          setTab(t)
        }}
        onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        prs={prs.data?.prs ?? []}
        onGoPrs={() => go({ module: "prs" })}
      />
      <NewLoopDialog open={newLoopOpen} onOpenChange={setNewLoopOpen} />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <AlertDialog open={!!stopTarget} onOpenChange={(o) => !o && setStopTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Detener el EM de {stopTarget?.title}?</AlertDialogTitle>
            <AlertDialogDescription>
              Corre <code className="font-mono">claude stop {stopTarget?.agent?.id}</code> y termina su vigilante. Los techleads en curso mueren con él; la
              conversación y el state quedan guardados, y "Reanudar" retoma los slots.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={async () => {
                const id = stopTarget?.agent?.id
                if (!id) return
                const r = await appData.stop(id)
                if (r.ok) toast.success(`Detuve ${id}`)
                else toast.error(r.error)
                refresh()
              }}
            >
              Detener
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppActionsContext.Provider>
  )
}
