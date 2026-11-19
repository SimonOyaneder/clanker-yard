import type { Decision, Repo } from "@clanker/api"
import { ChevronDown, LayoutList, Network, RefreshCw, Repeat2, Search } from "lucide-react"
import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { absolute, ago } from "@/lib/format"
import { readPref, writePref } from "@/lib/prefs"
import { mergeMark, reviewStatus, reviewTone } from "@/lib/prs/pr-status"
import { baseOf, branchOf, isDraft, type OpenPr, repoNameOf, titleOf } from "@/lib/prs/prs"
import { groupByProject, projectByPr, type PrProject } from "@/lib/prs/by-project"
import { buildStackForest, listStackGroups, type StackGroup } from "@/lib/prs/stack"
import { cn } from "@/lib/utils"
import { Ago, Hint, Pill } from "../common"
import { ChatProposalChip, CiBadge, CombinedBaseChip, LocalChip, MergePill, PrStateIcon, Reviewer, ReviewPill, ReviewSignals, SIGNAL_TONE, Signals } from "./pr-bits"
import { OPEN_HINT, usePrCommands } from "./pr-commands"
import { PrContextMenu, usePrShortcuts } from "./pr-menu"
import { PrNotes, PrNotesContext } from "./pr-notes"
import { StackGraph } from "./stack-graph"

type Filter = "all" | "stacked" | "solo" | "draft" | "ready" | "mergeable" | "hold" | "approved" | "pending" | "changes" | "owned"
type Mode = "graph" | "list"

const FILTERS: { key: Filter; label: string; match: (pr: OpenPr, stacked: Set<string>) => boolean }[] = [
  { key: "all", label: "Todos", match: () => true },
  { key: "stacked", label: "En stack", match: (p, s) => s.has(p.id) },
  { key: "solo", label: "Sueltos", match: (p, s) => !s.has(p.id) },
  { key: "draft", label: "Draft", match: (p) => isDraft(p) },
  { key: "ready", label: "Listos para review", match: (p) => p.state !== null && !isDraft(p) },
  { key: "mergeable", label: "Listos para merge", match: (p) => p.state !== null && p.state.merge.ready && !p.state.hold },
  { key: "hold", label: "En hold", match: (p) => p.state?.hold === true },
  { key: "changes", label: "Necesita acción", match: (p) => reviewStatus(p) === "changes" },
  { key: "pending", label: "Esperando review", match: (p) => reviewStatus(p) === "pending" },
  { key: "approved", label: "Aprobados", match: (p) => reviewStatus(p) === "approved" },
  { key: "owned", label: "Del sistema", match: (p) => p.owned },
]

/** Un nivel de una señal de algún pack, para filtrar por él: `risk:high`. */
interface SignalFilter {
  key: string
  id: string
  level: string
  label: string
  tone: "ok" | "warn" | "bad"
}

/** Los niveles de todas las señales que definen los packs de los PRs, en el orden en que el pack los declara. */
function signalFilters(prs: readonly OpenPr[]): SignalFilter[] {
  const found = new Map<string, SignalFilter>()
  for (const pr of prs) {
    if (pr.local) continue
    for (const signal of pr.signals) {
      for (const [level, def] of Object.entries(signal.levels)) {
        const key = `${signal.id}:${level}`
        if (!found.has(key)) found.set(key, { key, id: signal.id, level, label: def.label, tone: def.tone })
      }
    }
  }
  return [...found.values()]
}

interface Props {
  /** Los PRs abiertos del caché con su estado leído. */
  prs: OpenPr[]
  /** Los que el core conoce pero Watch todavía no leyó. */
  unread: number
  /** La clave de la issue que originó cada PR del sistema (`CachedPr.issueId`). */
  issueKeys: ReadonlyMap<string, string>
  /** El proyecto de cada issue (por `issueId`): la lista agrupa los PRs por el proyecto de la issue que los originó. */
  issueProjects?: ReadonlyMap<string, PrProject>
  loaded: boolean
  error: string | null
  /** Los repos registrados: Watch solo descubre PRs en ellos. */
  registered: readonly Repo[]
  /** Las notas de los agentes: cada PR muestra cuántas son suyas. */
  notes?: readonly Decision[]
  onOpenConnections: () => void
  onRefresh: () => void
}

