import type { CachedIssue, CachedPr, IssueId, IssueRef, Run } from "@clanker/api"
import { ArrowUpRight, ChevronRight, GitPullRequest } from "lucide-react"
import { useAppData } from "@/app-data"
import { Ago, SectionTitle } from "@/components/common"
import { PageLoadError } from "@/components/page-load-error"
import { PlainMarkdown } from "@/components/prs/plain-markdown"
import { usePrActions } from "@/components/prs/pr-commands"
import { RunStatusIcon, RunStatusPill } from "@/components/project/status"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useLiveQuery } from "@/hooks/use-live"
import { useAppActions } from "@/lib/app-context"
import { issueKey } from "@/lib/format"
import { type OpenPr, titleOf } from "@/lib/prs/prs"

interface Props {
  id: IssueId
  slug: string
  issues: readonly CachedIssue[]
  openPrs: readonly OpenPr[]
  runs: readonly Run[]
}

export function IssueView({ id, slug, issues, runs, openPrs }: Props) {
  const data = useAppData()
  const actions = useAppActions()
  const query = useLiveQuery(`issue:${id}`, () => data.issue(id), { on: ["issue.*"] })
  const prsQuery = useLiveQuery(`issue-prs:${id}`, () => data.issuePrs(id), { on: ["pr.*"] })
  const issue = query.data
  if (!issue) return query.error
    ? <PageLoadError title="No pude abrir la issue" message={query.error} onRetry={query.reload} />
    : <Skeleton className="h-16 w-full max-w-xl" />

  const prs = (prsQuery.data ?? []).filter((pr) => pr.issueId === id)
  const relatedRuns = runs.filter((r) => r.projectId === issue.projectId && (r.subject.type === "issue" ? r.subject.id === id : prs.some((pr) => pr.id === r.subject.id)))
  const relations = [
    ...(issue.parent ? [{ label: "Issue padre", ref: issue.parent }] : []),
    ...issue.relations.blockedBy.map((ref) => ({ label: "Bloqueada por", ref })),
    ...issue.relations.blocks.map((ref) => ({ label: "Bloquea a", ref })),
    ...issue.relations.related.map((ref) => ({ label: "Relacionada con", ref })),
  ]
  return (
    <article className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span className="font-mono">{issueKey(issue)}</span><span aria-hidden>·</span><span>{issue.rawStatus}</span>
          {issue.ref.tracker !== "local" ? (
            <Button size="xs" variant="ghost" className="ml-auto" onClick={() => actions.openExternal(issue.ref.url)}>
              Abrir en {issue.ref.tracker === "linear" ? "Linear" : issue.ref.tracker}<ArrowUpRight />
            </Button>
          ) : null}
        </div>
        <h1 className="text-xl font-semibold tracking-tight">{issue.title}</h1>
      </header>
      {prsQuery.error ? <PageLoadError title="No pude leer los PRs" message={prsQuery.error} onRetry={prsQuery.reload} /> : !prsQuery.data ? <Skeleton className="h-10 w-full" /> : null}
      {prs.length > 0 ? (
        <section>
          <SectionTitle count={prs.length}>Pull requests</SectionTitle>
          <ul className="mt-1 divide-y rounded-lg border bg-card">
            {prs.map((pr) => <li key={pr.id}><IssuePrRow pr={pr} openPr={openPrs.find((p) => p.id === pr.id)} /></li>)}
          </ul>
        </section>
      ) : null}
      {relatedRuns.length > 0 ? (
        <section>
          <SectionTitle count={relatedRuns.length}>Corridas</SectionTitle>
          <ul className="mt-1 divide-y rounded-lg border bg-card">
            {relatedRuns.map((run) => (
              <li key={run.id}>
                <Button variant="ghost" className="h-auto w-full justify-start py-2.5 text-left" onClick={() => actions.openRun(slug, run.id)}>
                  <RunStatusIcon run={run} />
                  <span className="min-w-0 flex-1 truncate">{run.flow.slug}</span>
                  <Ago at={run.startedAt} className="text-xs font-normal text-muted-foreground" />
                  <RunStatusPill run={run} /><ChevronRight className="size-3 text-muted-foreground" />
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {relations.length ? (
        <section>
          <SectionTitle>Issues vinculadas</SectionTitle>
          <ul className="mt-1 divide-y rounded-lg border bg-card">
            {relations.map(({ label, ref }) => (
              <li key={`${label}-${ref.tracker}-${ref.id}`}>
                <RelatedIssue label={label} target={ref} cached={issues.find((i) => i.ref.tracker === ref.tracker && i.ref.id === ref.id)} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {issue.body.trim() ? <section className="break-words"><SectionTitle>Descripción</SectionTitle><PlainMarkdown source={issue.body} /></section> : null}
      {!issue.body.trim() && !relations.length && !relatedRuns.length && prsQuery.data && !prs.length ? (
        <p className="text-sm text-muted-foreground">Cuando se inicie una corrida o se vincule un PR, aparecerá aquí.</p>
      ) : null}
    </article>
  )
}

function RelatedIssue({ label, target, cached }: { label: string; target: IssueRef; cached: CachedIssue | undefined }) {
  const actions = useAppActions()
  const text = <><span className="text-xs font-normal text-muted-foreground">{label}</span><span className="font-mono text-xs">{issueKey({ ref: target })}</span></>
  if (!cached && target.tracker === "local") return <span className="flex items-center gap-2 px-4 py-2">{text}</span>
  return (
    <Button variant="ghost" className="h-auto w-full justify-start py-2.5" onClick={() => cached ? actions.openIssue(cached) : actions.openExternal(target.url)}>
      {text}<span className="min-w-0 flex-1 truncate text-left">{cached?.title}</span>
      {cached ? <ChevronRight className="size-3" /> : <ArrowUpRight className="size-3" />}
    </Button>
  )
}

function IssuePrRow({ pr, openPr }: { pr: CachedPr; openPr: OpenPr | undefined }) {
  const commands = usePrActions()
  const actions = useAppActions()
  const label = pr.ref ? `${pr.repo}#${pr.ref.number}` : pr.local?.branch
  const url = pr.ref ? (pr.state?.url ?? `https://github.com/${pr.ref.repo}/pull/${pr.ref.number}`) : null
  return (
    <Button variant="ghost" className="h-auto w-full justify-start py-2.5 text-left" disabled={!openPr && !url} onClick={() => openPr ? commands.view(openPr) : url && actions.openExternal(url)}>
      <GitPullRequest className="text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{openPr ? titleOf(openPr) : pr.state?.title ?? pr.local?.title ?? label}</span>
        {(openPr || pr.state?.title || pr.local?.title) ? <span className="truncate font-mono text-xs font-normal text-muted-foreground">{label}</span> : null}
      </span>
      {openPr || pr.local ? <ChevronRight className="size-3" /> : <span className="flex items-center gap-1 text-xs text-muted-foreground">GitHub<ArrowUpRight /></span>}
    </Button>
  )
}
