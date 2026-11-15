import { ChevronRight } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import type { Loop } from "@/types"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { useHost } from "@/host"
import { issueIdOf, linearIssueUrl, tone, usd } from "@/lib/format"
import { readPref, writePref } from "@/lib/prefs"
import { cn } from "@/lib/utils"
import { type IssueState, Pill, SectionTitle, StateIcon, stateLabel } from "../common"

interface Row {
  key: string
  id: string
  title: string
  meta: string
  pr: string | null
  prUrl: string | null
  tag: { text: string; className: string; hint: string } | null
}

const ORDER: IssueState[] = ["curso", "cola", "abierto", "aprobado", "problema", "mergeado"]

function rows(loop: Loop): Record<IssueState, Row[]> {
  const out: Record<IssueState, Row[]> = { curso: [], cola: [], abierto: [], aprobado: [], problema: [], mergeado: [] }
  for (const s of loop.slots) {
    out.curso.push({
      key: `curso-${s.issueId}`,
      id: s.issueId,
      title: s.title ?? "",
      meta: [s.minutes !== null ? `${s.minutes} min` : null, usd(s.usd)].filter(Boolean).join(" · "),
      pr: `slot ${s.slot}`,
      prUrl: null,
      tag: { text: s.steps.find((x) => x.status === "current")?.label ?? "", className: tone.violet, hint: `Paso en que va el slot ${s.slot}` },
    })
  }
  ;(loop.queueItems ?? []).forEach((q, i) => {
    out.cola.push({
      key: `cola-${q.id}`,
      id: q.id,
      title: q.title ?? "",
      meta: q.repo ?? "",
      pr: q.base && q.base !== "main" ? `sobre ${q.base}` : null,
      prUrl: null,
      tag: q.bloqueos
        ? { text: `bloqueada: ${q.bloqueos}`, className: tone.amber, hint: `Depende de ${q.bloqueos}: el EM no la toma hasta que eso se resuelva` }
        : i === 0
          ? { text: "siguiente", className: tone.violet, hint: "La próxima que toma el EM cuando se libere un slot" }
          : null,
    })
  })
  for (const h of [...loop.history].reverse()) {
    const note = /\(([^)]*)\)/.exec(h.estado)?.[1]
    out[h.column].push({
      key: `${h.column}-${h.issueId}-${h.pr}`,
      id: issueIdOf(h.issueId),
      title: h.title ?? h.branch.replace(/^\(worktree\s+/, "").replace(/\)$/, ""),
      meta: [h.minutes !== null ? `${h.minutes} min` : null, usd(h.usd)].filter(Boolean).join(" · "),
      pr: h.pr.split(" ")[0] ?? null,
      prUrl: h.prUrl,
      tag: note ? { text: note, className: tone.amber, hint: "Nota del EM sobre el estado de esta issue en el state.md" } : null,
    })
  }
  return out
}

export function IssueList({ loop, onOpenIssue }: { loop: Loop; onOpenIssue: (id: string) => void }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => readPref("collapsedGroups", { mergeado: true }))
  const groups = rows(loop)
  const total = ORDER.reduce((a, k) => a + groups[k].length, 0)

  const toggle = (k: IssueState) => {
    const next = { ...collapsed, [k]: !collapsed[k] }
    setCollapsed(next)
    writePref("collapsedGroups", next)
  }

  return (
    <section className="flex flex-col gap-2">
      <SectionTitle count={total} aside={`${loop.history.length} en el historial`}>
        Issues
      </SectionTitle>
      <div className="overflow-hidden rounded-lg border bg-card">
        {ORDER.filter((k) => groups[k].length).map((k, gi) => (
          <div key={k} className={cn(gi > 0 && "border-t")}>
            <button
              type="button"
              onClick={() => toggle(k)}
              aria-expanded={!collapsed[k]}
              className="flex h-8 w-full items-center gap-2 bg-muted/40 px-3 text-left text-xs font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset"
            >
              <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", !collapsed[k] && "rotate-90")} />
              <StateIcon state={k} />
              {stateLabel(k)}
              <span className="font-normal text-muted-foreground tabular-nums">{groups[k].length}</span>
            </button>
            {!collapsed[k] ? (
              <ul>
                {groups[k].map((r) => (
                  <IssueRow key={r.key} r={r} state={k} projectUrl={loop.projectUrl} onOpen={() => onOpenIssue(r.id)} />
                ))}
              </ul>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  )
}

function IssueRow({ r, state, projectUrl, onOpen }: { r: Row; state: IssueState; projectUrl: string | null; onOpen: () => void }) {
  const host = useHost()
  const linear = linearIssueUrl(projectUrl, r.id)
  return (
    <li className="border-t border-border/60 first:border-t-0">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            data-issue-id={r.id}
            onClick={onOpen}
            className="grid h-9 w-full grid-cols-[16px_76px_minmax(0,1fr)_auto] items-center gap-3 px-3 text-left hover:bg-accent/60 focus-visible:bg-accent focus-visible:outline-none"
          >
            <StateIcon state={state} />
            <span className="truncate font-mono text-[11.5px] text-muted-foreground">{r.id}</span>
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">{r.title || <span className="text-muted-foreground">sin título</span>}</span>
              {r.tag?.text ? (
                <Pill className={r.tag.className} hint={r.tag.hint}>
                  {r.tag.text}
                </Pill>
              ) : null}
            </span>
            <span className="flex items-center gap-3 text-xs text-muted-foreground tabular-nums">
              {r.pr ? <span className="font-mono text-[11px]">{r.pr}</span> : null}
              {r.meta ? <span className="w-[104px] text-right">{r.meta}</span> : null}
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuItem onSelect={onOpen}>Ver detalle</ContextMenuItem>
          {r.prUrl ? <ContextMenuItem onSelect={() => host.openExternal(r.prUrl!)}>Abrir PR en GitHub</ContextMenuItem> : null}
          {linear ? <ContextMenuItem onSelect={() => host.openExternal(linear)}>Abrir en Linear</ContextMenuItem> : null}
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() => {
              void navigator.clipboard.writeText(r.id).then(
                () => toast.success(`Copié ${r.id}`),
                () => toast.error("No pude copiar"),
              )
            }}
          >
            Copiar ID
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  )
}
