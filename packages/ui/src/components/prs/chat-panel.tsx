import type { AgentSessionId, ChatRef, RunId, RuntimeOptions } from "@clanker/api"
import { Ellipsis, MessageSquare, PanelRightClose, Quote, Send, Square, Wrench, X } from "lucide-react"
import { useEffect, useRef } from "react"
import { useAppData } from "@/app-data"
import { Hint } from "@/components/common"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuShortcut, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { CHAT_EXAMPLES, CHAT_KEYS, type ChatAction, type PrChatController } from "@/hooks/use-pr-chat"
import { useLiveQuery } from "@/hooks/use-live"
import { useTranscript } from "@/hooks/use-transcript"
import { costUsd } from "@/lib/format"
import { type OpenPr, keyOf } from "@/lib/prs/prs"
import { cn } from "@/lib/utils"
import { ChatProposalCard } from "./chat-proposal"
import { PlainMarkdown } from "./plain-markdown"

export function ChatActionButton({ action, children }: { action: ChatAction; children?: React.ReactNode }) {
  return (
    <Hint label={action.reason ?? action.label} keys={action.keys}>
      <span tabIndex={action.reason ? 0 : undefined} aria-label={action.reason ?? undefined}>
        <Button type="button" size="sm" variant="outline" disabled={!!action.reason} onClick={action.run}>{children ?? action.label}</Button>
      </span>
    </Hint>
  )
}

/** Cómo se cita algo en el composer: `ruta:línea` o el thread con su autor. */
export function refLabel(ref: ChatRef): string {
  if (ref.kind === "lines") return `${ref.path}:${ref.start}${ref.end !== ref.start ? `-${ref.end}` : ""}`
  return `Thread${ref.author ? ` de ${ref.author}` : ""}${ref.path ? ` en ${ref.path}${ref.line ? `:${ref.line}` : ""}` : ""}`
}

/**
 * Lo concreto de aplicar en este PR: dónde quedan los cambios, qué hijos se restackean y que antes corren los checks.
 * El texto sale del PR (local, remoto o con council) y de sus hijos abiertos.
 */
export function applyPlan(pr: OpenPr, children: readonly OpenPr[]): { where: string; children: string[]; checks: string } {
  const where = pr.local
    ? "Los cambios quedan como commits del PR local, en esta máquina: nada se pushea hasta que el PR se publique."
    : pr.state.threads.councilEver
      ? "Los cambios salen como commits fixup! visibles y se pushean sin forzar: el PR tuvo threads de council y su historia no se reescribe."
      : "Los cambios salen como fixups de los commits del PR, se squashean y se pushean con lease."
  return {
    where,
    children: children.map((child) => `${keyOf(child)} (${child.parents.length > 1 ? "base combinada" : "apilado"})${child.local ? ", local" : ""}`),
    checks: "Antes corren los checks de la receta del repo; si quedan rojos, el dev intenta arreglarlos y, si no puede, el PR queda como estaba.",
  }
}

