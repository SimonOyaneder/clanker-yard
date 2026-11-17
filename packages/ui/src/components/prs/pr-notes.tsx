import type { Decision } from "@clanker/api"
import { MessageSquare } from "lucide-react"
import { createContext, useContext } from "react"
import { NoteItem } from "@/components/notes"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { alsoInRuns, notesOfPr } from "@/lib/notes"
import { tone } from "@/lib/format"
import type { OpenPr } from "@/lib/prs/prs"
import { cn } from "@/lib/utils"

/** Las notas de los agentes (`review_note` y `note`) de todos los PRs; cada PR lee las suyas. */
export const PrNotesContext = createContext<readonly Decision[]>([])

/** "n notas para el review": abre las notas que dejaron los agentes sobre este PR. Nada si no hay. */
export function PrNotes({ pr, className }: { pr: OpenPr; className?: string }) {
  const all = useContext(PrNotesContext)
  const notes = notesOfPr(all, pr)
  if (notes.length === 0) return null
  const label = notes.length === 1 ? "1 nota para el review" : `${notes.length} notas para el review`
  return (
    <Popover>
      <PopoverTrigger asChild>
        <span
          role="button"
          tabIndex={0}
          aria-label={label}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className={cn("inline-flex h-5 cursor-pointer items-center gap-1 rounded-full px-2 text-[11px] font-medium whitespace-nowrap", tone.sky, className)}
        >
          <MessageSquare className="size-3" /> {label}
        </span>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-80 w-96 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h4 className="text-xs font-medium text-muted-foreground">Notas de los agentes para el review</h4>
        <ul className="divide-y">
          {notes.map((n) => (
            <NoteItem key={n.id} note={n} also={alsoInRuns(n, all)} />
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