const NO_NOTES: readonly Decision[] = []
const NO_PROJECTS: ReadonlyMap<string, PrProject> = new Map()
/** La clave de los PRs sin proyecto en el filtro de proyectos (los ids de proyecto son `prj_...`). */
const NO_PROJECT = "sin-proyecto"

export function PrsView({ prs, unread, issueKeys, issueProjects = NO_PROJECTS, loaded, error, registered, notes = NO_NOTES, onOpenConnections, onRefresh }: Props) {
  const [filter, setFilterState] = useState<Filter>(() => readPref<Filter>("prs.filter", "all"))
  const [mode, setModeState] = useState<Mode>(() => readPref<Mode>("prs.mode", "graph"))
  const [hiddenRepos, setHiddenRepos] = useState<string[]>(() => readPref<string[]>("prs.hiddenRepos", []))
  const [hiddenProjects, setHiddenProjects] = useState<string[]>(() => readPref<string[]>("prs.hiddenProjects", []))
  const [query, setQuery] = useState("")
  const [signal, setSignalState] = useState<string>(() => readPref<string>("prs.signal", "all"))
  const setSignal = (key: string) => {
    const next = signal === key ? "all" : key
    setSignalState(next)
    writePref("prs.signal", next)
  }

  const setFilter = (f: Filter) => {
    const next = filter === f ? "all" : f
    setFilterState(next)
    writePref("prs.filter", next)
  }
  const setMode = (m: Mode) => {
    setModeState(m)
    writePref("prs.mode", m)
  }
  const setRepos = (next: string[]) => {
    setHiddenRepos(next)
    writePref("prs.hiddenRepos", next)
  }
  const setProjects = (next: string[]) => {
    setHiddenProjects(next)
    writePref("prs.hiddenProjects", next)
  }

  const repos = useMemo(() => [...new Set(prs.map((p) => p.repo))].sort().map((r) => ({ key: r, label: r.split("/")[1] ?? r })), [prs])
  const byRepo = useMemo(() => prs.filter((p) => !hiddenRepos.includes(p.repo)), [prs, hiddenRepos])
  // El proyecto se calcula sobre todos los PRs, no solo los de los repos visibles: un repo oculto no cambia el proyecto de un stack.
  const prProject = useMemo(() => {
    const all = buildStackForest(prs)
    return projectByPr(listStackGroups(all), all.byId, issueProjects)
  }, [prs, issueProjects])
  const projects = useMemo(() => {
    const found = new Map<string, string>()
    for (const p of prs) {
      const project = prProject.get(p.id) ?? null
      found.set(project?.id ?? NO_PROJECT, project?.name ?? "Sin proyecto")
    }
    return [...found.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => (a.key === NO_PROJECT ? 1 : b.key === NO_PROJECT ? -1 : a.label.localeCompare(b.label)))
  }, [prs, prProject])
  const scoped = useMemo(() => byRepo.filter((p) => !hiddenProjects.includes(prProject.get(p.id)?.id ?? NO_PROJECT)), [byRepo, hiddenProjects, prProject])
  const signals = useMemo(() => signalFilters(prs), [prs])
  const forest = useMemo(() => buildStackForest(scoped), [scoped])
  const groups = useMemo(() => listStackGroups(forest), [forest])
  const stacked = useMemo(() => new Set(groups.filter((g) => g.prIds.length > 1).flatMap((g) => g.prIds)), [groups])

  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.key, scoped.filter((p) => f.match(p, stacked)).length])), [scoped, stacked])
  const signalCounts = useMemo(() => Object.fromEntries(signals.map((s) => [s.key, scoped.filter((p) => p.state?.signals[s.id] === s.level).length])), [scoped, signals])
  const picked = signals.find((s) => s.key === signal)
  const readAt = useMemo(() => prs.reduce<number | null>((latest, p) => (p.readAt !== null && (latest === null || p.readAt > latest) ? p.readAt : latest), null), [prs])

  // Un PR que calza trae su stack completo; el resto del stack queda atenuado.
  const { visible, dimmed, visibleGroups } = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matcher = FILTERS.find((f) => f.key === filter)!.match
    const matches = new Set(
      scoped
        .filter((p) => matcher(p, stacked))
        .filter((p) => !picked || p.state?.signals[picked.id] === picked.level)
        .filter((p) => !q || `${p.id} ${p.ref ? `#${p.ref.number}` : ""} ${titleOf(p)} ${branchOf(p)} ${repoNameOf(p)} ${p.issueId === null ? "" : `${issueKeys.get(p.issueId) ?? ""} ${issueProjects.get(p.issueId)?.name ?? ""}`}`.toLowerCase().includes(q))
        .map((p) => p.id),
    )
    const vg = groups.filter((g) => g.prIds.some((id) => matches.has(id)))
    const ids = new Set(vg.flatMap((g) => g.prIds))
    return {
      visible: scoped.filter((p) => ids.has(p.id)),
      dimmed: new Set([...ids].filter((id) => !matches.has(id))),
      visibleGroups: vg,
    }
  }, [scoped, stacked, groups, filter, query, picked, issueKeys, issueProjects])

  usePrShortcuts()

  if (!loaded) {
    return (
      <div className="flex flex-col gap-4 px-6 pt-5">
        {error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13px]">
            <p className="font-medium">No pude leer los PRs del core</p>
            <p className="mt-1 text-muted-foreground">{error}</p>
          </div>
        ) : (
          <>
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-[480px] w-full" />
          </>
        )}
      </div>
    )
  }

  return (
    <PrNotesContext.Provider value={notes}>
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-col gap-3 border-b px-6 pt-5 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">Stacks de PR</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {prs.length} PRs abiertos · {groups.filter((g) => g.prIds.length > 1).length} stacks
              {readAt ? (
                <>
                  {" "}
                  · actualizado <Ago at={readAt} />
                </>
              ) : null}
              {unread ? <span> · {unread === 1 ? "1 PR todavía sin leer" : `${unread} PRs todavía sin leer`}</span> : null}
              {error ? <span className="text-destructive"> · último intento falló: {error}</span> : null}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
              <TabsList className="h-8">
                <TabsTrigger value="graph" className="gap-1.5 px-2.5 text-xs">
                  <Network /> Grafo
                </TabsTrigger>
                <TabsTrigger value="list" className="gap-1.5 px-2.5 text-xs">
                  <LayoutList /> Lista
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Hint label="Actualizar desde GitHub" keys="⌘R">
              <Button size="icon" variant="ghost" className="size-8" aria-label="Actualizar" onClick={onRefresh}>
                <RefreshCw />
              </Button>
            </Hint>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
              disabled={f.key !== "all" && !counts[f.key]}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors disabled:opacity-40",
                filter === f.key ? "border-primary/50 bg-primary/10 text-foreground" : "bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
                "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
              )}
            >
              {f.key === "changes" || f.key === "pending" || f.key === "approved" ? (
                <span className={cn("size-1.5 rounded-full", reviewTone[f.key].dot)} />
              ) : f.key === "mergeable" ? (
                <span className="size-1.5 rounded-full bg-emerald-500 ring-2 ring-emerald-500/30" />
              ) : f.key === "hold" ? (
                <span className="size-1.5 rounded-full bg-amber-500 ring-2 ring-amber-500/30" />
              ) : f.key === "owned" ? (
                <Repeat2 className="size-3" />
              ) : null}
              {f.label}
              <span className="tabular-nums opacity-70">{counts[f.key]}</span>
            </button>
          ))}
          {signals.length ? (
            <div role="group" aria-label="Señales" className="ml-2 flex items-center gap-1 border-l pl-3">
              {signals.map((sig) => {
                const t = SIGNAL_TONE[sig.tone]
                return (
                  <button
                    key={sig.key}
                    type="button"
                    aria-pressed={signal === sig.key}
                    onClick={() => setSignal(sig.key)}
                    disabled={!signalCounts[sig.key]}
                    className={cn(
                      "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors disabled:opacity-40",
                      signal === sig.key ? cn("border-transparent", t.className) : "bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
                      "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                    )}
                  >
                    <t.Icon className="size-3" />
                    {sig.label}
                    <span className="tabular-nums opacity-70">{signalCounts[sig.key]}</span>
                  </button>
                )
              })}
            </div>
          ) : null}
          <div className="ml-auto flex items-center gap-1.5">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filtrar por título, #, branch…" className="h-7 w-56 pl-7 text-xs" />
            </div>
            {projects.length > 1 ? <VisibilityMenu name="Proyectos" title="Proyectos visibles" options={projects} hidden={hiddenProjects} onChange={setProjects} /> : null}
            {repos.length > 1 ? <VisibilityMenu name="Repos" title="Repos visibles" options={repos} hidden={hiddenRepos} onChange={setRepos} /> : null}
          </div>
        </div>
      </header>

      {!visible.length ? (
        <div className="m-6 rounded-lg border border-dashed px-4 py-8 text-center text-[13px] text-muted-foreground">
          {prs.length ? "Ningún PR calza con este filtro." : unread ? "Watch todavía está leyendo tus PRs: aparecen acá apenas termine." : <NoPrs repos={registered} onOpenConnections={onOpenConnections} />}
        </div>
      ) : mode === "graph" ? (
        <div className="min-h-0 flex-1">
          <StackGraph prs={visible} dimmed={dimmed} issueKeys={issueKeys} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          <PrList groups={visibleGroups} forest={forest} dimmed={dimmed} issueKeys={issueKeys} issueProjects={issueProjects} hasSignals={signals.length > 0} />
        </div>
      )}
    </div>
    </PrNotesContext.Provider>
  )
}

