import { Archive, ArchiveRestore, ChevronRight, ExternalLink, GitPullRequest, Keyboard, Plus, RefreshCw, RotateCcw, Search, Square } from "lucide-react"
import type { AgentInfo, Loop, PlanUsage } from "@/types"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { isRunning, lastSession, useAppActions } from "@/lib/app-context"
import { ago, loopTone } from "@/lib/format"
import { readPref, writePref } from "@/lib/prefs"
import { cn } from "@/lib/utils"
import { Hint } from "./common"
import { PlanUsageBars } from "./plan-usage"

interface Props {
  loops: Loop[]
  starting: AgentInfo[]
  selected: string | null
  prsActive: boolean
  prsBadge: { count: number; tone: "red" | "green" | "muted" } | null
  onSelectPrs: () => void
  updatedAt: number | null
  error: string | null
  planUsage: PlanUsage | null
  onOpenPalette: () => void
  onOpenShortcuts: () => void
}

function badge(l: Loop): { text: string; className: string } | null {
  if (l.agent?.kind === "background" && l.agent.state === "blocked") return { text: "te espera", className: "text-amber-600 dark:text-amber-400" }
  if (l.status === "activo" && l.slots.length) return { text: String(l.slots.length), className: "text-muted-foreground" }
  return null
}

