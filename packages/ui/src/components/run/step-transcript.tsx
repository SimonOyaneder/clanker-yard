import { type AgentSessionId, TRANSCRIPT_TEXT_MAX_CHARS } from "@clanker/api"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Brain, Check, ChevronRight, CircleAlert, Loader, MessageSquare, Minimize2, Terminal } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { EmptyNote } from "@/components/run/step-parts"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { useTranscript } from "@/hooks/use-transcript"
import { costUsd } from "@/lib/format"
import { rowsOf, type TranscriptRow } from "@/lib/project/transcript"
import { cn } from "@/lib/utils"

// Tool calls y razonamiento van plegados; el texto del agente, el prompt del core y el cierre no.
const OPEN_BY_DEFAULT = new Set<TranscriptRow["kind"]>(["text", "result"])
const FOLLOW_TAIL_PX = 48

const estimate = (row: TranscriptRow | undefined) => (row?.kind === "text" ? 56 : 32)

// El transcript completo de una sesión de agente: texto y tool calls plegadas, virtualizado y paginado
// (pide la página siguiente al acercarse al final). Una sesión viva sigue el final mientras estés ahí.
export function StepTranscript({ sessionId, live }: { sessionId: AgentSessionId; live: boolean }) {
  const { entries, hasMore, loaded, error, loadMore } = useTranscript(sessionId, live)
  const rows = useMemo(() => rowsOf(entries), [entries])
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  const scroller = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)

  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: (i) => estimate(rows[i]), overscan: 8, getItemKey: (i) => rows[i]!.key })
  const items = virtualizer.getVirtualItems()
  const lastVisible = items.at(-1)?.index ?? -1

  useEffect(() => {
    if (hasMore && loaded && lastVisible >= rows.length - 10) loadMore()
  }, [hasMore, loaded, lastVisible, rows.length, loadMore])

  useEffect(() => {
    if (live && atBottom.current && rows.length > 0) virtualizer.scrollToIndex(rows.length - 1, { align: "end" })
  }, [live, rows.length, virtualizer])

  if (error) {
    return (
      <EmptyNote title="No pude leer el transcript" action={<Button size="sm" variant="outline" onClick={loadMore}>Reintentar</Button>}>
        {error}
      </EmptyNote>
    )
  }
  if (loaded && rows.length === 0) {
    return (
      <EmptyNote title="Esta sesión todavía no tiene transcript" action={live ? undefined : <Button size="sm" variant="outline" onClick={loadMore}>Volver a leer</Button>}>
        {live
          ? "El agente lo va escribiendo mientras trabaja: aparece solo."
          : "Se guarda a medida que el agente trabaja. Los runtimes de prueba (fake) no lo guardan."}
      </EmptyNote>
    )
  }
  if (!loaded) return <p className="p-4 text-muted-foreground">Leyendo el transcript…</p>

  return (
    <div
      ref={scroller}
      aria-label="Transcript del agente"
      className="h-full overflow-y-auto"
      onScroll={(e) => {
        const el = e.currentTarget
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_TAIL_PX
      }}
    >
      <ol className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const row = rows[item.index]!
          const open = toggled[row.key] ?? OPEN_BY_DEFAULT.has(row.kind)
          return (
            <li key={item.key} ref={virtualizer.measureElement} data-index={item.index} className="absolute top-0 left-0 w-full border-b border-border/50" style={{ transform: `translateY(${item.start}px)` }}>
              <TranscriptLine row={row} open={open} live={live} onOpenChange={(next) => setToggled((t) => ({ ...t, [row.key]: next }))} />
            </li>
          )
        })}
      </ol>
      {hasMore ? <p className="px-3 py-2 text-xs text-muted-foreground">Cargando más…</p> : null}
    </div>
  )
}