export function ChatPanel({ controller, pr, prChildren = [], onOpenRun }: { controller: PrChatController; pr: OpenPr; prChildren?: readonly OpenPr[]; onOpenRun?: (runId: RunId) => void }) {
  const appData = useAppData()
  const { snapshot, actions, text, setText, pending, confirmation, refs } = controller
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => end.current?.scrollIntoView({ block: "nearest" }), [snapshot])
  const proposal = snapshot?.proposal
  const childIds = proposal?.result?.children.map((child) => child.prId) ?? []
  const children = useLiveQuery(`chat-children:${childIds.join(":")}`, () => childIds.length ? appData.prsByIds(childIds) : Promise.resolve([]), { live: false })
  const childNames = new Map(children.data?.map((child) => [child.id, child.ref ? `${child.ref.repo}#${child.ref.number}` : child.local?.title ?? child.id]))
  const run = useLiveQuery(`chat-apply:${proposal?.runId ?? "-"}`, () => proposal?.status === "applying" && proposal.runId ? appData.run(proposal.runId) : Promise.resolve(null), { on: ["run.*", "step.*"] })
  const card = proposal && snapshot ? (
    <ChatProposalCard proposal={proposal} canApply={snapshot.chat.canApply} applyReason={snapshot.chat.applyReason} busy={snapshot.chat.busy} pending={pending}
      childNames={childNames} run={run.data ?? null} onView={actions.view.run} onApply={actions.apply.run} onDiscard={actions.discard.run} onRedo={controller.redo} onOpenRun={onOpenRun as ((runId: string) => void) | undefined} />
  ) : null
  const plan = applyPlan(pr, prChildren)
  const chat = snapshot?.chat

  return (
    <section aria-label="Chat del PR" className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex flex-none flex-col gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <MessageSquare className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Chat del PR</h2>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Más acciones del chat"><Ellipsis /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {(["interrupt", "reset"] as const).map((id) => (
                <DropdownMenuItem key={id} disabled={!!actions[id].reason} onSelect={actions[id].run}>
                  {actions[id].label}{actions[id].reason ? `: ${actions[id].reason}` : null}
                  <DropdownMenuShortcut>{actions[id].keys}</DropdownMenuShortcut>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Hint label="Plegar chat" keys={CHAT_KEYS.toggle}>
            <Button size="icon-sm" variant="ghost" onClick={controller.toggle} aria-label="Plegar chat"><PanelRightClose /></Button>
          </Hint>
        </div>
        {chat ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <RuntimePicker controller={controller} options={controller.runtimeOptions} />
            <Hint label="Lo que llevan gastado los turnos de este chat.">
              <span className="ml-auto tabular-nums">{costUsd(chat.costMicros)}</span>
            </Hint>
          </div>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4" aria-label="Conversación">
        {!snapshot && !controller.error ? <Skeleton className="h-20 w-full" /> : null}
        {snapshot?.messages.length === 0 ? (
          <div className="flex flex-col gap-3 py-6">
            <h3 className="text-sm font-medium">¿Qué quieres revisar de este PR?</h3>
            <p className="text-sm text-muted-foreground">Pregunta por el código o pide un cambio. El agente trabaja en un borrador: verás una propuesta con su diff y el PR no cambia hasta que la apliques.</p>
            <ul aria-label="Ejemplos" className="flex flex-col gap-2">
              {CHAT_EXAMPLES.map((example) => (
                <li key={example}>
                  <button type="button" className="w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-muted" onClick={() => {
                    setText(example)
                    controller.focusComposer()
                  }}>{example}</button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {snapshot?.messages.map((message) => (
          <div key={message.id} className="space-y-3">
            <article role={message.role === "system" ? "status" : undefined} className={cn("space-y-2 text-sm", message.role === "user" && "rounded-lg bg-muted px-3 py-2", message.role === "system" && "rounded-lg border px-3 py-2")}>
              <p className="text-xs font-medium text-muted-foreground">{message.role === "user" ? "Tú" : message.role === "assistant" ? "Agente" : "Estado del chat"}</p>
              {message.refs?.length ? (
                <ul aria-label="Citas" className="flex flex-wrap gap-1">
                  {message.refs.map((ref, i) => <li key={i} className="rounded bg-background px-1.5 font-mono text-[11px] text-muted-foreground">{refLabel(ref)}</li>)}
                </ul>
              ) : null}
              <PlainMarkdown source={message.text} />
            </article>
            {proposal && message.proposalRev === proposal.rev && message.role !== "user" ? card : null}
          </div>
        ))}
        {proposal && !snapshot?.messages.some((message) => message.proposalRev === proposal.rev && message.role !== "user") ? card : null}
        {chat?.busy ? (
          chat.turnSessionId ? <LiveTurn key={chat.turnSessionId} sessionId={chat.turnSessionId} /> : <p role="status" className="text-xs text-muted-foreground">El agente está preparando el borrador…</p>
        ) : null}
        <div ref={end} />
      </div>
      {controller.error ? (
        <div role="alert" className="space-y-2 border-t px-4 py-3 text-sm">
          <p className="text-destructive">{controller.error}</p>
          {!snapshot ? <Button size="sm" variant="outline" onClick={controller.reload}>Reintentar</Button> : null}
        </div>
      ) : null}
      <form className="flex flex-none flex-col gap-2 border-t p-4" onSubmit={(event) => {
        event.preventDefault()
        if (!actions.send.reason) actions.send.run()
      }}>
        {refs.length ? (
          <ul aria-label="Citas del próximo mensaje" className="flex flex-wrap gap-1">
            {refs.map((ref, i) => (
              <li key={i} className="flex items-center gap-1 rounded-md border bg-muted px-2 py-0.5 font-mono text-[11px]">
                <Quote className="size-3 text-muted-foreground" />{refLabel(ref)}
                <button type="button" aria-label={`Quitar la cita ${refLabel(ref)}`} onClick={() => controller.uncite(i)} className="text-muted-foreground hover:text-foreground"><X className="size-3" /></button>
              </li>
            ))}
          </ul>
        ) : null}
        <label htmlFor="pr-chat-message" className="sr-only">Mensaje para el chat</label>
        <Textarea ref={controller.composer} id="pr-chat-message" placeholder={chat?.busy ? "El agente está respondiendo… Esc lo interrumpe." : "Pregunta o pide un cambio…"} value={text} onChange={(event) => setText(event.target.value)}
          className="min-h-20 resize-none" onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault()
              if (!actions.send.reason) actions.send.run()
            } else if (event.key === "Escape" && chat?.busy) {
              event.preventDefault()
              event.stopPropagation()
              if (!actions.interrupt.reason) actions.interrupt.run()
            }
          }} />
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">⌘Enter envía · Esc interrumpe · {CHAT_KEYS.cite} cita las líneas marcadas del diff</p>
          {chat?.busy ? <ChatActionButton action={actions.interrupt}><Square /> Interrumpir turno</ChatActionButton> : <ChatActionButton action={actions.send}><Send /> Enviar mensaje</ChatActionButton>}
        </div>
      </form>
      <AlertDialog open={confirmation !== null} onOpenChange={(value) => !value && controller.setConfirmation(null)}>
        <AlertDialogContent onKeyDown={(event) => {
          if (event.key === "Enter" && !actions.apply.reason && !pending) {
            event.preventDefault()
            controller.confirm()
          }
        }}>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Aplicar la propuesta {proposal?.rev} a {keyOf(pr)}?</AlertDialogTitle>
            <AlertDialogDescription>{plan.where}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2 text-sm">
            {plan.children.length ? (
              <>
                <p>Después se restackean los PRs que cuelgan de este:</p>
                <ul aria-label="PRs que se restackean" className="list-disc pl-5 font-mono text-xs">{plan.children.map((child) => <li key={child}>{child}</li>)}</ul>
                <p className="text-xs text-muted-foreground">Si alguno choca, queda como estaba y el flujo de rebase por conflicto lo toma.</p>
              </>
            ) : <p>Ningún PR cuelga de este: no hay nada que restackear.</p>}
            <p className="text-muted-foreground">{plan.checks}</p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Volver</AlertDialogCancel>
            <AlertDialogAction disabled={pending || !!actions.apply.reason} onClick={controller.confirm}>Aplicar <kbd className="ml-1 text-xs opacity-70">↵</kbd></AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

/** El runtime y el modelo del próximo turno: solo los disponibles en este core. Cambiarlos abre una sesión nueva con handoff. */
function RuntimePicker({ controller, options }: { controller: PrChatController; options: readonly RuntimeOptions[] | undefined }) {
  const chat = controller.snapshot?.chat
  if (!chat) return null
  const runtime = controller.choice?.runtime ?? chat.runtime
  const model = controller.choice?.model ?? chat.model
  const available = (options ?? []).filter((r) => r.available)
  const value = `${runtime}|${model}`
  const known = available.some((r) => r.id === runtime && r.models.some((m) => m.id === model))
  return (
    <Hint label={controller.choice ? "Se usa desde el próximo mensaje: el agente parte una sesión nueva con lo conversado." : "El runtime y el modelo del próximo turno."}>
      <span>
        <Select value={value} disabled={chat.busy || available.length === 0} onValueChange={(next) => {
          const [r, m] = next.split("|") as [RuntimeOptions["id"], string]
          controller.setChoice(r === chat.runtime && m === chat.model ? null : { runtime: r, model: m })
        }}>
          <SelectTrigger size="sm" className="h-7 max-w-64 font-mono text-xs" aria-label="Runtime y modelo del chat">
            <SelectValue>{runtime} · {model}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {!known ? <SelectItem value={value} className="font-mono text-xs">{runtime} · {model}</SelectItem> : null}
            {available.map((r) => (
              <SelectGroup key={r.id}>
                <SelectLabel>{r.label}</SelectLabel>
                {r.models.map((m) => <SelectItem key={m.id} value={`${r.id}|${m.id}`} className="font-mono text-xs">{m.label}</SelectItem>)}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </span>
    </Hint>
  )
}

/** El turno en curso, en vivo: lo que el agente escribe y sus herramientas plegadas. */
function LiveTurn({ sessionId }: { sessionId: AgentSessionId }) {
  const { entries } = useTranscript(sessionId, true)
  const shown = entries.filter((entry) => entry.kind === "text" || entry.kind === "tool_call").slice(-8)
  return (
    <section role="status" aria-label="Turno en curso" className="space-y-2 rounded-lg border border-dashed px-3 py-2 text-sm">
      <p className="text-xs font-medium text-muted-foreground">El agente está respondiendo…</p>
      {shown.map((entry, i) => entry.kind === "text" ? (
        <PlainMarkdown key={i} source={entry.text} />
      ) : entry.kind === "tool_call" ? (
        <details key={i} className="text-xs text-muted-foreground">
          <summary className="flex cursor-pointer items-center gap-1"><Wrench className="size-3" /> {entry.tool}{entry.detail ? <code className="truncate">{entry.detail}</code> : null}</summary>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap">{entry.input}</pre>
        </details>
      ) : null)}
    </section>
  )
}
