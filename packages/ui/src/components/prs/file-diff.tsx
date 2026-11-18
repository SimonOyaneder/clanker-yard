import { Check } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { type DiffFile, type DiffLine, splitRows } from "@/lib/prs/diff"
import { highlightLine, languageOf } from "@/lib/prs/highlight"
import { cn } from "@/lib/utils"

/** Líneas que se dibujan de un archivo antes de pedir "Mostrar todo": un diff de miles de líneas congela la vista. */
const LINES_PER_FILE = 400

export type DiffMode = "unified" | "split"

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

export function FileDiff({ file, mode, viewed, onViewed }: { file: DiffFile; mode: DiffMode; viewed: boolean; onViewed: (on: boolean) => void }) {
  const [all, setAll] = useState(false)
  // Un archivo visto queda plegado, como en GitHub; se puede abrir sin desmarcarlo.
  const [open, setOpen] = useState(!viewed)
  useEffect(() => setOpen(!viewed), [viewed])
  const language = useMemo(() => languageOf(file.path), [file.path])
  const lines = all ? file.lines : file.lines.slice(0, LINES_PER_FILE)
  const rows = useMemo(() => (mode === "split" ? splitRows(lines) : []), [mode, lines])
  const status = { added: "nuevo", deleted: "borrado", binary: "binario", modified: null }[file.status]
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
                ? lines.map((line, i) => (
                    <tr key={i} data-kind={line.kind} className={LINE_TONE[line.kind]}>
                      <td className="w-12 select-none px-2 text-right text-muted-foreground/70">{line.old ?? ""}</td>
                      <td className="w-12 select-none px-2 text-right text-muted-foreground/70">{line.new ?? ""}</td>
                      <td className="w-4 select-none text-center text-muted-foreground">{sign(line)}</td>
                      <td className="pr-3 whitespace-pre">
                        <Code line={line} language={language} />
                      </td>
                    </tr>
                  ))
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
