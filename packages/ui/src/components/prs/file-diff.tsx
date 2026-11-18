import { Check } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuShortcut, ContextMenuTrigger } from "@/components/ui/context-menu"
import { isTypingTarget } from "@/lib/keys"
import { type DiffFile, type DiffLine, splitRows } from "@/lib/prs/diff"
import { highlightLine, languageOf } from "@/lib/prs/highlight"
import { cn } from "@/lib/utils"

/** Líneas que se dibujan de un archivo antes de pedir "Mostrar todo": un diff de miles de líneas congela la vista. */
const LINES_PER_FILE = 400

export type DiffMode = "unified" | "split"

/** Las líneas que se le citan al chat: rutas y números del lado nuevo (o del viejo en una línea borrada). */
export interface DiffCitation {
  path: string
  start: number
  end: number
  text: string
}

/** El atajo para citar lo marcado; lo muestra también el composer del chat. */
export const CITE_KEY = "⌥K"

const LINE_TONE: Record<DiffLine["kind"], string> = {
  add: "bg-viz-3/10",
  del: "bg-destructive/10",
  hunk: "bg-muted text-muted-foreground",
  ctx: "",
  note: "text-muted-foreground italic",
}

/** El texto de una línea con el color de su lenguaje (el HTML lo arma highlight.js, que escapa el texto). */
function Code({ line, language }: { line: DiffLine; language: string | undefined }) {
  const html = line.kind === "add" || line.kind === "del" || line.kind === "ctx" ? highlightLine(line.text, language) : undefined
  return html === undefined ? <>{line.text}</> : <span dangerouslySetInnerHTML={{ __html: html }} />
}

const sign = (line: DiffLine | undefined) => (line?.kind === "add" ? "+" : line?.kind === "del" ? "−" : "")

