import { ChevronRight } from "lucide-react"
import type { Slot } from "@/types"
import { usd } from "@/lib/format"
import { MemberCard, Stepper } from "../common"

export function SlotCard({ slot, onOpen }: { slot: Slot; onOpen: () => void }) {
  const meta = [slot.repo, slot.profile ? `perfil ${slot.profile}` : null, slot.base && slot.base !== "main" ? `sobre ${slot.base}` : null, slot.branch]
    .filter(Boolean)
    .join(" · ")
  return (
    <article className="flex flex-col gap-3 rounded-lg border bg-card p-3.5">
      <button
        type="button"
        onClick={onOpen}
        data-issue-id={slot.issueId}
        className="group -m-1.5 flex items-start gap-3 rounded-md p-1.5 text-left hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <span className="grid size-6 flex-none place-items-center rounded-md bg-muted font-mono text-xs font-medium">{slot.slot}</span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="flex-none font-mono text-xs text-muted-foreground">{slot.issueId}</span>
            <span className="truncate font-medium">{slot.title ?? "sin título"}</span>
          </span>
          <span className="truncate text-xs text-muted-foreground">{meta}</span>
        </span>
        <span className="flex flex-none items-center gap-3 text-xs text-muted-foreground tabular-nums">
          {slot.minutes !== null ? <span>{slot.minutes} min</span> : null}
          <span className="font-medium text-foreground">{usd(slot.usd)}</span>
          <ChevronRight className="size-4 opacity-0 transition-opacity group-hover:opacity-100" />
        </span>
      </button>
      <Stepper steps={slot.steps} />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(196px,1fr))] gap-1.5">
        {slot.team.map((m) => (
          <MemberCard key={m.role} m={m} />
        ))}
      </div>
    </article>
  )
}
