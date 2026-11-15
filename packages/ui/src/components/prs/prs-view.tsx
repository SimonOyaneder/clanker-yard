import { ChevronDown, LayoutList, Network, RefreshCw, Repeat2, Search } from "lucide-react"
import { useMemo, useState } from "react"
import type { PRRisk, PRsResult, PullRequest } from "@/types"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
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
import { useHost } from "@/host"
import { useAppActions } from "@/lib/app-context"
import { absolute, ago } from "@/lib/format"
import { readPref, writePref } from "@/lib/prefs"
import { reviewStatus, reviewTone } from "@/lib/pr-status"
import { buildStackForest, listStackGroups, type StackGroup } from "@/lib/stack"
import { cn } from "@/lib/utils"
import { Ago, Hint, Pill } from "../common"
import { CIBadge, copy, MergePill, PRStateIcon, Reviewer, ReviewPill, ReviewSignals, RISK, RiskBadge } from "./pr-bits"
import { StackGraph } from "./stack-graph"

type Filter = "all" | "stacked" | "solo" | "draft" | "ready" | "mergeable" | "approved" | "pending" | "changes" | "clanker"
type Mode = "graph" | "list"

const FILTERS: { key: Filter; label: string; match: (pr: PullRequest, stacked: Set<number>) => boolean }[] = [
  { key: "all", label: "Todos", match: () => true },
  { key: "stacked", label: "En stack", match: (p, s) => s.has(p.id) },
  { key: "solo", label: "Sueltos", match: (p, s) => !s.has(p.id) },
  { key: "draft", label: "Draft", match: (p) => p.isDraft },
  { key: "ready", label: "Listos para review", match: (p) => p.state === "open" && !p.isDraft },
  { key: "mergeable", label: "Listos para merge", match: (p) => p.merge.ready },
  { key: "changes", label: "Necesita acción", match: (p) => reviewStatus(p) === "changes" },
  { key: "pending", label: "Esperando review", match: (p) => reviewStatus(p) === "pending" },
  { key: "approved", label: "Aprobados", match: (p) => reviewStatus(p) === "approved" },
  { key: "clanker", label: "Del clanker", match: (p) => !!p.clanker },
]

interface Props {
  data: PRsResult | null
  error: string | null
  onRefresh: () => void
}

