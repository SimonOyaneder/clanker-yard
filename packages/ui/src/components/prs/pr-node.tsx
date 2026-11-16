import { Handle, type NodeProps, Position } from "@xyflow/react"
import { Repeat2 } from "lucide-react"
import { useHost } from "@/host"
import { absolute, ago } from "@/lib/format"
import { draftTone, reviewStatus, reviewTone } from "@/lib/pr-status"
import { isDraft, type OpenPr, repoNameOf } from "@/lib/prs"
import { cn } from "@/lib/utils"
import { Hint, Pill } from "../common"
import { CIBadge, CombinedBaseChip, Labels, MergePill, mergeRing, PRStateIcon, Reviewer, ReviewPill, ReviewSignals, Signals } from "./pr-bits"
import { usePrCommands } from "./pr-commands"
import { PrContextMenu } from "./pr-menu"
import { PrNotes } from "./pr-notes"

export interface PRNodeData extends Record<string, unknown> {
  pr: OpenPr
  // Está en el stack de un PR que calza con el filtro, pero él no calza.
  dimmed?: boolean
  // La clave de la issue que originó el PR, si el core la conoce.
  issueKey?: string
  // Las claves de sus PRs padre cuando sale de una base combinada.
  combined?: string[]
}

export const NODE_WIDTH = 296
export const NODE_HEIGHT = 196

export function PRNode({ data }: NodeProps & { data: PRNodeData }) {
  const host = useHost()
  const commands = usePrCommands()
  const { pr, dimmed, issueKey, combined } = data
  const { state } = pr
  const review = reviewStatus(pr)
  const draft = draftTone
  const ring = mergeRing(pr)

  return (
    <PrContextMenu pr={pr}>
      <div
        role="link"
        tabIndex={0}
        aria-label={`#${pr.ref.number} ${state.title}`}
        onFocus={() => commands.select(pr.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter") host.openExternal(state.url)
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
          <span className="truncate">{repoNameOf(pr)}</span>
          <span className="font-mono">#{pr.ref.number}</span>
          <span className="ml-auto flex items-center gap-1">
            {isDraft(pr) ? (
              <Pill className={draft.pill} hint="Draft: todavía no está listo para review">
                {draft.label}
              </Pill>
            ) : null}
            <Signals pr={pr} />
          </span>
        </div>

        <h3 className="line-clamp-2 text-[13px] leading-snug font-medium">{state.title}</h3>

        <div className="flex min-w-0 items-center gap-1 font-mono text-[10.5px] text-muted-foreground">
          <span className="truncate rounded bg-muted px-1 py-px" title={state.baseRef}>
            {state.baseRef}
          </span>
          <span aria-hidden="true">←</span>
          <span className="truncate rounded bg-muted px-1 py-px" title={state.headRef}>
            {state.headRef}
          </span>
        </div>

        <div className="flex min-h-5 flex-wrap items-center gap-2">
          {ring ? <MergePill pr={pr} /> : review !== "none" ? <ReviewPill pr={pr} review={review} /> : null}
          {combined ? <CombinedBaseChip parents={combined} /> : null}
          <PrNotes pr={pr} />
          {state.reviewers.length ? (
            <span className="flex items-center gap-1.5">
              {state.reviewers.map((r) => (
                <Reviewer key={r.login} r={r} />
              ))}
            </span>
          ) : null}
          <ReviewSignals pr={pr} />
        </div>

        <Labels pr={pr} />

        <div className="mt-auto flex items-center justify-between gap-2 border-t pt-2 text-[11px] text-muted-foreground tabular-nums">
          <CIBadge ci={state.ci} />
          <span className="flex items-center gap-2">
            <span className="text-emerald-600 dark:text-emerald-400">+{state.additions}</span>
            <span className="text-red-600 dark:text-red-400">−{state.deletions}</span>
            <time dateTime={state.updatedAt} title={absolute(state.updatedAt)}>
              {ago(state.updatedAt)}
            </time>
          </span>
        </div>

        {pr.owned ? (
          <Hint label={pr.runId !== null ? "PR que abrió el sistema. Click para ver la corrida que lo abrió" : "PR que abrió el sistema"}>
            <button
              type="button"
              disabled={pr.runId === null}
              onClick={(e) => {
                e.stopPropagation()
                commands.openRun(pr)
              }}
              className="-mx-1 -mb-1 flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[11px] text-violet-700 hover:bg-violet-500/10 disabled:pointer-events-none dark:text-violet-300"
            >
              <Repeat2 className="size-3" />
              <span className="truncate">{issueKey ? `Del sistema · ${issueKey}` : "Del sistema"}</span>
            </button>
          </Hint>
        ) : null}
      </div>
    </PrContextMenu>
  )
}
