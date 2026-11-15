import { Handle, type NodeProps, Position } from "@xyflow/react"
import { Repeat2 } from "lucide-react"
import type { PullRequest } from "@/types"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { useHost } from "@/host"
import { useAppActions } from "@/lib/app-context"
import { absolute, ago } from "@/lib/format"
import { prStateTone, reviewStatus, reviewTone } from "@/lib/pr-status"
import { cn } from "@/lib/utils"
import { Hint, Pill } from "../common"
import { CIBadge, copy, Labels, MergePill, mergeRing, PRStateIcon, Reviewer, ReviewPill, ReviewSignals, RiskBadge } from "./pr-bits"

export interface PRNodeData extends Record<string, unknown> {
  pr: PullRequest
  // Está en el stack de un PR que calza con el filtro, pero él no calza.
  dimmed?: boolean
}

export const NODE_WIDTH = 296
export const NODE_HEIGHT = 196

export function PRNode({ data }: NodeProps & { data: PRNodeData }) {
  const host = useHost()
  const { pr, dimmed } = data
  const actions = useAppActions()
  const review = reviewStatus(pr)
  const state = prStateTone[pr.state]
  const ring = mergeRing(pr)

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="link"
          tabIndex={0}
          aria-label={`#${pr.number} ${pr.title}`}
          onKeyDown={(e) => {
            if (e.key === "Enter") host.openExternal(pr.url)
          }}
          style={{ width: NODE_WIDTH, minHeight: NODE_HEIGHT - 12 }}
          className={cn(
            "group flex cursor-pointer flex-col gap-2 rounded-lg border bg-card p-3 text-left shadow-xs transition-[box-shadow,transform] select-none",
            "hover:-translate-y-px hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            ring ?? (review !== "none" && cn("ring-1", reviewTone[review].ring)),
            dimmed && "opacity-45 hover:opacity-100",
          )}
        >
          <Handle type="target" position={Position.Top} isConnectable={false} className="!opacity-0" />
          <Handle type="source" position={Position.Bottom} isConnectable={false} className="!opacity-0" />

          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <PRStateIcon pr={pr} />
            <span className="truncate">{pr.repoName}</span>
            <span className="font-mono">#{pr.number}</span>
            <span className="ml-auto flex items-center gap-1">
              {pr.isDraft ? (
                <Pill className={state.pill} hint="Draft: todavía no está listo para review">
                  {state.label}
                </Pill>
              ) : null}
              <RiskBadge risk={pr.risk} />
            </span>
          </div>

          <h3 className="line-clamp-2 text-[13px] leading-snug font-medium">{pr.title}</h3>

          <div className="flex min-w-0 items-center gap-1 font-mono text-[10.5px] text-muted-foreground">
            <span className="truncate rounded bg-muted px-1 py-px" title={pr.baseRef}>
              {pr.baseRef}
            </span>
            <span aria-hidden="true">←</span>
            <span className="truncate rounded bg-muted px-1 py-px" title={pr.headRef}>
              {pr.headRef}
            </span>
          </div>

          <div className="flex min-h-5 flex-wrap items-center gap-2">
            {ring ? <MergePill pr={pr} /> : review !== "none" ? <ReviewPill pr={pr} review={review} /> : null}
            {pr.reviewerStates.length ? (
              <span className="flex items-center gap-1.5">
                {pr.reviewerStates.map((r) => (
                  <Reviewer key={r.login} r={r} />
                ))}
              </span>
            ) : null}
            <ReviewSignals pr={pr} />
          </div>

          <Labels pr={pr} />

          <div className="mt-auto flex items-center justify-between gap-2 border-t pt-2 text-[11px] text-muted-foreground tabular-nums">
            <CIBadge status={pr.ciStatus} />
            <span className="flex items-center gap-2">
              <span className="text-emerald-600 dark:text-emerald-400">+{pr.additions}</span>
              <span className="text-red-600 dark:text-red-400">−{pr.deletions}</span>
              <time dateTime={pr.updatedAt} title={absolute(pr.updatedAt)}>
                {ago(pr.updatedAt)}
              </time>
            </span>
          </div>

          {pr.clanker ? (
            <Hint label={`PR del clanker-loop "${pr.clanker.loop}". Click para ver la issue ${pr.clanker.issueId} en Clanker Control`}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                actions.selectProject(pr.clanker!.slug)
              }}
              className="-mx-1 -mb-1 flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[11px] text-violet-700 hover:bg-violet-500/10 dark:text-violet-300"
            >
              <Repeat2 className="size-3" />
              <span className="truncate">
                {pr.clanker.loop} · {pr.clanker.issueId}
              </span>
            </button>
            </Hint>
          ) : null}
        </div>
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
  )
}
