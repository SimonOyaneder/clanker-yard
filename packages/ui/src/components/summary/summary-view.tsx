import type { CachedIssue, ClankerProject } from "@clanker/api"
import { useState } from "react"
import { BarChart3, ExternalLink } from "lucide-react"
import { type ProjectMetrics, useAppData } from "@/app-data"
import { Hint, SectionTitle, Shortcut, StatBar } from "@/components/common"
import { type BarRow, ChartCard, DayColumns, RankedBars } from "@/components/summary/summary-charts"
import { Button } from "@/components/ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useLiveQuery } from "@/hooks/use-live"
import type { SummaryControls } from "@/hooks/use-summary-controls"
import { useAppActions } from "@/lib/app-context"
import { copy } from "@/lib/clipboard"
import { compactCount, costUsd, issueKey } from "@/lib/format"
import {
  decimal,
  issueRoundsRows,
  metricsRange,
  ORIGIN_LABELS,
  ORIGINS,
  type Origin,
  RANGE_LABELS,
  RANGE_PRESETS,
  type RangePreset,
  rangeKey,
  roleColor,
  stepRows,
  summaryTiles,
} from "@/lib/summary"
import { PageLoadError } from "@/components/page-load-error"

const ORIGIN_HINTS: Record<Origin, string> = {
  all: "Las corridas de Yard y las que trajo la importación del clanker-loop.",
  imported: "Solo las que trajo `clanker import legacy` del clanker-loop: traen costo por rol y rondas, no pasos.",
  yard: "Solo las que corrió Clanker Yard.",
}

interface TabProps {
  project: ClankerProject
  controls: SummaryControls
  onOpenOperation: () => void
}

// La pestaña Resumen: pide al core las métricas del proyecto acotadas por el rango y el origen elegidos.
export function ProjectSummaryTab({ project, controls, onOpenOperation }: TabProps) {
  const appData = useAppData()
  const { range, origin } = controls
  const query = useLiveQuery(`summary:${project.id}:${rangeKey(range, origin)}`, () => appData.projectMetrics(project.id, metricsRange(range, origin, Date.now())), { on: ["run.finished"] })
  // Las issues solo le ponen título a las filas de rondas por issue: sin ellas se muestra el id.
  const issues = useLiveQuery(`summary-issues:${project.id}`, () => appData.issues(project.id), { on: ["issue.*"] })
  return (
    <div className="flex flex-col gap-5">
      <SummaryToolbar controls={controls} />
      {query.data ? (
        <SummaryView metrics={query.data} issues={issues.data ?? []} controls={controls} onOpenOperation={onOpenOperation} />
      ) : query.error ? (
        <PageLoadError title="No pude leer las métricas" message={query.error} onRetry={query.reload} />
      ) : (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      )}
    </div>
  )
}

