import type { ChatProposal, RunDetail } from "@clanker/api"
import { useId } from "react"
import { Hint, Pill } from "@/components/common"
import { Button } from "@/components/ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuShortcut, ContextMenuTrigger } from "@/components/ui/context-menu"

export interface ProposalCardProps {
  proposal: ChatProposal
  canApply: boolean
  applyReason?: string
  busy: boolean
  pending: boolean
  childNames?: ReadonlyMap<string, string>
  /** La corrida que la aplica, mientras está `applying`. */
  run?: RunDetail | null
  onView: () => void
  onApply: () => void
  onDiscard: () => void
  /** "Rehacer sobre el PR actual" de una propuesta `stale`: le pide al agente que la rehaga. */
  onRedo?: () => void
  /** Abre la corrida que la aplica. */
  onOpenRun?: (runId: string) => void
}

/** Cómo se llama cada paso de las corridas de aplicar, en el orden en que corren. */
const APPLY_STEPS: Record<string, string> = {
  ws: "Tomar el worktree del PR",
  apply: "Aplicar el diff",
  checks: "Checks de la receta",
  fix: "Arreglar los checks",
  fixups: "Fixups y push",
  route: "Ubicar los cambios en sus commits",
  restack: "Restackear los hijos",
  state: "Ver si el PR pide review",
  feedback: "Review del bot",
}

const STATUS: Record<ChatProposal["status"], { label: string; hint: string; className: string }> = {
  draft: { label: "Por aplicar", hint: "Los cambios aún no se han aplicado. Revisa el diff antes de aplicar.", className: "bg-muted text-muted-foreground" },
  applying: { label: "Aplicando", hint: "La propuesta se está aplicando. Espera el resultado.", className: "bg-primary/10 text-primary" },
  applied: { label: "Aplicada", hint: "Los cambios se aplicaron al PR. El resultado de sus hijos se muestra por separado.", className: "bg-viz-3/10 text-viz-3" },
  discarded: { label: "Descartada", hint: "Esta propuesta se descartó y ya no se puede aplicar. Puedes seguir consultando sus cambios.", className: "bg-muted text-muted-foreground" },
  stale: { label: "Desactualizada", hint: "El PR cambió desde que se preparó esta propuesta. Pide una nueva propuesta antes de aplicar.", className: "bg-viz-4/10 text-viz-4" },
  failed: { label: "Falló", hint: "No se pudo completar la aplicación. Revisa el resultado y pide una nueva propuesta.", className: "bg-destructive/10 text-destructive" },
}

export function proposalApplyReason({ proposal, canApply, applyReason, busy, pending }: Pick<ProposalCardProps, "proposal" | "canApply" | "applyReason" | "busy" | "pending">): string | null {
  if (pending) return "Hay una operación pendiente. Espera a que termine."
  if (busy) return "El agente está trabajando. Espera a que termine."
  if (proposal.status !== "draft") return STATUS[proposal.status].hint
  if (!canApply) return applyReason || "No se puede aplicar esta propuesta al PR en su estado actual."
  return null
}

export function proposalDiscardReason({ proposal, busy, pending }: Pick<ProposalCardProps, "proposal" | "busy" | "pending">): string | null {
  if (pending) return "Hay una operación pendiente. Espera a que termine."
  if (busy) return "El agente está trabajando. Espera a que termine."
  if (proposal.status !== "draft" && proposal.status !== "stale" && proposal.status !== "failed") return STATUS[proposal.status].hint
  return null
}

function ProposalAction({ label, hint, keys, reason, onClick, primary = false }: { label: string; hint: string; keys: string; reason: string | null; onClick: () => void; primary?: boolean }) {
  const descriptionId = useId()
  const button = <Button type="button" size="sm" variant={primary ? "default" : "outline"} disabled={reason !== null} aria-describedby={reason ? descriptionId : undefined} onClick={onClick}>{label}</Button>
  return (
    <>
      <Hint label={reason ?? hint} keys={keys}>
        {reason ? (
          <span role="group" aria-label={label} aria-disabled="true" tabIndex={0} className="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {button}
          </span>
        ) : button}
      </Hint>
      {reason ? <span id={descriptionId} className="sr-only">{reason}</span> : null}
    </>
  )
}

