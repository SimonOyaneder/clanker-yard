import { useState } from "react"
import type { LoopSummary } from "@/types"
import { useAppData } from "@/app-data"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { usePoll } from "@/hooks/use-poll"
import { tokens, tone, usd } from "@/lib/format"
import { Pill, SectionTitle, StatBar } from "../common"

// Un solo tono para todas las series: cada gráfico tiene una sola medida.
const MARK = "bg-violet-500 dark:bg-violet-400"

function niceMax(x: number): number {
  if (x <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(x))
  const n = x / p
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p
}

function dayLabel(day: string): string {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number)
  return new Date(y, m - 1, d).toLocaleDateString("es-CL", { day: "numeric", month: "short" })
}

function hours(min: number): string {
  if (min < 60) return `${Math.round(min)} min`
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  return m ? `${h} h ${m} min` : `${h} h`
}

function dateRange(a: string | null, b: string | null): string {
  if (!a || !b) return ""
  const f = (s: string) => new Date(s).toLocaleDateString("es-CL", { day: "numeric", month: "short" })
  return f(a) === f(b) ? f(a) : `del ${f(a)} al ${f(b)}`
}

function Card({ title, aside, children }: { title: string; aside?: string; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4">
      <SectionTitle aside={aside}>{title}</SectionTitle>
      {children}
    </section>
  )
}

