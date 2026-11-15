import { ExternalLink, FolderOpen, GitPullRequest } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import type { Member } from "@/types"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAppData } from "@/app-data"
import { useHost } from "@/host"
import { usePoll } from "@/hooks/use-poll"
import { absolute, clockSeconds, linearIssueUrl, tokens, tone, usd } from "@/lib/format"
import { cn } from "@/lib/utils"
import { MemberCard, Pill, SectionTitle, StatBar, Stepper } from "../common"

interface Props {
  slug: string
  issueId: string
  projectUrl: string | null
}

const GROUPS: { name: string; roles: string[] }[] = [
  { name: "1 · Implementa", roles: ["dev", "dev-escala"] },
  { name: "2 · Revisa", roles: ["review-bugs", "review-tests", "review-patterns", "review-lore"] },
  { name: "3 · Entrega", roles: ["committer", "bot-reviewer"] },
]

function groupState(ms: Member[]): { label: string; line: string; text: string } {
  const working = ms.filter((m) => m.status === "trabajando").length
  if (working) return { label: `${working} de ${ms.length} trabajando`, line: "border-primary", text: "text-primary" }
  if (ms.length && ms.every((m) => m.status === "listo")) return { label: "listo", line: "border-emerald-500/70", text: "text-emerald-600 dark:text-emerald-400" }
  if (ms.some((m) => m.status !== "en cola")) return { label: "en pausa", line: "border-amber-500/60", text: "text-amber-600 dark:text-amber-400" }
  return { label: "en cola", line: "border-border", text: "text-muted-foreground" }
}

const TOOL_TONE: Record<string, string> = {
  Read: "text-sky-600 dark:text-sky-400",
  Grep: "text-sky-600 dark:text-sky-400",
  Glob: "text-sky-600 dark:text-sky-400",
  Bash: "text-amber-700 dark:text-amber-300",
  Edit: "text-emerald-700 dark:text-emerald-400",
  Write: "text-emerald-700 dark:text-emerald-400",
  Agent: "text-violet-600 dark:text-violet-400",
  Handback: "text-violet-600 dark:text-violet-400",
}