function TranscriptLine({ row, open, live, onOpenChange }: { row: TranscriptRow; open: boolean; live: boolean; onOpenChange: (open: boolean) => void }) {
  switch (row.kind) {
    case "text":
      return (
        <div className="px-3 py-2">
          <p className="text-[13px] whitespace-pre-wrap">{row.text}</p>
          {row.truncated ? <Clipped /> : null}
        </div>
      )
    case "prompt":
      return (
        <Fold open={open} onOpenChange={onOpenChange} icon={<MessageSquare className="size-3.5" />} summary={<span className="text-muted-foreground">Mensaje al agente</span>}>
          <Block text={row.text} truncated={row.truncated} />
        </Fold>
      )
    case "thinking":
      return (
        <Fold open={open} onOpenChange={onOpenChange} icon={<Brain className="size-3.5" />} summary={<span className="text-muted-foreground italic">Razonamiento</span>}>
          <Block text={row.text} truncated={row.truncated} />
        </Fold>
      )
    case "tool": {
      const status = row.result ? (
        row.result.isError ? <CircleAlert aria-label="falló" className="size-3.5 text-red-600 dark:text-red-400" /> : <Check aria-label="listo" className="size-3.5 text-emerald-600 dark:text-emerald-400" />
      ) : live ? (
        <Loader aria-label="corriendo" className="size-3.5 animate-spin text-violet-600 dark:text-violet-400" />
      ) : null
      return (
        <Fold
          open={open}
          onOpenChange={onOpenChange}
          icon={<Terminal className="size-3.5" />}
          summary={
            <>
              <span className="font-mono text-[12.5px]">{row.tool}</span>
              {row.detail ? <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{row.detail}</span> : <span className="flex-1" />}
              {status}
            </>
          }
        >
          {row.input ? <Block label="Entrada" text={row.input} truncated={row.inputTruncated} /> : null}
          {row.result ? <Block label={row.result.isError ? "Error" : "Resultado"} text={row.result.text} truncated={row.result.truncated} error={row.result.isError} /> : <p className="px-3 pb-2 text-xs text-muted-foreground">Sin resultado todavía.</p>}
        </Fold>
      )
    }
    case "compaction":
      return (
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
          <Minimize2 className="size-3.5" /> El contexto se compactó ({row.trigger === "auto" ? "automático" : row.trigger})
        </div>
      )
    case "result":
      return (
        <div className={cn("px-3 py-2 text-xs", row.isError ? "text-red-700 dark:text-red-300" : "text-muted-foreground")}>
          Terminó: {row.subtype}
          {row.turns !== null ? ` · ${row.turns} turnos` : ""}
          {row.costUsd !== null ? ` · ${costUsd(Math.round(row.costUsd * 1_000_000))}` : ""}
        </div>
      )
  }
}

function Fold({ open, onOpenChange, icon, summary, children }: { open: boolean; onOpenChange: (open: boolean) => void; icon: React.ReactNode; summary: React.ReactNode; children: React.ReactNode }) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger className="group flex min-h-8 w-full items-center gap-2 px-3 py-1 text-left hover:bg-muted/50">
        <ChevronRight className="size-3.5 flex-none text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <span className="flex-none text-muted-foreground">{icon}</span>
        {summary}
      </CollapsibleTrigger>
      <CollapsibleContent className="pb-1">{children}</CollapsibleContent>
    </Collapsible>
  )
}

function Block({ label, text, truncated, error }: { label?: string; text: string; truncated: boolean; error?: boolean }) {
  return (
    <div className="px-3 py-1">
      {label ? <div className="pb-0.5 text-[11px] text-muted-foreground">{label}</div> : null}
      <pre className={cn("max-h-64 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-xs whitespace-pre-wrap break-words", error && "text-red-700 dark:text-red-300")}>{text}</pre>
      {truncated ? <Clipped /> : null}
    </div>
  )
}

const Clipped = () => <p className="pt-1 text-[11px] text-muted-foreground">Recortado a los primeros {TRANSCRIPT_TEXT_MAX_CHARS.toLocaleString("es-CL")} caracteres.</p>