/** Un menú de casillas para ocultar opciones de la lista; el botón dice cuántas quedan visibles. */
function VisibilityMenu({ name, title, options, hidden, onChange }: { name: string; title: string; options: readonly { key: string; label: string }[]; hidden: readonly string[]; onChange: (hidden: string[]) => void }) {
  const hiddenCount = options.filter((o) => hidden.includes(o.key)).length
  const toggle = (key: string) => onChange(hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key])
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className="h-7 text-xs">
          {name} {hiddenCount ? `${options.length - hiddenCount}/${options.length}` : ""} <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>{title}</DropdownMenuLabel>
        {options.map((o) => (
          <DropdownMenuCheckboxItem key={o.key} checked={!hidden.includes(o.key)} onCheckedChange={() => toggle(o.key)} onSelect={(e) => e.preventDefault()}>
            {o.label}
          </DropdownMenuCheckboxItem>
        ))}
        {hidden.length ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onChange([])}>Mostrar todos</DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Section({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border bg-card">
      <div className="flex h-8 items-center gap-2 border-b bg-muted/40 px-3 text-xs">
        <span className="font-medium">{title}</span>
        <span className="text-muted-foreground">{sub}</span>
      </div>
      <ul>{children}</ul>
    </section>
  )
}

// Con PRs de más de un proyecto, cada proyecto lleva su encabezado y debajo sus stacks y PRs sueltos.
function PrList({
  groups,
  forest,
  dimmed,
  issueKeys,
  issueProjects,
  hasSignals,
}: {
  groups: StackGroup[]
  forest: ReturnType<typeof buildStackForest>
  dimmed: Set<string>
  issueKeys: ReadonlyMap<string, string>
  issueProjects: ReadonlyMap<string, PrProject>
  hasSignals: boolean
}) {
  const byProject = groupByProject(groups, forest.byId, issueProjects)
  if (byProject.length < 2) return <StackSections groups={groups} forest={forest} dimmed={dimmed} issueKeys={issueKeys} hasSignals={hasSignals} />
  return (
    <div className="flex flex-col gap-6">
      {byProject.map(({ project, groups: projectGroups, prCount }) => (
        <section key={project?.id ?? "sin-proyecto"} aria-label={project?.name ?? "Sin proyecto"} className="flex flex-col gap-2">
          <h2 className="flex items-baseline gap-2 text-[13px]">
            <span className="font-semibold">{project?.name ?? "Sin proyecto"}</span>
            <span className="text-xs text-muted-foreground">{prCount === 1 ? "1 PR" : `${prCount} PRs`}</span>
          </h2>
          <StackSections groups={projectGroups} forest={forest} dimmed={dimmed} issueKeys={issueKeys} hasSignals={hasSignals} />
        </section>
      ))}
    </div>
  )
}

