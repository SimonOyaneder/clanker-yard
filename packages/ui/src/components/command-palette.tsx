import type { CachedIssue, ClankerProject, Run } from "@clanker/api"
import { GitPullRequest, Keyboard, PanelLeft, Play, Plus, RefreshCw } from "lucide-react"
import type { PullRequest } from "@/types"
import { RunStatusIcon, isLive } from "@/components/project/status"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command"
import { useHost } from "@/host"
import { useAppActions } from "@/lib/app-context"
import { issueKey } from "@/lib/format"
import { barProjects } from "@/lib/projects"
import { cn } from "@/lib/utils"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: ClankerProject[]
  current: ClankerProject | null
  runs: Run[]
  issues: CachedIssue[]
  onToggleSidebar: () => void
  onOpenShortcuts: () => void
  prs: PullRequest[]
  onGoPrs: () => void
}

// ⌘K: ir a cualquier proyecto o corrida y correr cualquier acción sin tocar el mouse.
export function CommandPalette({ open, onOpenChange, projects, current, runs, issues, onToggleSidebar, onOpenShortcuts, prs, onGoPrs }: Props) {
  const actions = useAppActions()
  const host = useHost()
  const run = (fn: () => void) => () => {
    onOpenChange(false)
    fn()
  }

  const byId = new Map<string, CachedIssue>(issues.map((i) => [i.id, i]))
  const live = new Set(runs.filter((r) => isLive(r.status)).map((r) => r.subject.id))
  const runnable = current?.status === "active" ? issues.filter((i) => i.status === "todo" && !live.has(i.id)) : []
  const ordered = [...barProjects(projects), ...projects.filter((p) => p.status === "archived")]

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Paleta de comandos" description="Busca un proyecto, una corrida o una acción">
      <CommandInput placeholder="Busca un proyecto, una corrida o una acción…" />
      <CommandList className="max-h-[420px]">
        <CommandEmpty>Sin resultados.</CommandEmpty>

        {current && runnable.length ? (
          <CommandGroup heading={`Correr en ${current.name}`}>
            {runnable.map((i) => (
              <CommandItem key={i.id} value={`correr ${issueKey(i)} ${i.title}`} onSelect={run(() => void actions.startRun(current, i))}>
                <Play />
                <span className="w-[68px] flex-none truncate font-mono text-[11.5px] text-muted-foreground">{issueKey(i)}</span>
                <span className="truncate">{i.title}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}

        <CommandSeparator />
        <CommandGroup heading="Proyectos">
          {ordered.map((p, i) => (
            <CommandItem key={p.id} value={`proyecto ${p.name} ${p.slug}`} onSelect={run(() => actions.selectProject(p.slug))}>
              <span className={cn("ml-0.5 size-2 rounded-full", p.status === "active" ? "bg-emerald-500" : "bg-muted-foreground/50")} />
              <span className="truncate">{p.name}</span>
              <span className="text-xs text-muted-foreground">{p.status === "active" ? "" : p.status === "paused" ? "pausado" : "archivado"}</span>
              {i < 9 && p.status !== "archived" ? <CommandShortcut>⌘{i + 1}</CommandShortcut> : null}
            </CommandItem>
          ))}
        </CommandGroup>

        {runs.length && current ? (
          <>
            <CommandSeparator />
            <CommandGroup heading={`Corridas de ${current.name}`}>
              {runs.map((r) => {
                const issue = byId.get(r.subject.id)
                return (
                  <CommandItem key={r.id} value={`corrida ${issue ? issueKey(issue) : ""} ${issue?.title ?? ""} ${r.id}`} onSelect={run(() => actions.openRun(current.slug, r.id))}>
                    <RunStatusIcon run={r} />
                    <span className="w-[68px] flex-none truncate font-mono text-[11.5px] text-muted-foreground">{issue ? issueKey(issue) : r.subject.id}</span>
                    <span className="truncate">{issue?.title ?? "issue fuera del caché"}</span>
                    <span className="ml-auto flex-none font-mono text-[11px] text-muted-foreground">
                      {r.flow.slug} v{r.flow.version}
                    </span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </>
        ) : null}

        {prs.length ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="PRs abiertos">
              {prs.map((p) => (
                <CommandItem key={p.id} value={`pr ${p.repoName} ${p.number} ${p.title} ${p.headRef}`} onSelect={run(() => host.openExternal(p.url))}>
                  <GitPullRequest />
                  <span className="w-[92px] flex-none truncate font-mono text-[11.5px] text-muted-foreground">
                    {p.repoName}#{p.number}
                  </span>
                  <span className="truncate">{p.title}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        <CommandSeparator />
        <CommandGroup heading="App">
          <CommandItem onSelect={run(onGoPrs)}>
            <GitPullRequest /> Ir a Stacks de PR
            <CommandShortcut>⇧⌘P</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={run(actions.openNewProject)}>
            <Plus /> Nuevo proyecto
            <CommandShortcut>⌘N</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={run(actions.refresh)}>
            <RefreshCw /> Actualizar
            <CommandShortcut>⌘R</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={run(onToggleSidebar)}>
            <PanelLeft /> Mostrar u ocultar barra lateral
            <CommandShortcut>⌘B</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={run(onOpenShortcuts)}>
            <Keyboard /> Atajos de teclado
            <CommandShortcut>⌘/</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
