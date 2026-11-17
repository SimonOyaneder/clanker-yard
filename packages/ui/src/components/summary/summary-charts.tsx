import type { ReactNode } from "react"
import { Table2 } from "lucide-react"
import { Hint, SectionTitle } from "@/components/common"
import { Button } from "@/components/ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { copy } from "@/lib/clipboard"
import { costUsd } from "@/lib/format"
import { axisUsd, dayLabel, fillDays, niceMax } from "@/lib/summary"
import { cn } from "@/lib/utils"

/** Los mismos datos de un gráfico como tabla: la vista accesible y lo que copia el menú contextual. */
export interface ChartTable {
  head: string[]
  rows: string[][]
}

interface CardProps {
  title: string
  aside?: ReactNode
  /** Con `null` se dibuja el gráfico; si no, esto es lo que dice por qué no hay nada y qué hacer. */
  empty?: ReactNode
  table: ChartTable
  asTable: boolean
  onToggleTable: () => void
  children: ReactNode
}

// Una tarjeta de gráfico: el gráfico o, con T, su tabla. Clic derecho: cambiar de vista o copiar los datos.
export function ChartCard({ title, aside, empty, table, asTable, onToggleTable, children }: CardProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <section aria-label={title} className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4">
          <SectionTitle
            aside={
              <span className="flex items-center gap-2">
                {aside}
                {empty ? null : (
                  <Hint label={asTable ? "Volver a los gráficos" : "Ver los datos de los gráficos como tablas"} keys="T">
                    <Button size="icon-xs" variant="ghost" aria-label={asTable ? "Ver gráfico" : "Ver tabla"} aria-pressed={asTable} onClick={onToggleTable}>
                      <Table2 />
                    </Button>
                  </Hint>
                )}
              </span>
            }
          >
            {title}
          </SectionTitle>
          {empty ? <p className="text-[13px] text-muted-foreground">{empty}</p> : asTable ? <DataTable table={table} /> : children}
        </section>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onToggleTable}>{asTable ? "Ver gráfico" : "Ver tabla"}</ContextMenuItem>
        <ContextMenuItem disabled={!!empty} onSelect={() => copy([table.head, ...table.rows].map((r) => r.join("\t")).join("\n"), `los datos de "${title}"`)}>
          Copiar datos
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function DataTable({ table }: { table: ChartTable }) {
  return (
    <Table className="text-[13px]">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {table.head.map((h, i) => (
            <TableHead key={h} className={cn("h-7 px-0 text-xs font-normal text-muted-foreground", i > 0 && "text-right")}>
              {h}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody className="tabular-nums">
        {table.rows.map((row) => (
          <TableRow key={row[0]}>
            {row.map((cell, i) => (
              <TableCell key={`${row[0]}-${table.head[i]}`} className={cn("px-0 py-1.5", i > 0 && "text-right")}>
                {cell}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

interface DayPoint {
  day: string
  costMicros: number
  runs: number
}

// El gasto de cada día de cierre, de corrido (los días sin cierres valen cero): una sola medida y una sola escala.
export function DayColumns({ days }: { days: readonly DayPoint[] }) {
  const filled = fillDays(days, (day) => ({ day, costMicros: 0, runs: 0 }))
  const max = niceMax(Math.max(...filled.map((d) => d.costMicros)) / 1_000_000) * 1_000_000
  const labelValues = filled.length <= 10
  const labelEvery = Math.ceil(filled.length / 8)
  return (
    <div className="grid grid-cols-[44px_minmax(0,1fr)] gap-x-2 gap-y-1">
      <div className="relative h-44 text-right text-[11px] text-muted-foreground tabular-nums" aria-hidden>
        <span className="absolute top-0 right-0 -translate-y-1/2">{axisUsd(max)}</span>
        <span className="absolute top-1/2 right-0 -translate-y-1/2">{axisUsd(max / 2)}</span>
        <span className="absolute right-0 bottom-0 translate-y-1/2">$0</span>
      </div>
      <div className="relative h-44">
        <div className="absolute inset-x-0 top-0 h-px bg-border" />
        <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
        <div className="absolute inset-x-0 bottom-0 h-px bg-foreground/25" />
        <div className="absolute inset-0 flex items-end gap-0.5">
          {filled.map((d) => (
            <Tooltip key={d.day}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`${dayLabel(d.day)}: ${costUsd(d.costMicros)}, ${d.runs} ${d.runs === 1 ? "corrida" : "corridas"}`}
                  className="group relative flex h-full min-w-0 flex-1 cursor-default items-end justify-center rounded-sm focus-visible:outline-1 focus-visible:outline-ring"
                >
                  <span className="block w-full max-w-7 rounded-t-[4px] bg-viz-measure group-hover:opacity-80" style={{ height: `${(d.costMicros / max) * 100}%` }} />
                  {labelValues && d.costMicros > 0 ? (
                    <span className="absolute text-[11px] text-foreground/80 tabular-nums" style={{ bottom: `calc(${(d.costMicros / max) * 100}% + 4px)` }}>
                      {axisUsd(d.costMicros)}
                    </span>
                  ) : null}
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <span className="font-medium">{costUsd(d.costMicros)}</span> · {d.runs} {d.runs === 1 ? "corrida" : "corridas"} · {dayLabel(d.day)}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      </div>
      <div />
      <div className="flex gap-0.5 text-[11px] text-muted-foreground" aria-hidden>
        {filled.map((d, i) => (
          <span key={d.day} className="min-w-0 flex-1 text-center whitespace-nowrap">
            {i % labelEvery === 0 ? dayLabel(d.day) : ""}
          </span>
        ))}
      </div>
    </div>
  )
}

export interface BarRow {
  key: string
  label: string
  costMicros: number
  /** Clase `bg-*` de la marca; sin ella, la medida del gráfico. Solo un gráfico con categorías fijas (los roles) la pasa. */
  color?: string
  /** Lo que el tooltip suma al costo: "1,2 M tokens". */
  detail?: string
}

// Barras horizontales de más a menos, todas sobre una misma escala. Con `color` cada fila lleva su muestra de color.
export function RankedBars({ rows }: { rows: readonly BarRow[] }) {
  const max = Math.max(...rows.map((r) => r.costMicros), 1)
  return (
    <ul className="flex flex-col gap-1.5">
      {rows.map((r) => (
        <li key={r.key}>
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                tabIndex={0}
                role="img"
                aria-label={`${r.label}: ${costUsd(r.costMicros)}${r.detail ? `, ${r.detail}` : ""}`}
                className="grid cursor-default grid-cols-[minmax(80px,132px)_minmax(0,1fr)_auto] items-center gap-3 rounded-sm py-0.5 text-xs focus-visible:outline-1 focus-visible:outline-ring"
              >
                <span className="flex min-w-0 items-center gap-2 text-foreground/80">
                  {r.color ? <span className={cn("size-2 flex-none rounded-[2px]", r.color)} /> : null}
                  <span className="truncate">{r.label}</span>
                </span>
                <span className="flex h-2.5 items-center">
                  <span className={cn("block h-full rounded-r-[4px]", r.color ?? "bg-viz-measure")} style={{ width: `${Math.max(1, (r.costMicros / max) * 100)}%` }} />
                </span>
                <span className="text-right text-foreground/80 tabular-nums">{costUsd(r.costMicros)}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <span className="font-medium">{costUsd(r.costMicros)}</span> · {r.label}
              {r.detail ? ` · ${r.detail}` : ""}
            </TooltipContent>
          </Tooltip>
        </li>
      ))}
    </ul>
  )
}