// Stacks primero, cada uno con su sección; los PRs sueltos van juntos por repo.
function StackSections({
  groups,
  forest,
  dimmed,
  issueKeys,
  hasSignals,
}: {
  groups: StackGroup[]
  forest: ReturnType<typeof buildStackForest>
  dimmed: Set<string>
  issueKeys: ReadonlyMap<string, string>
  hasSignals: boolean
}) {
  const { byId, childrenOf, combined } = forest
  const stacks = groups.filter((g) => g.prIds.length > 1)
  const solosByRepo = new Map<string, OpenPr[]>()
  for (const g of groups.filter((g) => g.prIds.length === 1)) {
    const pr = byId.get(g.rootId)!
    solosByRepo.set(repoNameOf(pr), [...(solosByRepo.get(repoNameOf(pr)) ?? []), pr])
  }
  const row = (pr: OpenPr, depth: number) => (
    <PrRow key={pr.id} pr={pr} depth={depth} dimmed={dimmed.has(pr.id)} issueKey={pr.issueId === null ? undefined : issueKeys.get(pr.issueId)} combined={combined.get(pr.id)} hasSignals={hasSignals} />
  )
  return (
    <div className="flex flex-col gap-3">
      {stacks.map((g) => {
        // Orden en profundidad para dibujar el árbol con sangría; un PR con varios padres se dibuja una sola vez.
        const rows: { id: string; depth: number }[] = []
        const seen = new Set<string>()
        const walk = (id: string, depth: number) => {
          if (seen.has(id)) return
          seen.add(id)
          rows.push({ id, depth })
          for (const c of childrenOf.get(id) ?? []) walk(c, depth + 1)
        }
        for (const rootId of g.rootIds) walk(rootId, 0)
        const root = byId.get(g.rootId)!
        return (
          <Section key={g.rootId} title={repoNameOf(root)} sub={`stack de ${g.prIds.length} PRs sobre ${baseOf(root)}`}>
            {rows.map(({ id, depth }) => row(byId.get(id)!, depth))}
          </Section>
        )
      })}
      {[...solosByRepo.entries()].map(([repo, list]) => (
        <Section key={`solos-${repo}`} title={repo} sub={list.length === 1 ? "1 PR suelto" : `${list.length} PRs sueltos`}>
          {[...list].sort((a, b) => (b.state?.updatedAt ?? "").localeCompare(a.state?.updatedAt ?? "")).map((pr) => row(pr, 0))}
        </Section>
      ))}
    </div>
  )
}

