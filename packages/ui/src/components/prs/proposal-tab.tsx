import type { ChatId, ChatProposal } from "@clanker/api"
import { Columns2, Rows2 } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useAppData } from "@/app-data"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useLiveQuery } from "@/hooks/use-live"
import { isTypingTarget } from "@/lib/keys"
import { parsePatch } from "@/lib/prs/diff"
import { type DiffMode, FileDiff } from "./file-diff"

/** Los atajos de la pestaña; los mismos que la de archivos. */
export const PROPOSAL_KEYS = { mode: "S", prev: "[", next: "]" } as const

/**
 * La pestaña Propuesta de la vista del PR: el diff exacto que aplicaría la propuesta del chat (unificado o lado a lado),
 * con sus revs anteriores en solo lectura y "solo lo de este turno" (el diff contra la rev anterior).
 */
export function ProposalTab({ chatId, proposal, mode, onMode }: { chatId: ChatId; proposal: ChatProposal; mode: DiffMode; onMode: (mode: DiffMode) => void }) {
  const appData = useAppData()
  const [rev, setRev] = useState(proposal.rev)
  // Una propuesta nueva (otro turno) se muestra al llegar.
  useEffect(() => setRev(proposal.rev), [proposal.rev])
  const [turnOnly, setTurnOnly] = useState(false)
  const since = turnOnly && rev > 1 ? rev - 1 : undefined
  const query = useLiveQuery(`proposal:${chatId}:${rev}:${since ?? "-"}`, () => appData.chatProposal!({ chatId, rev, ...(since && { since }) }), { live: false })
  const files = useMemo(() => (query.data ? parsePatch(query.data.patch) : []), [query.data])
  const [viewed, setViewed] = useState<Set<string>>(() => new Set())
  const [at, setAt] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || isTypingTarget(e.target, ["[role='dialog']", "[role='alertdialog']", "[role='menu']", "[role='listbox']"])) return
      if (e.key !== PROPOSAL_KEYS.prev && e.key !== PROPOSAL_KEYS.next) return
      e.preventDefault()
      const next = Math.max(0, Math.min(files.length - 1, at + (e.key === PROPOSAL_KEYS.next ? 1 : -1)))
      setAt(next)
      list.current?.querySelectorAll("section[aria-label]")[next]?.scrollIntoView({ block: "start" })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [files.length, at])

  const current = rev === proposal.rev
  return (
    <>
      <div className="flex flex-none flex-wrap items-center gap-2 border-b px-6 pt-4 pb-3">
        <Select value={String(rev)} onValueChange={(value) => setRev(Number(value))}>
          <SelectTrigger size="sm" className="w-56" aria-label="Qué propuesta ver">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Array.from({ length: proposal.rev }, (_, i) => proposal.rev - i).map((r) => (
              <SelectItem key={r} value={String(r)}>Propuesta {r}{r === proposal.rev ? " (vigente)" : " (solo lectura)"}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title={rev === 1 ? "La primera propuesta no tiene una anterior con qué comparar." : undefined}>
          <Checkbox aria-label="Solo lo de este turno" checked={turnOnly && rev > 1} disabled={rev === 1} onCheckedChange={(on) => setTurnOnly(on === true)} /> Solo lo de este turno
        </label>
        {!current ? <span className="text-xs text-muted-foreground">Una propuesta anterior no se aplica: es del historial.</span> : null}
        <span className="ml-auto text-xs text-muted-foreground">Sobre <code>{proposal.baseSha.slice(0, 7)}</code> · {PROPOSAL_KEYS.prev} {PROPOSAL_KEYS.next} cambian de archivo</span>
        <ToggleGroup type="single" size="sm" variant="outline" value={mode} onValueChange={(v) => v && onMode(v as DiffMode)} aria-label={`Modo del diff (${PROPOSAL_KEYS.mode})`}>
          <ToggleGroupItem value="unified" aria-label="Unificado" title={`Unificado (${PROPOSAL_KEYS.mode})`}><Rows2 /></ToggleGroupItem>
          <ToggleGroupItem value="split" aria-label="Lado a lado" title={`Lado a lado (${PROPOSAL_KEYS.mode})`}><Columns2 /></ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div ref={list} data-testid="proposal-files" className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-4">
        {query.error ? (
          <div role="alert" className="flex items-center gap-3">
            <p className="text-sm text-destructive">{query.error}</p>
            <Button variant="outline" size="sm" onClick={query.reload}>Reintentar</Button>
          </div>
        ) : null}
        {!query.data && !query.error ? <Skeleton className="h-40 w-full" /> : null}
        {query.data && files.length === 0 ? <p className="text-sm text-muted-foreground">{since ? "Este turno no cambió archivos respecto de la propuesta anterior." : "La propuesta no cambia archivos."}</p> : null}
        {files.map((file) => (
          <FileDiff key={`${rev}:${since ?? "-"}:${file.path}`} file={file} mode={mode} viewed={viewed.has(file.path)} onViewed={(on) => setViewed((previous) => {
            const next = new Set(previous)
            if (on) next.add(file.path)
            else next.delete(file.path)
            return next
          })} />
        ))}
      </div>
    </>
  )
}
