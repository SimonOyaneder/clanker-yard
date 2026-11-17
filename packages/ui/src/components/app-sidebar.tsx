import type { ClankerProject, Run } from "@clanker/api"
import { BookCheck, ChevronRight, Copy, GitPullRequest, Inbox, Keyboard, Plug, Plus, RefreshCw, Search, Settings, Workflow } from "lucide-react"
import { PlanUsage } from "@/components/connections/plan-usage"
import { SetupProgress } from "@/components/setup-checklist"
import type { ClaudePlan } from "@/hooks/use-claude-plan"
import type { CoreState } from "@/host"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu"
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
import { type Module, useAppActions } from "@/lib/app-context"
import { copy } from "@/lib/clipboard"
import { footerStatus, type FooterTone } from "@/lib/core-status"
import { readPref, writePref } from "@/lib/prefs"
import { barProjects } from "@/lib/projects"
import type { SetupStep, SetupStepId } from "@/lib/setup"
import { cn } from "@/lib/utils"
import { Hint } from "./common"

interface Props {
  projects: ClankerProject[]
  /** El módulo a la vista: su ítem queda marcado (en `projects`, el proyecto elegido). */
  module: Module
  /** Decisiones pendientes; ámbar si alguna estaciona su corrida. */
  inboxBadge: { count: number; parks: boolean } | null
  /** Learnings por revisar: sin número cuando no queda ninguno. */
  learningsBadge: number
  /** Las corridas vivas de todos los proyectos (cualquier estado menos terminadas). */
  liveRuns: Run[]
  selected: string | null
  /** Algo está vencido o caído: enciende el punto rojo de Conexiones. */
  connectionsAlert: boolean
  plan: ClaudePlan
  /** La configuración inicial; `null` mientras no llegan las conexiones, los repos y los proyectos. */
  setup: { steps: SetupStep[]; onStep: (id: SetupStepId) => void } | null
  prsBadge: { count: number; tone: "red" | "green" | "muted" } | null
  connected: boolean
  error: string | null
  core: CoreState | undefined
}

function badge(live: Run[]): { text: string; className: string; title: string } | null {
  const parked = live.filter((r) => r.status === "parked").length
  if (parked) return { text: "te espera", className: "text-amber-600 dark:text-amber-400", title: `${parked} corrida${parked === 1 ? "" : "s"} estacionada${parked === 1 ? "" : "s"} esperando una decisión` }
  const active = live.length
  return active ? { text: String(active), className: "text-muted-foreground", title: `${active} corrida${active === 1 ? "" : "s"} en curso` } : null
}

function ProjectItem({ project, live, index, active }: { project: ClankerProject; live: Run[]; index: number | null; active: boolean }) {
  const actions = useAppActions()
  const b = badge(live)
  const working = live.some((r) => r.status === "running")
  return (
    <SidebarMenuItem>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <SidebarMenuButton
            isActive={active}
            onClick={() => actions.selectProject(project.slug)}
            title={`${project.name}${index !== null && index < 9 ? ` · ⌘${index + 1}` : ""}${b ? ` · ${b.title}` : ""}`}
            className={cn("h-8", b && "pr-16")}
          >
            <span className={cn("size-2 flex-none rounded-full", working ? "animate-blink bg-emerald-500" : project.status === "active" ? "bg-emerald-500" : "bg-muted-foreground/50")} />
            <span className="truncate">{project.name}</span>
          </SidebarMenuButton>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuItem onSelect={() => copy(project.slug, "el slug del proyecto")}>
            <Copy /> Copiar slug
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => copy(project.id, "el ID del proyecto")}>
            <Copy /> Copiar ID
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {b ? <SidebarMenuBadge className={cn("text-[11px]", b.className)}>{b.text}</SidebarMenuBadge> : null}
    </SidebarMenuItem>
  )
}

const DOT: Record<FooterTone, string> = {
  live: "animate-blink bg-emerald-500",
  pending: "bg-muted-foreground",
  down: "bg-destructive",
  error: "bg-destructive",
}