export function FileDiff({ file, mode, viewed, onViewed, onCite }: { file: DiffFile; mode: DiffMode; viewed: boolean; onViewed: (on: boolean) => void; onCite?: (citation: DiffCitation) => void }) {
  const [all, setAll] = useState(false)
  /** Las líneas marcadas para citar (índices de `lines`, en el diff unificado): clic en el número marca, Mayús+clic extiende. */
  const [marked, setMarked] = useState<{ from: number; to: number } | null>(null)
  // Un archivo visto queda plegado, como en GitHub; se puede abrir sin desmarcarlo.
  const [open, setOpen] = useState(!viewed)
  useEffect(() => setOpen(!viewed), [viewed])
  const language = useMemo(() => languageOf(file.path), [file.path])
  const lines = all ? file.lines : file.lines.slice(0, LINES_PER_FILE)
  const rows = useMemo(() => (mode === "split" ? splitRows(lines) : []), [mode, lines])
  const status = { added: "nuevo", deleted: "borrado", binary: "binario", modified: null }[file.status]
  const citable = onCite !== undefined && mode === "unified"
  const cite = (from: number, to: number) => {
    const picked = lines.slice(Math.min(from, to), Math.max(from, to) + 1).filter((l) => l.kind === "add" || l.kind === "del" || l.kind === "ctx")
    if (!onCite || picked.length === 0) return
    const numberOf = (l: DiffLine) => l.new ?? l.old ?? 0
    onCite({ path: file.path, start: numberOf(picked[0]!), end: numberOf(picked.at(-1)!), text: picked.map((l) => `${sign(l) || " "}${l.text}`).join("\n") })
    setMarked(null)
  }
  useEffect(() => {
    if (!citable || !marked) return
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.code !== "KeyK" || isTypingTarget(e.target)) return
      e.preventDefault()
      cite(marked.from, marked.to)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })
  return (
    <section className={cn("overflow-hidden rounded-lg border", viewed && "opacity-80")} aria-label={file.path}>
      <header className="flex items-center gap-2 border-b bg-muted/50 px-3 py-2 font-mono text-[12px]">
        <button type="button" onClick={() => setOpen((o) => !o)} className="truncate text-left hover:underline" aria-expanded={open}>
          {file.path}
        </button>
        {status ? <span className="rounded bg-muted px-1.5 text-muted-foreground">{status}</span> : null}
        <span className="ml-auto flex-none text-viz-3">+{file.additions}</span>
        <span className="flex-none text-destructive">−{file.deletions}</span>
        <label className="ml-2 flex flex-none items-center gap-1.5 font-sans text-xs text-muted-foreground">
          <Checkbox checked={viewed} onCheckedChange={(on) => onViewed(on === true)} aria-label={`Marcar ${file.path} como visto`} />
          {viewed ? <Check className="size-3.5" /> : null} Visto
        </label>
      </header>
      {!open ? null : file.status === "binary" ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">Archivo binario: no se muestra el cambio.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className={cn("w-full border-collapse font-mono text-[12px] leading-5", mode === "split" && "table-fixed")}>
            {mode === "split" ? (
              // Los dos lados siempre a la mitad, en todos los archivos.
              <colgroup>
                <col className="w-12" />
                <col className="w-4" />
                <col />
                <col className="w-12" />
                <col className="w-4" />
                <col />
              </colgroup>
            ) : null}
            <tbody>
              {mode === "unified"
                ? lines.map((line, i) => {
                    const on = marked !== null && i >= Math.min(marked.from, marked.to) && i <= Math.max(marked.from, marked.to)
                    const mark = (e: React.MouseEvent) => setMarked((current) => (e.shiftKey && current ? { from: current.from, to: i } : { from: i, to: i }))
                    const row = (
                    <tr key={i} data-kind={line.kind} data-marked={on || undefined} className={cn(LINE_TONE[line.kind], on && "outline outline-1 -outline-offset-1 outline-primary/60 bg-primary/10")}
                      onContextMenu={() => { if (citable && !on) setMarked({ from: i, to: i }) }}>
                      <td className={cn("w-12 select-none px-2 text-right text-muted-foreground/70", citable && "cursor-pointer hover:text-foreground")} onClick={citable ? mark : undefined} title={citable ? `Marcar para citar (Mayús+clic extiende, ${CITE_KEY} cita)` : undefined}>{line.old ?? ""}</td>
                      <td className={cn("w-12 select-none px-2 text-right text-muted-foreground/70", citable && "cursor-pointer hover:text-foreground")} onClick={citable ? mark : undefined}>{line.new ?? ""}</td>
                      <td className="w-4 select-none text-center text-muted-foreground">{sign(line)}</td>
                      <td className="pr-3 whitespace-pre">
                        <Code line={line} language={language} />
                      </td>
                    </tr>
                    )
                    return citable ? (
                      <ContextMenu key={i}>
                        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuItem onSelect={() => (marked ? cite(marked.from, marked.to) : cite(i, i))}>
                            Preguntar al clanker <ContextMenuShortcut>{CITE_KEY}</ContextMenuShortcut>
                          </ContextMenuItem>
                          {marked ? <ContextMenuItem onSelect={() => setMarked(null)}>Quitar la marca</ContextMenuItem> : null}
                        </ContextMenuContent>
                      </ContextMenu>
                    ) : row
                  })
                : rows.map((row, i) =>
                    row.kind === "full" ? (
                      <tr key={i} data-kind={row.line.kind} className={LINE_TONE[row.line.kind]}>
                        <td colSpan={6} className="px-3 whitespace-pre">
                          {row.line.text}
                        </td>
                      </tr>
                    ) : (
                      <tr key={i} data-kind="pair">
                        {([row.left, row.right] as const).map((line, side) => (
                          <SplitCell key={side} line={line} side={side === 0 ? "old" : "new"} language={language} />
                        ))}
                      </tr>
                    ),
                  )}
            </tbody>
          </table>
          {!all && file.lines.length > LINES_PER_FILE ? (
            <div className="border-t px-3 py-2">
              <Button variant="ghost" size="sm" onClick={() => setAll(true)}>
                Mostrar las {file.lines.length - LINES_PER_FILE} líneas que faltan
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}

/** Medio renglón del lado a lado: número, signo y código; sin línea de ese lado, una celda vacía. */
function SplitCell({ line, side, language }: { line: DiffLine | undefined; side: "old" | "new"; language: string | undefined }) {
  const tone = line ? LINE_TONE[line.kind] : "bg-muted/40"
  return (
    <>
      <td data-side={side} data-kind={line?.kind ?? "empty"} className={cn("select-none px-2 text-right align-top text-muted-foreground/70", tone, side === "new" && "border-l")}>
        {line ? (side === "old" ? line.old : line.new) : ""}
      </td>
      <td className={cn("select-none text-center align-top text-muted-foreground", tone)}>{sign(line)}</td>
      <td className={cn("pr-3 break-words whitespace-pre-wrap", tone)}>{line ? <Code line={line} language={language} /> : null}</td>
    </>
  )
}