export function PrsView({ data, error, onRefresh }: Props) {
  const [filter, setFilterState] = useState<Filter>(() => readPref<Filter>("prs.filter", "all"))
  const [mode, setModeState] = useState<Mode>(() => readPref<Mode>("prs.mode", "graph"))
  const [hiddenRepos, setHiddenRepos] = useState<string[]>(() => readPref<string[]>("prs.hiddenRepos", []))
  const [query, setQuery] = useState("")
  const [risk, setRiskState] = useState<PRRisk | "all">(() => readPref<PRRisk | "all">("prs.risk", "all"))
  const setRisk = (r: PRRisk) => {
    const next = risk === r ? "all" : r
    setRiskState(next)
    writePref("prs.risk", next)
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
  const toggleRepo = (repo: string) => {
    const next = hiddenRepos.includes(repo) ? hiddenRepos.filter((r) => r !== repo) : [...hiddenRepos, repo]
    setHiddenRepos(next)
    writePref("prs.hiddenRepos", next)
  }

  const prs = useMemo(() => data?.prs ?? [], [data])
  const repos = useMemo(() => [...new Set(prs.map((p) => p.repoFullName))].sort(), [prs])
  const scoped = useMemo(() => prs.filter((p) => !hiddenRepos.includes(p.repoFullName)), [prs, hiddenRepos])
  const forest = useMemo(() => buildStackForest(scoped), [scoped])
  const groups = useMemo(() => listStackGroups(forest), [forest])
  const stacked = useMemo(() => new Set(groups.filter((g) => g.prIds.length > 1).flatMap((g) => g.prIds)), [groups])

  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.key, scoped.filter((p) => f.match(p, stacked)).length])), [scoped, stacked])
  const riskCounts = useMemo(
    () => ({ high: scoped.filter((p) => p.risk === "high").length, mid: scoped.filter((p) => p.risk === "mid").length, low: scoped.filter((p) => p.risk === "low").length }),
    [scoped],
  )

  // Un PR que calza trae su stack completo; el resto del stack queda atenuado.
  const { visible, dimmed, visibleGroups } = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matcher = FILTERS.find((f) => f.key === filter)!.match
    const matches = new Set(
      scoped
        .filter((p) => matcher(p, stacked))
        .filter((p) => risk === "all" || p.risk === risk)
        .filter((p) => !q || `#${p.number} ${p.title} ${p.headRef} ${p.repoName} ${p.clanker?.issueId ?? ""}`.toLowerCase().includes(q))
        .map((p) => p.id),
    )
    const vg = groups.filter((g) => g.prIds.some((id) => matches.has(id)))
    const ids = new Set(vg.flatMap((g) => g.prIds))
    return {
      visible: scoped.filter((p) => ids.has(p.id)),
      dimmed: new Set([...ids].filter((id) => !matches.has(id))),
      visibleGroups: vg,
    }
  }, [scoped, stacked, groups, filter, query, risk])

  if (!data) {
    return (
      <div className="flex flex-col gap-4 px-6 pt-5">
        {error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13px]">
            <p className="font-medium">No pude leer tus PRs de GitHub</p>
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
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-col gap-3 border-b px-6 pt-5 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">Stacks de PR</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {prs.length} PRs abiertos de @{data.viewer.login} · {groups.filter((g) => g.prIds.length > 1).length} stacks · actualizado{" "}
              <Ago at={data.fetchedAt} />, se actualiza cada 5 min
              {data.total > prs.length ? <span> · mostrando {prs.length} de {data.total}</span> : null}
              {data.rate ? (
                <span
                  title={`Cuota de GraphQL de GitHub, compartida con gh y el vigilante del clanker-loop. Esta consulta costó ${data.rate.cost} puntos. Se renueva a las ${new Date(data.rate.resetAt).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", hour12: false })}.`}
                  className={cn(data.rate.remaining < 1000 && "text-amber-600 dark:text-amber-400")}
                >
                  {" "}
                  · GitHub: quedan {data.rate.remaining.toLocaleString("es-CL")} de {data.rate.limit.toLocaleString("es-CL")} puntos
                </span>
              ) : null}
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

        {data.pausedUntil ? (
          <div role="status" className="rounded-md border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-[12.5px] text-amber-900 dark:text-amber-200">
            Pausé las consultas a GitHub para no agotar tu cuota de GraphQL. Muestro lo último que traje; vuelvo a consultar a las{" "}
            {new Date(data.pausedUntil).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", hour12: false })}.
          </div>
        ) : null}

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
              ) : f.key === "clanker" ? (
                <Repeat2 className="size-3" />
              ) : null}
              {f.label}
              <span className="tabular-nums opacity-70">{counts[f.key]}</span>
            </button>
          ))}
          <div role="group" aria-label="Riesgo" className="ml-2 flex items-center gap-1 border-l pl-3">
            <span className="mr-0.5 text-xs text-muted-foreground">Riesgo</span>
            {(["high", "mid", "low"] as PRRisk[]).map((r) => {
              const R = RISK[r]
              return (
                <button
                  key={r}
                  type="button"
                  aria-pressed={risk === r}
                  onClick={() => setRisk(r)}
                  disabled={!riskCounts[r]}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors disabled:opacity-40",
                    risk === r ? cn("border-transparent", R.className) : "bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
                    "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                  )}
                >
                  <R.Icon className="size-3" />
                  {R.short}
                  <span className="tabular-nums opacity-70">{riskCounts[r]}</span>
                </button>
              )
            })}
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filtrar por título, #, branch…" className="h-7 w-56 pl-7 text-xs" />
            </div>
            {repos.length > 1 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" className="h-7 text-xs">
                    Repos {hiddenRepos.length ? `${repos.length - hiddenRepos.length}/${repos.length}` : ""} <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-60">
                  <DropdownMenuLabel>Repos visibles</DropdownMenuLabel>
                  {repos.map((r) => (
                    <DropdownMenuCheckboxItem key={r} checked={!hiddenRepos.includes(r)} onCheckedChange={() => toggleRepo(r)} onSelect={(e) => e.preventDefault()}>
                      {r.split("/")[1]}
                    </DropdownMenuCheckboxItem>
                  ))}
                  {hiddenRepos.length ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() => {
                          setHiddenRepos([])
                          writePref("prs.hiddenRepos", [])
                        }}
                      >
                        Mostrar todos
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </div>
      </header>

      {!visible.length ? (
        <div className="m-6 rounded-lg border border-dashed px-4 py-8 text-center text-[13px] text-muted-foreground">
          {prs.length ? "Ningún PR calza con este filtro." : "No tienes PRs abiertos."}
        </div>
      ) : mode === "graph" ? (
        <div className="min-h-0 flex-1">
          <StackGraph prs={visible} dimmed={dimmed} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          <PRList groups={visibleGroups} byId={forest.byId} childrenOf={forest.childrenOf} dimmed={dimmed} />
        </div>
      )}
    </div>
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

// Stacks primero, cada uno con su sección; los PRs sueltos van juntos por repo.
function PRList({
  groups,
  byId,
  childrenOf,
  dimmed,
}: {
  groups: StackGroup[]
  byId: Map<number, PullRequest>
  childrenOf: Map<number, number[]>
  dimmed: Set<number>
}) {
  const stacks = groups.filter((g) => g.prIds.length > 1)
  const solosByRepo = new Map<string, PullRequest[]>()
  for (const g of groups.filter((g) => g.prIds.length === 1)) {
    const pr = byId.get(g.rootId)!
    solosByRepo.set(pr.repoName, [...(solosByRepo.get(pr.repoName) ?? []), pr])
  }
  return (
    <div className="flex flex-col gap-3">
      {stacks.map((g) => {
        // Orden en profundidad para dibujar el árbol con sangría.
        const rows: { id: number; depth: number }[] = []
        const walk = (id: number, depth: number) => {
          rows.push({ id, depth })
          for (const c of childrenOf.get(id) ?? []) walk(c, depth + 1)
        }
        walk(g.rootId, 0)
        const root = byId.get(g.rootId)!
        return (
          <Section key={g.rootId} title={root.repoName} sub={`stack de ${g.prIds.length} PRs sobre ${root.baseRef}`}>
            {rows.map(({ id, depth }) => (
              <PRRow key={id} pr={byId.get(id)!} depth={depth} dimmed={dimmed.has(id)} />
            ))}
          </Section>
        )
      })}
      {[...solosByRepo.entries()].map(([repo, list]) => (
        <Section key={`solos-${repo}`} title={repo} sub={list.length === 1 ? "1 PR suelto" : `${list.length} PRs sueltos`}>
          {[...list]
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .map((pr) => (
              <PRRow key={pr.id} pr={pr} depth={0} dimmed={dimmed.has(pr.id)} />
            ))}
        </Section>
      ))}
    </div>
  )
}

function PRRow({ pr, depth, dimmed }: { pr: PullRequest; depth: number; dimmed: boolean }) {
  const host = useHost()
  const actions = useAppActions()
  const review = reviewStatus(pr)
  const merge = pr.merge.ready || pr.merge.finMerge
  return (
    <li
      className={cn(
        "border-t first:border-t-0",
        dimmed && "opacity-50",
        pr.merge.ready && "shadow-[inset_3px_0_0_var(--color-emerald-500)]",
        pr.merge.finMerge === "queued" && "shadow-[inset_3px_0_0_var(--color-violet-500)]",
        pr.merge.finMerge === "failed" && "shadow-[inset_3px_0_0_var(--color-red-500)]",
      )}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={() => host.openExternal(pr.url)}
            className="flex h-10 w-full items-center gap-3 px-3 text-left hover:bg-accent/60 focus-visible:bg-accent focus-visible:outline-none"
          >
            <span className="flex flex-none items-center" style={{ width: depth * 18 }}>
              {depth ? <span className="ml-auto h-5 w-2.5 rounded-bl border-b border-l border-border" /> : null}
            </span>
            <PRStateIcon pr={pr} />
            <span className="w-12 flex-none font-mono text-[11.5px] text-muted-foreground">#{pr.number}</span>
            <RiskBadge risk={pr.risk} className="w-[104px] flex-none justify-center" />
            <span className="min-w-0 flex-1 truncate">{pr.title}</span>
            {pr.clanker ? (
              <Pill className="bg-violet-500/10 text-violet-700 dark:text-violet-300" hint={`PR del clanker-loop "${pr.clanker.loop}", de la issue ${pr.clanker.issueId}`}>
                <Repeat2 className="size-3" /> {pr.clanker.issueId}
              </Pill>
            ) : null}
            {merge ? <MergePill pr={pr} /> : review !== "none" ? <ReviewPill pr={pr} review={review} /> : null}
            <span className="flex flex-none items-center gap-1.5">
              {pr.reviewerStates.map((r) => (
                <Reviewer key={r.login} r={r} size={16} />
              ))}
            </span>
            <ReviewSignals pr={pr} />
            <CIBadge status={pr.ciStatus} compact />
            <time dateTime={pr.updatedAt} title={absolute(pr.updatedAt)} className="w-20 flex-none text-right text-[11.5px] text-muted-foreground">
              {ago(pr.updatedAt)}
            </time>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          <ContextMenuItem onSelect={() => host.openExternal(pr.url)}>Abrir PR en GitHub</ContextMenuItem>
          {pr.clanker ? (
            <ContextMenuItem onSelect={() => actions.selectProject(pr.clanker!.slug)}>
              Ver {pr.clanker.issueId} en {pr.clanker.loop}
            </ContextMenuItem>
          ) : null}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => copy(pr.url, "el link")}>Copiar link</ContextMenuItem>
          <ContextMenuItem onSelect={() => copy(pr.headRef, "la branch")}>Copiar branch</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  )
}