function LoopItem({ loop, index, active }: { loop: Loop; index: number | null; active: boolean }) {
  const actions = useAppActions()
  const b = badge(loop)
  const bg = loop.agent?.kind === "background" && loop.agent.id
  return (
    <SidebarMenuItem>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <SidebarMenuButton
            isActive={active}
            onClick={() => actions.selectLoop(loop.slug)}
            title={`${loop.title} · ${loopTone[loop.status].label}${index !== null && index < 9 ? ` · ⌘${index + 1}` : ""}`}
            className={cn("h-8", b && "pr-10")}
          >
            <span
              aria-label={loopTone[loop.status].label}
              className={cn("size-2 flex-none rounded-full", loopTone[loop.status].dot, loop.status === "activo" && "cc-blink")}
            />
            <span className="truncate">{loop.title}</span>
          </SidebarMenuButton>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          {!isRunning(loop) && lastSession(loop) ? (
            <ContextMenuItem onSelect={() => void actions.resume(loop)}>
              <RotateCcw /> Reanudar en background
            </ContextMenuItem>
          ) : null}
          {loop.projectUrl ? (
            <ContextMenuItem onSelect={() => actions.openLinear(loop)}>
              <ExternalLink /> Abrir en Linear
            </ContextMenuItem>
          ) : null}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => actions.setArchived(loop, !loop.archived)}>
            {loop.archived ? <ArchiveRestore /> : <Archive />}
            {loop.archived ? "Desarchivar" : "Archivar"}
          </ContextMenuItem>
          {bg ? (
            <ContextMenuItem variant="destructive" onSelect={() => actions.requestStop(loop)}>
              <Square /> Detener EM…
            </ContextMenuItem>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>
      {b ? <SidebarMenuBadge className={cn("text-[11px]", b.className)}>{b.text}</SidebarMenuBadge> : null}
    </SidebarMenuItem>
  )
}

export function AppSidebar({ loops, starting, selected, prsActive, prsBadge, onSelectPrs, updatedAt, error, planUsage, onOpenPalette, onOpenShortcuts }: Props) {
  const actions = useAppActions()
  const inBar = loops.filter((l) => !l.archived || isRunning(l))
  const running = inBar.filter(isRunning)
  const stopped = inBar.filter((l) => !isRunning(l))
  const archived = loops.filter((l) => l.archived && !isRunning(l))
  const indexOf = (slug: string) => inBar.findIndex((l) => l.slug === slug)

  return (
    <Sidebar collapsible="offcanvas" className="border-r-0">
      <SidebarHeader className="drag h-11 flex-row items-center justify-end gap-0.5 px-2 py-0">
        <Hint label="Buscar o ejecutar" keys="⌘K" side="bottom">
          <button type="button" onClick={onOpenPalette} aria-label="Paleta de comandos" className="no-drag grid size-7 place-items-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground">
            <Search className="size-4" />
          </button>
        </Hint>
        <Hint label="Nuevo loop" keys="⌘N" side="bottom">
          <button type="button" onClick={actions.openNewLoop} aria-label="Nuevo loop" className="no-drag grid size-7 place-items-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground">
            <Plus className="size-4" />
          </button>
        </Hint>
      </SidebarHeader>

      <SidebarContent className="gap-0">
        <div className="px-4 pt-1 pb-2 text-[13px] font-semibold">Clanker Control</div>

        <SidebarGroup className="py-1">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={prsActive} onClick={onSelectPrs} title={`Stacks de PR · ⇧⌘P${prsBadge?.count ? ` · ${prsBadge.tone === "red" ? `${prsBadge.count} necesitan acción tuya` : prsBadge.tone === "green" ? `${prsBadge.count} listos para merge` : `${prsBadge.count} abiertos`}` : ""}`} className="h-8 pr-10">
                  <GitPullRequest className="size-4" />
                  <span>Stacks de PR</span>
                </SidebarMenuButton>
                {prsBadge?.count ? (
                  <SidebarMenuBadge
                    className={cn(
                      "text-[11px]",
                      prsBadge.tone === "red" && "text-red-600 dark:text-red-400",
                      prsBadge.tone === "green" && "text-emerald-600 dark:text-emerald-400",
                      prsBadge.tone === "muted" && "text-muted-foreground",
                    )}
                  >
                    {prsBadge.count}
                  </SidebarMenuBadge>
                ) : null}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="py-1">
          <SidebarGroupLabel>Corriendo</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {running.map((l) => (
                <LoopItem key={l.slug} loop={l} index={indexOf(l.slug)} active={!prsActive && l.slug === selected} />
              ))}
              {starting.map((a) => (
                <SidebarMenuItem key={a.sessionId}>
                  <SidebarMenuButton title="Todavía no escribe su state." className="h-8 pr-20">
                    <span className="cc-blink size-2 flex-none rounded-full bg-violet-500" />
                    <span className="truncate">{a.name?.replace(/^clanker ·\s*/, "")}</span>
                  </SidebarMenuButton>
                  <SidebarMenuBadge className="text-[11px] text-muted-foreground">arrancando</SidebarMenuBadge>
                </SidebarMenuItem>
              ))}
              {!running.length && !starting.length ? <p className="px-2 py-1 text-xs text-muted-foreground">Ningún loop corriendo.</p> : null}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {stopped.length ? (
          <SidebarGroup className="py-1">
            <SidebarGroupLabel>Detenidos</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {stopped.map((l) => (
                  <LoopItem key={l.slug} loop={l} index={indexOf(l.slug)} active={!prsActive && l.slug === selected} />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}

        {archived.length ? (
          <Collapsible defaultOpen={readPref("archivedOpen", false)} onOpenChange={(o) => writePref("archivedOpen", o)} className="group/collapsible">
            <SidebarGroup className="py-1">
              <SidebarGroupLabel asChild>
                <CollapsibleTrigger className="w-full">
                  Archivados
                  <span className="ml-1.5 font-normal tabular-nums">{archived.length}</span>
                  <ChevronRight className="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-90" />
                </CollapsibleTrigger>
              </SidebarGroupLabel>
              <CollapsibleContent>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {archived.map((l) => (
                      <LoopItem key={l.slug} loop={l} index={null} active={!prsActive && l.slug === selected} />
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </CollapsibleContent>
            </SidebarGroup>
          </Collapsible>
        ) : null}
      </SidebarContent>

      <SidebarFooter className="gap-2.5 border-t border-sidebar-border px-3 pt-3 pb-2">
        <PlanUsageBars usage={planUsage} />
        <div className="flex items-center justify-between gap-2">
        <Hint label="Actualizar ahora" keys="⌘R" side="top">
          <button type="button" onClick={actions.refresh} className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-xs text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground">
            <span className={cn("size-1.5 flex-none rounded-full", error ? "bg-red-500" : "cc-blink bg-emerald-500")} />
            <span className="truncate">{error ? "error leyendo datos" : updatedAt ? `en vivo · ${ago(new Date(updatedAt).toISOString())}` : "cargando…"}</span>
            <RefreshCw className="size-3 flex-none" />
          </button>
        </Hint>
        <Hint label="Atajos de teclado" keys="⌘/" side="top">
          <button type="button" onClick={onOpenShortcuts} aria-label="Atajos de teclado" className="grid size-7 place-items-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground">
            <Keyboard className="size-4" />
          </button>
        </Hint>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