export function IssueView({ slug, issueId, projectUrl }: Props) {
  const host = useHost()
  const appData = useAppData()
  const { data: d, error } = usePoll(() => appData.issue(slug, issueId), [slug, issueId])
  const [tab, setTab] = useState<string | null>(null)

  const tailRoles = useMemo(
    () => (d ? d.team.filter((m) => d.tails[m.role]?.length).map((m) => m.role) : []),
    [d],
  )
  const firstWorking = d?.team.find((m) => m.status === "trabajando")?.role
  useEffect(() => {
    if (!tab && d) setTab(firstWorking ?? tailRoles[0] ?? null)
  }, [d, tab, firstWorking, tailRoles])

  if (!d) {
    return error ? (
      <p className="text-[13px] text-destructive">{error}</p>
    ) : (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  const techlead = d.team.find((m) => m.role === "techlead")
  const others = d.team.filter((m) => m.role !== "techlead")
  const maxUsd = Math.max(0.01, ...d.team.map((m) => m.usd))
  const linear = linearIssueUrl(projectUrl, issueId)
  const worktree = d.slot?.worktree
  const tail = tab ? (d.tails[tab] ?? []) : []
  const profile = d.slot?.profile ?? d.history?.perfil
  const chips = [
    d.slot?.repo ? { text: d.slot.repo, hint: "Repo donde trabaja el slot" } : null,
    profile ? { text: `perfil ${profile}`, hint: "Perfil de modelos y effort del equipo (profiles.json de clanker-loop)" } : null,
    d.slot?.branch ? { text: d.slot.branch, hint: "Branch de la issue" } : null,
    d.slot?.base && d.slot.base !== "main" ? { text: `sobre ${d.slot.base}`, hint: `El PR va encima de ${d.slot.base}, no de main (stack)` } : null,
  ].filter((c): c is { text: string; hint: string } => !!c)

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-xs text-muted-foreground">{issueId}</span>
              {d.slot ? (
                <Pill className={tone.violet} hint={`Un equipo la está trabajando ahora en el slot ${d.slot.slot}`}>
                  slot {d.slot.slot} · en curso
                </Pill>
              ) : d.history ? (
                <Pill className={tone.neutral} hint="Estado que anotó el EM en el historial del state.md">
                  {d.history.estado}
                </Pill>
              ) : null}
              {chips.map((c) => (
                <Pill key={c.text} className="border text-muted-foreground" hint={c.hint}>
                  {c.text}
                </Pill>
              ))}
            </div>
            <h1 className="mt-1.5 text-xl font-semibold tracking-tight">{d.title ?? "sin título"}</h1>
            {worktree ? <p className="mt-0.5 truncate font-mono text-[11.5px] text-muted-foreground">{worktree}</p> : null}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {d.history?.prUrl ? (
              <Button size="sm" variant="secondary" onClick={() => host.openExternal(d.history!.prUrl!)}>
                <GitPullRequest /> {d.history.pr.split(" ")[0]}
              </Button>
            ) : null}
            {worktree ? (
              <Button size="sm" variant="ghost" onClick={() => host.openInEditor(worktree)}>
                <FolderOpen /> Worktree
              </Button>
            ) : null}
            {linear ? (
              <Button size="sm" variant="ghost" onClick={() => host.openExternal(linear)}>
                <ExternalLink /> Linear
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      <StatBar
        items={[
          { label: "Tiempo", value: d.minutes !== null ? `${d.minutes} min` : "—" },
          { label: "Costo", value: usd(d.usd) },
          { label: "Tokens", value: tokens(d.tokens) },
          { label: "Corridas de agentes", value: String(d.team.reduce((a, m) => a + m.runs, 0)) },
          { label: "Checkpoint", value: `${d.checkpoint.length} pasos` },
        ]}
      />

      <Stepper steps={d.steps} />

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-5">
          <section className="flex flex-col gap-2">
            <SectionTitle aside={`subagentes "${issueId} <rol>"`}>Equipo</SectionTitle>
            <div className="flex flex-col items-center">
              {techlead ? (
                <div className="w-full max-w-[420px]">
                  <MemberCard m={techlead} detailed />
                </div>
              ) : null}
              <div className="h-3 w-px bg-border" />
              <div className="flex w-full flex-wrap gap-3">
                {GROUPS.map((g) => {
                  const ms = others.filter((m) => g.roles.includes(m.role))
                  if (!ms.length) return null
                  const st = groupState(ms)
                  return (
                    <section
                      key={g.name}
                      className={cn("flex min-w-0 flex-col gap-2 border-t-2 pt-2", st.line, g.roles.length > 2 ? "flex-[3_1_420px]" : "flex-[1_1_210px]")}
                    >
                      <div className="flex justify-between gap-2 text-xs">
                        <span className="font-medium">{g.name}</span>
                        <span className={st.text}>{st.label}</span>
                      </div>
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(196px,1fr))] gap-1.5">
                        {ms.map((m) => (
                          <MemberCard key={m.role} m={m} detailed />
                        ))}
                      </div>
                    </section>
                  )
                })}
              </div>
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <SectionTitle aside={`issues/${issueId}.md`}>Checkpoint del techlead</SectionTitle>
            {d.checkpoint.length ? (
              <ol className="rounded-lg border bg-card">
                {d.checkpoint.map((c, i) => {
                  const last = i === d.checkpoint.length - 1 && !!d.slot
                  return (
                    <li key={`${c.step}-${i}`} className="grid grid-cols-[16px_minmax(0,1fr)] gap-2.5 border-t px-3.5 py-2.5 first:border-t-0">
                      <span className="pt-1">
                        <span className={cn("block size-2 rounded-full", last ? "cc-pulse bg-primary" : "bg-emerald-500")} />
                      </span>
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-[12.5px] font-medium">{c.step}</span>
                        <span className="text-[12.5px] break-words text-muted-foreground">{c.text}</span>
                      </div>
                    </li>
                  )
                })}
              </ol>
            ) : (
              <p className="rounded-lg border border-dashed px-3.5 py-3 text-[12.5px] text-muted-foreground">El techlead todavía no escribe su checkpoint.</p>
            )}
          </section>

          {d.decisions.length ? (
            <section className="flex flex-col gap-2">
              <SectionTitle count={d.decisions.length}>Decisiones a revisar</SectionTitle>
              <ul className="rounded-lg border bg-card">
                {d.decisions.map((x) => (
                  <li key={x.text} className="border-t px-3.5 py-2.5 text-[12.5px] first:border-t-0">
                    {x.pending ? (
                      <Pill className={cn("mr-2", tone.amber)} hint="Marcada PENDIENTE en el state: está esperando que la resuelvas tú">
                        pendiente
                      </Pill>
                    ) : null}
                    {x.pr ? <span className="mr-1.5 font-mono text-[11px] text-muted-foreground">{x.pr}</span> : null}
                    {x.text}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <aside className="flex min-w-0 flex-col gap-5">
          <section className="flex flex-col gap-2">
            <SectionTitle aside="últimas tool calls del transcript">En vivo</SectionTitle>
            <div className="overflow-hidden rounded-lg border bg-inset">
              {tailRoles.length ? (
                <>
                  <Tabs value={tab ?? undefined} onValueChange={setTab} className="border-b bg-card px-2 pt-1">
                    <TabsList variant="line" className="h-8 w-full justify-start overflow-x-auto">
                      {tailRoles.map((r) => {
                        const working = d.team.find((m) => m.role === r)?.status === "trabajando"
                        return (
                          <TabsTrigger key={r} value={r} className="flex-none gap-1.5 px-2 text-xs">
                            {working ? <span className="cc-pulse size-1.5 rounded-full bg-primary" /> : null}
                            {r}
                          </TabsTrigger>
                        )
                      })}
                    </TabsList>
                  </Tabs>
                  <ol className="flex max-h-[520px] flex-col overflow-y-auto py-1.5 font-mono text-[11.5px]">
                    {tail.map((t, i) => (
                      <li key={`${t.ts}-${i}`} className="grid grid-cols-[58px_84px_minmax(0,1fr)] items-baseline gap-2 px-3 py-1">
                        <time dateTime={t.ts} title={absolute(t.ts)} className="text-muted-foreground">
                          {t.ts ? clockSeconds(t.ts) : ""}
                        </time>
                        <span title={t.tool} className={cn("truncate", TOOL_TONE[t.tool] ?? "text-foreground/80")}>
                          {t.tool}
                        </span>
                        <span className="break-words text-foreground/85">{t.detail}</span>
                      </li>
                    ))}
                  </ol>
                </>
              ) : (
                <p className="p-3 text-[12.5px] text-muted-foreground">Sin transcripts para esta issue en las sesiones registradas.</p>
              )}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <SectionTitle aside={`${usd(d.usd)} · ${tokens(d.tokens)} tokens`}>Costo por rol</SectionTitle>
            <ul className="flex flex-col gap-2 rounded-lg border bg-card px-3.5 py-3">
              {[...d.team]
                .sort((a, b) => b.usd - a.usd)
                .map((m) => (
                  <li key={m.role} className="grid grid-cols-[108px_minmax(0,1fr)_52px] items-center gap-2.5 text-xs">
                    <span className="truncate text-foreground/80">{m.role}</span>
                    <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <span className="block h-full rounded-full bg-violet-500 dark:bg-violet-400" style={{ width: `${Math.round((m.usd / maxUsd) * 100)}%` }} />
                    </span>
                    <span className="text-right text-muted-foreground tabular-nums">{usd(m.usd)}</span>
                  </li>
                ))}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  )
}
