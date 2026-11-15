import { Archive, ArchiveRestore, BarChart3, Eye, GitPullRequest, Keyboard, LayoutList, PanelLeft, Plus, RefreshCw, RotateCcw } from "lucide-react"
import type { Loop, PullRequest } from "@/types"
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
import { isRunning, lastSession, useAppActions } from "@/lib/app-context"
import { issueIdOf, loopTone } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { LoopTab } from "./loop/loop-view"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  loops: Loop[]
  current: Loop | null
  onTab: (tab: LoopTab) => void
  onToggleSidebar: () => void
  onOpenShortcuts: () => void
  prs: PullRequest[]
  onGoPrs: () => void
}

// ⌘K: ir a cualquier loop o issue y correr cualquier acción sin tocar el mouse.
export function CommandPalette({ open, onOpenChange, loops, current, onTab, onToggleSidebar, onOpenShortcuts, prs, onGoPrs }: Props) {
  const actions = useAppActions()
  const host = useHost()
  const run = (fn: () => void) => () => {
    onOpenChange(false)
    fn()
  }

  const issues = current
    ? [
        ...current.slots.map((s) => ({ id: s.issueId, title: s.title ?? "", hint: `slot ${s.slot}` })),
        ...(current.queueItems ?? []).map((q) => ({ id: q.id, title: q.title ?? "", hint: "en cola" })),
        ...[...current.history].reverse().map((h) => ({ id: issueIdOf(h.issueId), title: h.title ?? "", hint: h.pr.split(" ")[0] })),
      ].filter((x, i, all) => all.findIndex((y) => y.id === x.id) === i)
    : []

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Paleta de comandos" description="Busca un loop, una issue o una acción">
      <CommandInput placeholder="Busca un loop, una issue o una acción…" />
      <CommandList className="max-h-[420px]">
        <CommandEmpty>Sin resultados.</CommandEmpty>

        {current ? (
          <CommandGroup heading={current.title}>
            {!isRunning(current) && lastSession(current) ? (
              <CommandItem onSelect={run(() => void actions.resume(current))}>
                <RotateCcw /> Reanudar en background
              </CommandItem>
            ) : null}
            {!isRunning(current) ? (
              <CommandItem onSelect={run(() => void actions.watch(current))}>
                <Eye /> Solo vigilar PRs
              </CommandItem>
            ) : null}
            <CommandItem onSelect={run(() => onTab("operacion"))}>
              <LayoutList /> Ver operación
              <CommandShortcut>⇧⌘1</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={run(() => onTab("resumen"))}>
              <BarChart3 /> Ver resumen
              <CommandShortcut>⇧⌘2</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={run(() => actions.setArchived(current, !current.archived))}>
              {current.archived ? <ArchiveRestore /> : <Archive />}
              {current.archived ? "Desarchivar loop" : "Archivar loop"}
            </CommandItem>
          </CommandGroup>
        ) : null}

        <CommandSeparator />
        <CommandGroup heading="Loops">
          {loops.map((l, i) => (
            <CommandItem key={l.slug} value={`loop ${l.title} ${l.slug}`} onSelect={run(() => actions.selectLoop(l.slug))}>
              <span className={cn("ml-0.5 size-2 rounded-full", loopTone[l.status].dot)} />
              <span className="truncate">{l.title}</span>
              <span className="text-xs text-muted-foreground">{l.archived ? "archivado" : loopTone[l.status].label}</span>
              {i < 9 && !l.archived ? <CommandShortcut>⌘{i + 1}</CommandShortcut> : null}
            </CommandItem>
          ))}
        </CommandGroup>

        {issues.length && current ? (
          <>
            <CommandSeparator />
            <CommandGroup heading={`Issues de ${current.title}`}>
              {issues.map((x) => (
                <CommandItem key={x.id} value={`issue ${x.id} ${x.title}`} onSelect={run(() => actions.openIssue(current.slug, x.id))}>
                  <span className="w-[68px] flex-none font-mono text-[11.5px] text-muted-foreground">{x.id}</span>
                  <span className="truncate">{x.title || "sin título"}</span>
                  <span className="ml-auto flex-none font-mono text-[11px] text-muted-foreground">{x.hint}</span>
                </CommandItem>
              ))}
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
          <CommandItem onSelect={run(actions.openNewLoop)}>
            <Plus /> Nuevo loop
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