function PrRow({ pr, depth, dimmed, issueKey, combined, hasSignals }: { pr: OpenPr; depth: number; dimmed: boolean; issueKey: string | undefined; combined: string[] | undefined; hasSignals: boolean }) {
  const commands = usePrCommands()
  const review = reviewStatus(pr)
  const mark = mergeMark(pr)
  const selected = commands.selected?.id === pr.id
  return (
    <li
      className={cn(
        "border-t first:border-t-0",
        dimmed && "opacity-50",
        mark === "ready" && "shadow-[inset_3px_0_0_var(--color-emerald-500)]",
        mark === "queued" && "shadow-[inset_3px_0_0_var(--color-violet-500)]",
        mark === "failed" && "shadow-[inset_3px_0_0_var(--color-red-500)]",
        mark === "hold" && "shadow-[inset_3px_0_0_var(--color-amber-500)]",
      )}
    >
      <PrContextMenu pr={pr}>
        <button
          type="button"
          onClick={(e) => commands.open(pr, e.metaKey)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return
            e.preventDefault()
            commands.view(pr)
          }}
          onFocus={() => commands.select(pr.id)}
          title={pr.local ? undefined : OPEN_HINT}
          className={cn("flex h-10 w-full items-center gap-3 px-3 text-left hover:bg-accent/60 focus-visible:bg-accent focus-visible:outline-none", selected && "bg-accent/40")}
        >
          <span className="flex flex-none items-center" style={{ width: depth * 18 }}>
            {depth ? <span className="ml-auto h-5 w-2.5 rounded-bl border-b border-l border-border" /> : null}
          </span>
          <PrStateIcon pr={pr} />
          {pr.ref ? <span className="w-12 flex-none font-mono text-[11.5px] text-muted-foreground">#{pr.ref.number}</span> : <LocalChip base={pr.local.base} />}
          {hasSignals ? (
            <span className="flex w-[112px] flex-none items-center justify-center">
              <Signals pr={pr} className="justify-center" />
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate">{titleOf(pr)}</span>
          {pr.chatProposal ? <ChatProposalChip status={pr.chatProposal} /> : null}
          {pr.local ? <span className="truncate font-mono text-xs text-muted-foreground">{pr.local.branch}</span> : null}
          {pr.owned ? (
            <Pill className="bg-violet-500/10 text-violet-700 dark:text-violet-300" hint={issueKey ? `PR que abrió el sistema, de la issue ${issueKey}` : "PR que abrió el sistema"}>
              <Repeat2 className="size-3" /> {issueKey ?? "Del sistema"}
            </Pill>
          ) : null}
          {combined ? <CombinedBaseChip parents={combined} /> : null}
          <PrNotes pr={pr} />
          {!pr.local && (mark ? <MergePill pr={pr} /> : review !== "none" ? <ReviewPill pr={pr} review={review} /> : null)}
          {!pr.local ? (
            <>
              <span className="flex flex-none items-center gap-1.5">
                {pr.state.reviewers.map((r) => (
                  <Reviewer key={r.login} r={r} size={16} />
                ))}
              </span>
              <ReviewSignals pr={pr} />
              <CiBadge ci={pr.state.ci} compact />
              <time dateTime={pr.state.updatedAt} title={absolute(pr.state.updatedAt)} className="w-20 flex-none text-right text-[11.5px] text-muted-foreground">
                {ago(pr.state.updatedAt)}
              </time>
            </>
          ) : null}
        </button>
      </PrContextMenu>
    </li>
  )
}

/** Watch solo descubre los PRs abiertos del usuario (`author:@me`) en los repos registrados: el vacío dice en cuáles buscó. */
function NoPrs({ repos, onOpenConnections }: { repos: readonly Repo[]; onOpenConnections: () => void }) {
  if (!repos.length) {
    return (
      <div className="flex flex-col items-center gap-2">
        <p>
          Registra un repo en{" "}
          <button type="button" onClick={onOpenConnections} className="text-foreground underline underline-offset-2">
            Conexiones
          </button>{" "}
          para ver tus PRs.
        </p>
        <p className="text-xs">Watch solo busca los PRs que abriste tú en los repos registrados.</p>
      </div>
    )
  }
  return (
    <div className="flex flex-col items-center gap-2">
      <p>No hay PRs abiertos tuyos en {repos.length === 1 ? "el repo registrado" : "los repos registrados"}: {repos.map((r) => r.remote ?? r.name).join(", ")}.</p>
      <p className="text-xs">Watch busca tus PRs abiertos en esos repos cada pocos minutos, y aparecen acá solos.</p>
    </div>
  )
}