function DailyColumns({ days }: { days: LoopSummary["byDay"] }) {
  const [asTable, setAsTable] = useState(false)
  const max = niceMax(Math.max(...days.map((d) => d.usd), 0))
  const labelCaps = days.length <= 10
  if (!days.length) return <p className="text-[13px] text-muted-foreground">Todavía no hay issues registradas.</p>
  return (
    <div className="flex flex-col gap-2">
      <button type="button" onClick={() => setAsTable(!asTable)} className="w-fit self-end text-xs text-muted-foreground hover:text-foreground">
        {asTable ? "Ver gráfico" : "Ver tabla"}
      </button>
      {asTable ? (
        <table className="w-full text-[13px]">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="py-1 text-left font-normal">Día</th>
              <th className="py-1 text-right font-normal">Issues</th>
              <th className="py-1 text-right font-normal">Gasto</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {days.map((d) => (
              <tr key={d.day} className="border-t border-border/60">
                <td className="py-1.5">{dayLabel(d.day)}</td>
                <td className="py-1.5 text-right">{d.issues}</td>
                <td className="py-1.5 text-right">{usd(d.usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="grid grid-cols-[44px_minmax(0,1fr)] gap-2">
          <div className="relative h-48 text-right text-[11px] text-muted-foreground tabular-nums">
            <span className="absolute top-0 right-0 -translate-y-1/2">{usd(max).replace(".00", "")}</span>
            <span className="absolute top-1/2 right-0 -translate-y-1/2">{usd(max / 2).replace(".00", "")}</span>
            <span className="absolute right-0 bottom-0 translate-y-1/2">$0</span>
          </div>
          <div className="relative h-48">
            <div className="absolute inset-x-0 top-0 h-px bg-border" />
            <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
            <div className="absolute inset-x-0 bottom-0 h-px bg-foreground/25" />
            <div className="absolute inset-0 flex items-end justify-around gap-0.5">
              {days.map((d) => (
                <Tooltip key={d.day}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={`${dayLabel(d.day)}: ${usd(d.usd)}, ${d.issues} issues`}
                      className="group relative flex cursor-default h-full flex-1 items-end justify-center rounded-sm focus-visible:outline-1 focus-visible:outline-ring"
                    >
                      <span className={`block w-full max-w-6 rounded-t-[4px] ${MARK} group-hover:opacity-80`} style={{ height: `${(d.usd / max) * 100}%` }} />
                      {labelCaps ? (
                        <span
                          className="absolute text-[11px] text-foreground/80 tabular-nums"
                          style={{ bottom: `calc(${(d.usd / max) * 100}% + 4px)` }}
                        >
                          {usd(d.usd).replace(/\.\d+$/, "")}
                        </span>
                      ) : null}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <span className="font-medium">{usd(d.usd)}</span> · {d.issues} issues · {dayLabel(d.day)}
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>
          </div>
          <div />
          <div className="flex justify-around gap-0.5 text-[11px] text-muted-foreground">
            {days.map((d) => (
              <span key={d.day} className="flex-1 truncate text-center">
                {dayLabel(d.day)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function HBars({ rows }: { rows: { label: string; value: number; sub?: string }[] }) {
  const max = Math.max(...rows.map((r) => r.value), 0.01)
  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[112px_minmax(0,1fr)] items-center gap-3 text-xs">
          <span className="truncate text-foreground/80">{r.label}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" aria-label={`${r.label}: ${usd(r.value)}${r.sub ? `, ${r.sub}` : ""}`} className="flex min-w-0 cursor-default items-center gap-2 py-1">
                <span className={`block h-2.5 flex-none rounded-r-[4px] ${MARK}`} style={{ width: `${Math.max(1, (r.value / max) * 78)}%` }} />
                <span className="text-foreground/80 tabular-nums">{usd(r.value)}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <span className="font-medium">{usd(r.value)}</span> · {r.label}
              {r.sub ? ` · ${r.sub}` : ""}
            </TooltipContent>
          </Tooltip>
        </li>
      ))}
    </ul>
  )
}

export function SummaryView({ slug, onOpenIssue }: { slug: string; onOpenIssue: (id: string) => void }) {
  const appData = useAppData()
  const { data: s, error } = usePoll(() => appData.summary(slug), [slug], 5000)
  if (!s) return error ? <p className="text-sm text-destructive">{error}</p> : <Skeleton className="h-96 w-full" />

  const listo = s.results.find((r) => r.result === "listo")?.count ?? 0
  const otros = s.results.filter((r) => r.result !== "listo")
  const prsTotal = s.prs.abierto + s.prs.aprobado + s.prs.mergeado + s.prs.problema
  const tiles = [
    { label: "Gasto total", value: usd(s.totalUsd), sub: `equipos ${usd(s.teamsUsd)} · EM ${usd(s.emUsd)}` },
    {
      label: "Issues cerradas",
      value: String(s.issuesRecorded),
      sub: [`${listo} listas`, ...otros.map((r) => `${r.count} ${r.result}`)].join(" · "),
    },
    { label: "Costo por issue", value: usd(s.avgUsd), sub: s.avgMinutes !== null ? `${Math.round(s.avgMinutes)} min en promedio` : "" },
    { label: "PRs", value: String(prsTotal), sub: `${s.prs.mergeado} mergeados · ${s.prs.abierto + s.prs.aprobado} abiertos` },
    { label: "Tiempo de agentes", value: hours(s.agentMinutes), sub: dateRange(s.firstTs, s.lastTs) },
  ]
  const fmt1 = (n: number | null) => (n === null ? "—" : n.toFixed(1).replace(".", ","))

  return (
    <div className="flex flex-col gap-5">
      <StatBar items={tiles} />

      <div className="grid grid-cols-[repeat(auto-fit,minmax(420px,1fr))] gap-4">
        <Card title="Gasto por día" aside="equipos de cada issue, el día que se cerró">
          <DailyColumns days={s.byDay} />
        </Card>
        <Card title="Gasto por rol" aside={`${tokens(s.byRole.reduce((a, r) => a + r.tokens, 0))} tokens`}>
          <HBars rows={s.byRole.map((r) => ({ label: r.role, value: r.usd, sub: `${tokens(r.tokens)} tokens` }))} />
        </Card>
        <Card title="Calidad">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-[13px]">
            {[
              ["Rondas de review", `${fmt1(s.rounds.review)} por issue`],
              ["Rondas del bot", `${fmt1(s.rounds.bot)} por issue`],
              ["Hallazgos del bot", `${s.rounds.botValid} válidos · ${s.rounds.botFp} falsos positivos`],
              ["CI rojo", `${s.rounds.ciFails} veces`],
              ["Decisiones a revisar", `${s.decisions.pending} pendientes de ${s.decisions.total}`],
              ["Omitidas", String(s.omitted)],
            ].map(([k, v]) => (
              <div key={k} className="flex flex-col gap-0.5">
                <dt className="text-xs text-muted-foreground">{k}</dt>
                <dd className="tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <Card title="Gasto por modelo">
          <HBars rows={s.byModel.map((m) => ({ label: m.model, value: m.usd }))} />
        </Card>
      </div>

      <Card title="Issues más caras">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="py-1.5 text-left font-normal">Issue</th>
                <th className="py-1.5 text-left font-normal">Título</th>
                <th className="py-1.5 text-left font-normal">PR</th>
                <th className="py-1.5 text-right font-normal">Tiempo</th>
                <th className="py-1.5 text-right font-normal">Gasto</th>
                <th className="py-1.5 pl-3 text-left font-normal">Resultado</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {s.topIssues.map((t) => (
                <tr key={`${t.issueId}-${t.usd}`} className="border-t border-border/60">
                  <td className="py-2 pr-3">
                    <button type="button" onClick={() => onOpenIssue(t.issueId)} className="font-mono text-xs text-primary hover:underline">
                      {t.issueId}
                    </button>
                  </td>
                  <td className="max-w-[420px] truncate py-2 pr-3">{t.title ?? ""}</td>
                  <td className="py-2 pr-3 font-mono text-xs text-foreground/80">{t.pr ?? ""}</td>
                  <td className="py-2 text-right">{t.minutes !== null ? `${t.minutes} min` : "—"}</td>
                  <td className="py-2 text-right">{usd(t.usd)}</td>
                  <td className="py-2 pl-3">
                    <Pill
                      className={t.result === "listo" ? tone.green : tone.red}
                      hint={t.result === "listo" ? "El equipo terminó la issue y dejó su PR" : "El equipo no pudo terminar la issue"}
                    >
                      {t.result}
                    </Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