export function AppSidebar({ projects, module, inboxBadge, learningsBadge, liveRuns, selected, connectionsAlert, plan, setup, prsBadge, connected, error, core }: Props) {
  const actions = useAppActions()
  const go = (to: Module) => () => actions.goModule(to)
  const status = footerStatus(core, { error, connected })
  const inBar = barProjects(projects)
  const indexOf = (slug: string) => inBar.findIndex((p) => p.slug === slug)
  const liveOf = (p: ClankerProject) => liveRuns.filter((r) => r.projectId === p.id)
  const group = (s: ClankerProject["status"]) => projects.filter((p) => p.status === s)
  const active = group("active")
  const paused = group("paused")
  const archived = group("archived")

  const item = (p: ClankerProject, index: number | null) => (
    <ProjectItem key={p.id} project={p} live={liveOf(p)} index={index} active={module === "projects" && p.slug === selected} />
  )

  return (
    <Sidebar collapsible="offcanvas" className="border-r-0">
      <SidebarHeader className="drag h-11 flex-row items-center justify-end gap-0.5 px-2 py-0">
        <Hint label="Buscar o ejecutar" keys="⌘K" side="bottom">
          <button type="button" onClick={actions.openPalette} aria-label="Paleta de comandos" className="no-drag grid size-7 place-items-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground">
            <Search className="size-4" />
          </button>
        </Hint>
        <Hint label="Nuevo proyecto" keys="⌘N" side="bottom">
          <button type="button" onClick={actions.openNewProject} aria-label="Nuevo proyecto" className="no-drag grid size-7 place-items-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground">
            <Plus className="size-4" />
          </button>
        </Hint>
      </SidebarHeader>

      <SidebarContent className="gap-0">
        <div className="px-4 pt-1 pb-2 text-[13px] font-semibold">Clanker Yard</div>

        <SidebarGroup className="py-1">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={module === "inbox"}
                  onClick={go("inbox")}
                  title={`Bandeja · ⇧⌘I · G luego I${inboxBadge ? ` · ${inboxBadge.count === 1 ? "1 decisión pendiente" : `${inboxBadge.count} decisiones pendientes`}${inboxBadge.parks ? ", alguna estaciona su corrida" : ""}` : " · nada pendiente"}`}
                  className="h-8 pr-10"
                >
                  <Inbox className="size-4" />
                  <span>Bandeja</span>
                </SidebarMenuButton>
                {inboxBadge ? (
                  <SidebarMenuBadge className={cn("text-[11px]", inboxBadge.parks ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>{inboxBadge.count}</SidebarMenuBadge>
                ) : null}
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={module === "learnings"}
                  onClick={go("learnings")}
                  title={`Learnings · ⇧⌘A · G luego A${learningsBadge ? ` · ${learningsBadge === 1 ? "1 por revisar" : `${learningsBadge} por revisar`}` : " · nada por revisar"}`}
                  className="h-8 pr-10"
                >
                  <BookCheck className="size-4" />
                  <span>Learnings</span>
                </SidebarMenuButton>
                {learningsBadge ? <SidebarMenuBadge className="text-[11px] text-muted-foreground">{learningsBadge}</SidebarMenuBadge> : null}
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={module === "prs"} onClick={go("prs")} title={`Stacks de PR · ⇧⌘P${prsBadge?.count ? ` · ${prsBadge.tone === "red" ? `${prsBadge.count} necesitan acción tuya` : prsBadge.tone === "green" ? `${prsBadge.count} listos para merge` : `${prsBadge.count} abiertos`}` : ""}`} className="h-8 pr-10">
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
          <SidebarGroupLabel>Proyectos</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {active.map((p) => item(p, indexOf(p.slug)))}
              {!active.length ? (
                <div className="flex flex-col items-start gap-1.5 px-2 py-1">
                  <p className="text-xs text-muted-foreground">{projects.length ? "Ningún proyecto activo." : "Sin proyectos."}</p>
                  <button type="button" onClick={actions.openNewProject} className="text-xs font-medium text-primary hover:underline">
                    Crear proyecto
                  </button>
                </div>
              ) : null}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {paused.length ? (
          <SidebarGroup className="py-1">
            <SidebarGroupLabel>Pausados</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>{paused.map((p) => item(p, indexOf(p.slug)))}</SidebarMenu>
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
                  <SidebarMenu>{archived.map((p) => item(p, null))}</SidebarMenu>
                </SidebarGroupContent>
              </CollapsibleContent>
            </SidebarGroup>
          </Collapsible>
        ) : null}

        <SidebarGroup className="py-1">
          <SidebarGroupLabel>Configurar</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={module === "connections"} onClick={go("connections")} title={`Conexiones · G luego C${connectionsAlert ? " · algo está vencido o caído" : ""}`} className="h-8 pr-8">
                  <Plug className="size-4" />
                  <span>Conexiones</span>
                </SidebarMenuButton>
                {connectionsAlert ? (
                  <SidebarMenuBadge aria-label="Algo está vencido o caído">
                    <span className="size-2 rounded-full bg-destructive" />
                  </SidebarMenuBadge>
                ) : null}
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={module === "flows"} onClick={go("flows")} title="Flujos, roles y perfiles" className="h-8">
                  <Workflow className="size-4" />
                  <span>Flujos</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={module === "settings"} onClick={go("settings")} title="Carriles, packs y defaults de proyectos nuevos" className="h-8">
                  <Settings className="size-4" />
                  <span>Ajustes</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="gap-2.5 border-t border-sidebar-border px-3 pt-3 pb-2">
        {setup ? <SetupProgress steps={setup.steps} onStep={setup.onStep} /> : null}
        <PlanUsage plan={plan} />
        <div className="flex items-center justify-between gap-2">
          <Hint label="Actualizar ahora" keys="⌘R" side="top">
            <button type="button" onClick={actions.refresh} className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-xs text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground">
              <span className={cn("size-1.5 flex-none rounded-full", DOT[status.tone])} />
              <span className="truncate">{status.text}</span>
              <RefreshCw className="size-3 flex-none" />
            </button>
          </Hint>
          <Hint label="Atajos de teclado" keys="⌘/" side="top">
            <button type="button" onClick={actions.openShortcuts} aria-label="Atajos de teclado" className="grid size-7 place-items-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground">
              <Keyboard className="size-4" />
            </button>
          </Hint>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
