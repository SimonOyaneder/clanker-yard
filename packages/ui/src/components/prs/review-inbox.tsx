import { CheckCheck, CircleDashed, Clock3, ExternalLink, GitPullRequest, GitPullRequestDraft, Inbox, PencilLine, RefreshCw } from "lucide-react"
import type { ReviewInboxRow, RunId } from "@clanker/api"
import { useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { RunView, type RunTab } from "@/components/run/run-view"
import type { StepTab } from "@/components/run/step-panel"
import { useAppData } from "@/app-data"
import { useLiveQuery } from "@/hooks/use-live"
import { RUN_TRIGGERS } from "@/lib/live-triggers"
import type { AppData } from "@/app-data"
import { Button } from "@/components/ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu"
import { RunStatusPill } from "@/components/project/status"
import { Pill } from "@/components/common"
import { absolute, tone } from "@/lib/format"
import { useAppActions } from "@/lib/app-context"

const reviewLook = {
  requested: { label: "Por revisar", color: tone.amber, icon: Clock3, hint: "GitHub espera tu revisión." },
  draft: { label: "Sin enviar", color: tone.sky, icon: PencilLine, hint: "Tu revisión está guardada como borrador en GitHub." },
  published: { label: "Publicada", color: tone.green, icon: CheckCheck, hint: "Ya enviaste tu revisión en GitHub." },
  none: { label: "Sin revisión", color: tone.neutral, icon: CircleDashed, hint: "No hay una revisión tuya ni una solicitud pendiente." },
}
const columns = "md:grid-cols-[minmax(0,1fr)_6rem_7.5rem_7rem]"

export function ReviewInbox({ inbox, error, reload }: { inbox?: Awaited<ReturnType<AppData["reviewInbox"]>>; error: string | null; reload(): void }) {
  const [selected, select] = useState<ReviewInboxRow | null>(null)
  const actions = useAppActions()
  const open = (row: ReviewInboxRow) => actions.openExternal(row.review === "draft" ? `${row.url}/files` : row.url)
  return <div className="mx-auto max-w-6xl space-y-5 p-4 md:p-6">
    <header className="flex items-start justify-between gap-4">
      <div><h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight"><Inbox className="size-5 text-muted-foreground" />Mis reviews</h1>
        <p className="mt-1 text-sm text-muted-foreground">PRs abiertos en los que te pidieron revisar.</p>
        {inbox?.checkedAt && <p className="mt-1 text-xs text-muted-foreground">Última sincronización: {absolute(inbox.checkedAt)} · En segundo plano</p>}</div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => actions.goModule("settings")}>Configurar reviews</Button>
        <Button variant="outline" size="sm" onClick={reload}><RefreshCw />Actualizar</Button>
      </div>
    </header>
    {error && <p role="alert" className="text-sm text-destructive">No se pudo actualizar la bandeja: {error}</p>}
    {!inbox ? !error && <p role="status">Consultando GitHub…</p> : !inbox.connected ?
      <Button variant="outline" onClick={actions.goConnections}>Conectar GitHub</Button> : !inbox.checkedAt ? <p role="status">Esperando la primera sincronización con GitHub.</p> : !inbox.rows.length ?
      <div className="grid justify-items-center gap-2 rounded-lg border border-dashed py-12 text-center">
        <Inbox className="size-6 text-muted-foreground" /><h2 className="text-sm font-medium">No tienes reviews asignadas en PRs abiertos</h2>
        <p className="text-sm text-muted-foreground">Cuando te pidan revisar un PR en GitHub, aparecerá aquí.</p></div> :
      [false, true].map(published => {
        const rows = inbox.rows.filter(row => (row.review === "published") === published)
        if (!rows.length) return null
        return <section key={String(published)} className="overflow-hidden rounded-lg border">
          <div className={`grid items-center gap-2 border-b bg-muted/50 px-4 py-2 text-xs text-muted-foreground ${columns}`}>
            <h2 className="flex items-center gap-2 font-semibold text-foreground">{published ? "Publicadas" : "Sin publicar"} <span className="rounded bg-background px-1.5 font-mono text-muted-foreground">{rows.length}</span></h2>
            <span className="hidden md:block">Pull request</span><span className="hidden md:block">Tu revisión</span><span className="hidden md:block">Flujo de Yard</span>
          </div>
          <ul className="divide-y">
            {rows.map(row => {
              const look = reviewLook[row.review]
              const PrIcon = row.isDraft ? GitPullRequestDraft : GitPullRequest
              return <li key={`${row.account}:${row.url}`}>
              <ContextMenu><ContextMenuTrigger asChild>
                <div className={`group flex w-full flex-wrap items-center gap-2 px-4 py-3 text-left hover:bg-accent/60 md:grid ${columns}`}>
                  <button onClick={() => open(row)} className="min-w-0 basis-full text-left hover:underline"><span className="block text-sm font-medium">{row.title} <ExternalLink className="inline size-3 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" /></span>
                    <span className="block text-xs text-muted-foreground">{row.repo}<span className="ml-1 font-mono">#{row.number}</span> · {row.account}</span></button>
                  <span><Pill className={row.isDraft ? tone.neutral : tone.green} hint={row.isDraft ? "El autor aún no marcó el PR como listo." : "El PR está abierto y listo para revisión."}><PrIcon className="size-3" />{row.isDraft ? "Draft" : "Abierto"}</Pill></span>
                  <span><Pill className={look.color} hint={look.hint}><look.icon className="size-3" />{look.label}</Pill></span>
                  <span className="text-xs text-muted-foreground"><span className="sr-only">Flujo de Yard: </span>
                    {row.run ? <RunStatusPill run={{ status: row.run, outcome: row.outcome }} /> : !inbox.enabledRepos.includes(row.repo) ? "Automatización desactivada" : row.scheduled ? <>
                      <Pill className={tone.sky} hint="Yard espera el próximo sondeo y un cupo de mantenimiento.">Programado</Pill>
                      {row.dueAt && <span className="mt-1 block">Desde {new Date(row.dueAt).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })}</span>}
                    </> : "Sin corrida"}
                    {row.runId && <button onClick={() => select(row)} aria-label={`Ver corrida de ${row.repo}#${row.number}`} className="mt-1 block font-medium text-foreground underline underline-offset-2">Ver corrida</button>}</span>
                </div>
              </ContextMenuTrigger><ContextMenuContent>{row.runId && <ContextMenuItem onSelect={() => select(row)}>Ver corrida</ContextMenuItem>}<ContextMenuItem onSelect={() => open(row)}>Abrir en GitHub</ContextMenuItem></ContextMenuContent></ContextMenu>
            </li>})}
          </ul>
        </section>
      })}
    <Dialog open={!!selected} onOpenChange={open => { if (!open) select(null) }}>
      {selected?.runId && <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[min(95vw,1200px)]">
        <DialogTitle>{selected.title}</DialogTitle>
        <DialogDescription>{selected.repo}#{selected.number} · Avance de la revisión</DialogDescription>
        <ReviewRun key={selected.runId} id={selected.runId} />
      </DialogContent>}
    </Dialog>
  </div>
}

function ReviewRun({ id }: { id: RunId }) {
  const data = useAppData()
  const query = useLiveQuery(`review-run:${id}`, () => data.run(id), { on: RUN_TRIGGERS })
  const [tab, setTab] = useState<RunTab>("timeline")
  const [node, setNode] = useState<string | null>(null)
  const [stepTab, setStepTab] = useState<StepTab>("transcript")
  if (query.error) return <div role="alert">{query.error} <Button onClick={query.reload}>Reintentar</Button></div>
  if (!query.data) return <p role="status">Cargando corrida…</p>
  return <RunView run={query.data} issue={undefined} tab={tab} onTabChange={setTab} node={node} onNodeChange={setNode} stepTab={stepTab} onStepTab={setStepTab} />
}