function SummaryToolbar({ controls }: { controls: SummaryControls }) {
  const { range, origin } = controls
  return (
    <div role="toolbar" aria-label="Filtros del resumen" className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex items-center gap-2">
        <Hint label="Cuenta las corridas por el día en que cerraron" keys="F">
          <span className="text-xs text-muted-foreground">Rango</span>
        </Hint>
        <Select value={range.preset} onValueChange={(v) => controls.setPreset(v as RangePreset)}>
          <SelectTrigger size="sm" aria-label="Rango de fechas" className="w-44 text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RANGE_PRESETS.map((p) => (
              <SelectItem key={p} value={p}>
                {RANGE_LABELS[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {range.preset === "custom" ? (
          <>
            <Input type="date" aria-label="Desde" value={range.from} max={range.to || undefined} onChange={(e) => controls.setRange({ ...range, from: e.target.value })} className="h-8 w-36 text-[13px]" />
            <span className="text-xs text-muted-foreground">a</span>
            <Input type="date" aria-label="Hasta" value={range.to} min={range.from || undefined} onChange={(e) => controls.setRange({ ...range, to: e.target.value })} className="h-8 w-36 text-[13px]" />
          </>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Origen</span>
        <ToggleGroup type="single" variant="outline" size="sm" value={origin} onValueChange={(v) => v && controls.setOrigin(v as Origin)} aria-label="Origen de las corridas">
          {ORIGINS.map((o) => (
            <Hint key={o} label={ORIGIN_HINTS[o]}>
              <ToggleGroupItem value={o} className="h-8 px-3 text-[13px]">
                {ORIGIN_LABELS[o]}
              </ToggleGroupItem>
            </Hint>
          ))}
        </ToggleGroup>
        <Shortcut keys="O" />
      </div>
    </div>
  )
}

interface ViewProps {
  metrics: ProjectMetrics
  issues: CachedIssue[]
  controls: SummaryControls
  onOpenOperation: () => void
}

const ROUND_ROWS = 8

// El Resumen: tarjetas con los totales de `projects.summary` y cortes por día, rol, paso del flujo, modelo e issue.
export function SummaryView({ metrics, issues, controls, onOpenOperation }: ViewProps) {
  const { summary, byDay, byModel, byStep, roles } = metrics
  const { asTables, toggleTables } = controls

  if (summary.runs === 0) {
    const narrowed = controls.range.preset !== "all" || controls.origin !== "all"
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center">
        <BarChart3 className="size-5 text-muted-foreground" />
        <p className="max-w-md text-[13px] text-muted-foreground">
          {narrowed
            ? "No cerró ninguna corrida con este rango y este origen. Amplía el rango o cambia el origen para ver el gasto."
            : "Este proyecto todavía no cerró ninguna corrida. Cuando una termine, aquí aparece cuánto costó y cuántas vueltas dio."}
        </p>
        {narrowed ? (
          <Button size="sm" onClick={() => (controls.setRange({ preset: "all", from: "", to: "" }), controls.setOrigin("all"))}>
            Ver todo el historial
          </Button>
        ) : (
          <Button size="sm" onClick={onOpenOperation}>
            Ir a Operación
          </Button>
        )}
      </div>
    )
  }

  const tokens = summary.byRole.reduce((sum, r) => sum + r.tokens, 0)
  const roleRows: BarRow[] = summary.byRole.map((r) => ({ key: r.role, label: r.role, costMicros: r.costMicros, color: roleColor(roles, r.role), detail: `${compactCount(r.tokens)} tokens · ${r.runs} ${r.runs === 1 ? "corrida" : "corridas"}` }))
  const steps = stepRows(byStep)
  const card = { asTable: asTables, onToggleTable: toggleTables }

  return (
    <div className="flex flex-col gap-5">
      <StatBar items={summaryTiles(summary)} />

      <div className="grid grid-cols-[repeat(auto-fit,minmax(420px,1fr))] gap-4">
        <ChartCard
          title="Gasto por día"
          aside="el día en que cerró cada corrida"
          table={{ head: ["Día", "Corridas", "Gasto"], rows: byDay.map((d) => [d.day, String(d.runs), costUsd(d.costMicros)]) }}
          {...card}
        >
          <DayColumns days={byDay} />
        </ChartCard>
        <ChartCard
          title="Gasto por rol"
          aside={`${compactCount(tokens)} tokens`}
          table={{ head: ["Rol", "Tokens", "Gasto"], rows: summary.byRole.map((r) => [r.role, compactCount(r.tokens), costUsd(r.costMicros)]) }}
          {...card}
        >
          <RankedBars rows={roleRows} />
        </ChartCard>
        <ChartCard
          title="Gasto por paso del flujo"
          aside="todas las visitas del paso"
          empty={steps.length ? null : "Las corridas importadas del clanker-loop no guardan sus pasos: este corte sale solo de corridas de Yard. Cambia el origen a Yard o a Todas para ver el gasto de cada paso."}
          table={{ head: ["Paso", "Visitas", "Gasto"], rows: steps.map((s) => [s.label, String(s.steps), costUsd(s.costMicros)]) }}
          {...card}
        >
          <RankedBars rows={steps.map((s) => ({ key: s.key, label: s.label, costMicros: s.costMicros, detail: `${s.steps} ${s.steps === 1 ? "visita" : "visitas"}` }))} />
        </ChartCard>
        <ChartCard
          title="Gasto por modelo"
          table={{ head: ["Modelo", "Tokens", "Gasto"], rows: byModel.map((m) => [m.model, compactCount(m.tokens), costUsd(m.costMicros)]) }}
          {...card}
        >
          <RankedBars rows={byModel.map((m) => ({ key: m.model, label: m.model, costMicros: m.costMicros, detail: `${compactCount(m.tokens)} tokens` }))} />
        </ChartCard>
        <RoundsCard summary={summary} />
      </div>

      <IssueRounds metrics={metrics} issues={issues} />
    </div>
  )
}

// Cuántas vueltas dio cada contador del flujo: lo que tardan en converger los reviews, el bot y el CI.
function RoundsCard({ summary }: { summary: ProjectMetrics["summary"] }) {
  return (
    <section aria-label="Rondas por corrida" className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4">
      <SectionTitle aside="promedio por corrida raíz">Rondas por corrida</SectionTitle>
      {summary.rounds.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">Ninguna corrida dio rondas en este rango: los contadores del flujo (reviews, bot, CI) no subieron.</p>
      ) : (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-[13px]">
          {summary.rounds.map((r) => (
            <div key={r.counter} className="flex flex-col gap-0.5">
              <dt className="text-xs text-muted-foreground">{r.counter}</dt>
              <dd className="tabular-nums">
                {decimal(r.perRun)} por corrida <span className="text-muted-foreground">· {r.total} en total</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}

// Las issues que más vueltas dieron, con lo que costaron. Clic derecho: copiar su ID o abrirla en el tracker.
function IssueRounds({ metrics, issues }: { metrics: ProjectMetrics; issues: CachedIssue[] }) {
  const actions = useAppActions()
  const [all, setAll] = useState(false)
  const rows = issueRoundsRows(metrics.byIssue, issues)
  const shown = all ? rows : rows.slice(0, ROUND_ROWS)
  const max = Math.max(...rows.map((r) => r.totalRounds), 1)
  return (
    <section aria-label="Rondas por issue" className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4">
      <SectionTitle
        count={rows.length}
        aside={
          rows.length > ROUND_ROWS ? (
            <Button size="xs" variant="ghost" onClick={() => setAll(!all)}>
              {all ? `Ver las ${ROUND_ROWS} con más vueltas` : `Ver las ${rows.length}`}
            </Button>
          ) : undefined
        }
      >
        Rondas por issue
      </SectionTitle>
      <Table className="min-w-[640px] text-[13px]">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="h-7 px-0 text-xs font-normal text-muted-foreground">Issue</TableHead>
            <TableHead className="h-7 text-right text-xs font-normal text-muted-foreground">Corridas</TableHead>
            <TableHead className="h-7 w-[34%] pl-6 text-xs font-normal text-muted-foreground">Rondas</TableHead>
            <TableHead className="h-7 px-0 text-right text-xs font-normal text-muted-foreground">Gasto</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="tabular-nums">
          {shown.map((r) => {
            const issue = r.issue
            const key = issue ? issueKey(issue) : r.issueId
            const detail = Object.entries(r.rounds).map(([counter, n]) => `${counter} ${n}`).join(" · ")
            return (
              <ContextMenu key={r.issueId}>
                <ContextMenuTrigger asChild>
                  <TableRow>
                    <TableCell className="max-w-[360px] px-0 py-2">
                      <div className="flex min-w-0 items-baseline gap-2">
                        {issue ? <Button size="xs" variant="link" className="px-0 font-mono" onClick={() => actions.openIssue(issue)}>{key}</Button> : <span className="font-mono text-xs">{key}</span>}
                        <span className="truncate">{r.issue?.title ?? "issue fuera del caché"}</span>
                      </div>
                    </TableCell>
                    <TableCell className="py-2 text-right">{r.runs}</TableCell>
                    <TableCell className="py-2 pl-6">
                      <div className="flex items-center gap-3">
                        <span className="w-5 flex-none text-right">{r.totalRounds}</span>
                        <span className="flex h-2 min-w-0 flex-1 items-center" aria-hidden>
                          <span className="block h-full rounded-r-[4px] bg-viz-measure" style={{ width: `${Math.max(r.totalRounds ? 4 : 0, (r.totalRounds / max) * 100)}%` }} />
                        </span>
                        <span className="w-44 flex-none truncate text-xs text-muted-foreground">{detail || "sin rondas"}</span>
                      </div>
                    </TableCell>
                    <TableCell className="px-0 py-2 text-right">{costUsd(r.costMicros)}</TableCell>
                  </TableRow>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onSelect={() => copy(key, "el ID de la issue")}>Copiar ID</ContextMenuItem>
                  <ContextMenuItem disabled={!r.issue} onSelect={() => r.issue && actions.openExternal(r.issue.ref.url)}>
                    <ExternalLink /> Abrir en el tracker
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            )
          })}
        </TableBody>
      </Table>
    </section>
  )
}
