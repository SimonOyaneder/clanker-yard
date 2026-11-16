import { TriangleAlert } from "lucide-react"
import { useRef } from "react"
import type { LineIssue } from "@/lib/def-edit"
import { cn } from "@/lib/utils"

const LINE = 20 // px; la gutter y el texto comparten altura de línea para que cada marca caiga en su línea.

interface Props {
  value: string
  onChange: (value: string) => void
  /** Problemas ya ubicados en una línea (`lib/def-edit`): cada uno se marca en su línea y se lista debajo. */
  issues: readonly LineIssue[]
  label: string
  /** Ocupa el alto que le dé quien lo contiene, con scroll propio, en vez de crecer hasta 480 px. */
  fill?: boolean
}

/**
 * Editor de JSON sin dependencias: un textarea con números de línea y las líneas con problema marcadas.
 * No sabe de flujos ni de roles: quien lo usa valida y le pasa los problemas.
 */
export function JsonEditor({ value, onChange, issues, label, fill }: Props) {
  const area = useRef<HTMLTextAreaElement>(null)
  const count = value.split("\n").length
  const byLine = new Map<number, string[]>()
  for (const { line, message } of issues) byLine.set(line, [...(byLine.get(line) ?? []), message])

  const goTo = (line: number) => {
    const el = area.current
    if (!el) return
    const offset = value.split("\n").slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0)
    el.focus()
    el.setSelectionRange(offset, offset)
  }

  return (
    <div className={cn("flex min-h-0 flex-col gap-2", fill && "h-full")}>
      <div className={cn("overflow-auto rounded-lg border bg-muted/20 font-mono text-xs", fill ? "min-h-0 flex-1" : "max-h-[480px] min-h-40")}>
        <div className="relative flex min-w-max" style={{ lineHeight: `${LINE}px` }}>
          <ol aria-hidden className="sticky left-0 z-10 flex-none border-r bg-muted py-2 text-right text-muted-foreground tabular-nums select-none">
            {Array.from({ length: count }, (_, i) => (
              <li key={i} title={byLine.get(i + 1)?.join("\n")} className={cn("flex items-center justify-end gap-1 px-2", byLine.has(i + 1) && "bg-destructive/15 text-destructive")}>
                {byLine.has(i + 1) ? <TriangleAlert className="size-3" /> : null}
                {i + 1}
              </li>
            ))}
          </ol>
          <div className="relative flex-1">
            {[...byLine.keys()].map((line) => (
              <div key={line} aria-hidden className="pointer-events-none absolute inset-x-0 bg-destructive/10" style={{ top: 8 + (line - 1) * LINE, height: LINE }} />
            ))}
            <textarea
              ref={area}
              aria-label={label}
              aria-invalid={issues.length > 0}
              spellCheck={false}
              wrap="off"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              rows={count}
              className="relative block w-full resize-none overflow-hidden bg-transparent py-2 pr-4 pl-3 whitespace-pre outline-none"
              style={{ lineHeight: `${LINE}px`, minWidth: "60ch", height: count * LINE + 16 }}
            />
          </div>
        </div>
      </div>
      {issues.length > 0 ? (
        <ul aria-label="Problemas por arreglar" className="flex flex-col gap-1 text-[13px]">
          {issues.map((issue, i) => (
            <li key={i} className="flex gap-2 text-destructive">
              <button type="button" onClick={() => goTo(issue.line)} className="flex-none font-mono text-xs underline underline-offset-2">
                línea {issue.line}
              </button>
              <span className="min-w-0 text-pretty">{issue.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