export function ChatProposalCard(props: ProposalCardProps) {
  const { proposal, pending, onView, onApply, onDiscard } = props
  const headingId = useId()
  const status = STATUS[proposal.status]
  const applyReason = proposalApplyReason(props)
  const discardReason = proposalDiscardReason(props)
  const viewReason = pending ? "Hay una operación pendiente. Espera a que termine." : null
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <section aria-labelledby={headingId} className="min-w-0 space-y-3 rounded-lg border bg-card p-4 text-sm">
          <header className="flex flex-wrap items-center justify-between gap-2">
            <h3 id={headingId} className="font-medium">Propuesta {proposal.rev}</h3>
            <Pill hint={status.hint} className={status.className}>{status.label}</Pill>
          </header>
          <p className="whitespace-pre-wrap">{proposal.summary}</p>
          {proposal.items.length ? (
            <ul aria-label="Cambios propuestos" className="list-disc space-y-1 pl-4">
              {proposal.items.map((item) => (
                <li key={item.id} className="break-words">
                  {item.change}
                  {item.path ? <code className="ml-1 font-mono text-xs text-muted-foreground">{item.path}</code> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {proposal.files.length ? (
            <ul aria-label="Archivos de la propuesta" className="divide-y rounded-md border px-3">
              {proposal.files.map((file) => (
                <li key={file.path} className="flex items-baseline gap-2 py-2 font-mono text-xs">
                  <span className="min-w-0 flex-1 break-all">{file.path}</span>
                  {file.additions === null || file.deletions === null ? (
                    <span className="text-muted-foreground">Binario</span>
                  ) : (
                    <>
                      <span className="flex-none text-viz-3">+{file.additions}</span>
                      <span className="flex-none text-destructive">−{file.deletions}</span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : <p className="text-xs text-muted-foreground">No hay archivos en esta propuesta. Pide al agente los cambios que necesitas.</p>}
          {proposal.result ? (
            <div aria-label="Resultado de la propuesta" className="space-y-2 border-t pt-3">
              <p className="text-xs text-muted-foreground">Commit aplicado: <code title={proposal.result.sha}>{proposal.result.sha.slice(0, 9)}</code></p>
              {proposal.result.children.length ? (
                <ul aria-label="Resultado de PRs hijos" className="space-y-2">
                  {proposal.result.children.map((child) => (
                    <li key={child.prId} className="space-y-1 rounded-md border p-3 text-xs">
                      <p className="break-words font-medium">{props.childNames?.get(child.prId) ?? child.prId}</p>
                      {child.status === "restacked" ? (
                        <p>Actualizado sobre la nueva punta: <code title={child.head}>{child.head.slice(0, 9)}</code></p>
                      ) : child.status === "uptodate" ? (
                        <p>Ya estaba actualizado. No necesitó cambios.</p>
                      ) : child.status === "skipped" ? (
                        <p className="whitespace-pre-wrap">No se actualizó: {child.reason}</p>
                      ) : (
                        <>
                          <p className="text-destructive">Conflicto al actualizar la base. Revisa los archivos afectados.</p>
                          {child.files.length ? <ul aria-label={`Archivos en conflicto de ${child.prId}`} className="list-disc pl-4 font-mono">{child.files.map((path) => <li key={path} className="break-all">{path}</li>)}</ul> : null}
                          {child.failures ? <pre className="overflow-x-auto whitespace-pre-wrap text-muted-foreground">{child.failures}</pre> : null}
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {!props.canApply && props.applyReason && proposal.status === "draft" ? <p className="text-xs text-muted-foreground">{props.applyReason}</p> : null}
          {proposal.status === "stale" ? (
            <div className="space-y-2 rounded-md border border-viz-4/40 p-3 text-xs">
              <p>El PR cambió desde la propuesta: aplicarla ahora podría no calzar.{proposal.note ? ` ${proposal.note}` : ""}</p>
              {props.onRedo ? <Button type="button" size="sm" variant="outline" disabled={props.busy || pending} onClick={props.onRedo}>Rehacer sobre el PR actual</Button> : null}
            </div>
          ) : null}
          {proposal.status === "failed" && proposal.note ? <p className="whitespace-pre-wrap rounded-md border border-destructive/40 p-3 text-xs">{proposal.note}</p> : null}
          {proposal.status === "applying" ? <ApplyProgress run={props.run ?? null} onOpenRun={props.onOpenRun} /> : null}
          <div className="flex flex-wrap gap-2">
            <ProposalAction label="Ver cambios" hint="Ver el diff de esta propuesta" keys="⌥V" reason={viewReason} onClick={onView} />
            <ProposalAction label="Aplicar" hint="Aplicar esta propuesta al PR" keys="⌥A" reason={applyReason} onClick={onApply} primary />
            <ProposalAction label="Descartar" hint="Descartar esta propuesta sin aplicarla" keys="⌥D" reason={discardReason} onClick={onDiscard} />
          </div>
        </section>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={viewReason !== null} onSelect={onView}>
          Ver cambios <ContextMenuShortcut>⌥V</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={applyReason !== null} onSelect={onApply}>
          Aplicar <ContextMenuShortcut>⌥A</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={discardReason !== null} onSelect={onDiscard}>
          Descartar <ContextMenuShortcut>⌥D</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** Los pasos de la corrida que aplica la propuesta, con link a ella; `queued` es que otra corrida tiene el PR. */
function ApplyProgress({ run, onOpenRun }: { run: RunDetail | null; onOpenRun?: (runId: string) => void }) {
  if (!run) return <p role="status" aria-label="Progreso de la aplicación" className="text-xs text-muted-foreground">Preparando la corrida que aplica la propuesta…</p>
  const seen = new Map<string, RunDetail["steps"][number]>()
  for (const step of run.steps) if (APPLY_STEPS[step.nodeId]) seen.set(step.nodeId, step)
  return (
    <div role="status" aria-label="Progreso de la aplicación" className="space-y-2 border-t pt-3 text-xs">
      {run.status === "queued" ? <p>En cola: otra corrida está trabajando este PR. Esta parte apenas termine.</p> : null}
      {run.status === "parked" ? <p>La corrida espera una decisión: respóndela en la bandeja.</p> : null}
      <ol className="space-y-1">
        {[...seen.values()].map((step) => (
          <li key={step.nodeId} className="flex items-center gap-2">
            <span className={step.status === "done" ? "text-viz-3" : step.status === "failed" ? "text-destructive" : "text-muted-foreground"}>{step.status === "done" ? "✓" : step.status === "failed" ? "✗" : "…"}</span>
            {APPLY_STEPS[step.nodeId]}{step.outcome && step.outcome !== "ok" && step.status === "done" ? <span className="text-muted-foreground">({step.outcome})</span> : null}
          </li>
        ))}
      </ol>
      {onOpenRun ? <Button type="button" size="sm" variant="link" className="h-auto p-0 text-xs" onClick={() => onOpenRun(run.id)}>Ver la corrida</Button> : null}
    </div>
  )
}
