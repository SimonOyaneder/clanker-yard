import { Ellipsis, MessageSquare, PanelRightClose, Send, Square } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useAppData } from "@/app-data"
import { Hint, Pill } from "@/components/common"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuShortcut, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { CHAT_KEYS, type ChatAction, type PrChatController } from "@/hooks/use-pr-chat"
import { useLiveQuery } from "@/hooks/use-live"
import { costUsd } from "@/lib/format"
import { parsePatch } from "@/lib/prs/diff"
import { cn } from "@/lib/utils"
import { ChatProposalCard } from "./chat-proposal"
import { FileDiff } from "./file-diff"
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

const CONFIRM = {
  apply: { title: "¿Aplicar esta propuesta al PR?", description: "Los cambios se incorporan al PR y sus hijos se restackean. Si uno queda en conflicto, se conserva para resolverlo. Esta operación no se puede deshacer desde el chat.", action: "Aplicar" },
  discard: { title: "¿Descartar la propuesta?", description: "Se elimina el borrador de cambios, no la conversación ni los cambios del PR.", action: "Descartar" },
  reset: { title: "¿Reiniciar el chat?", description: "Se borra la conversación y su propuesta. Los cambios que ya aplicaste al PR se conservan.", action: "Reiniciar" },
}

export function ChatPanel({ controller }: { controller: PrChatController }) {
  const appData = useAppData()
  const { snapshot, actions, text, setText, pending, confirmation } = controller
  const end = useRef<HTMLDivElement>(null)
  const [viewed, setViewed] = useState<Set<string>>(() => new Set())
  useEffect(() => end.current?.scrollIntoView({ block: "nearest" }), [snapshot])
  useEffect(() => setViewed(new Set()), [controller.diff])
  const proposal = snapshot?.proposal
  const childIds = proposal?.result?.children.map((child) => child.prId) ?? []
  const children = useLiveQuery(`chat-children:${childIds.join(":")}`, () => childIds.length ? appData.prsByIds(childIds) : Promise.resolve([]), { live: false })
  const childNames = new Map(children.data?.map((child) => [child.id, child.ref ? `${child.ref.repo}#${child.ref.number}` : child.local?.title ?? child.id]))
  const card = proposal && snapshot ? (
    <ChatProposalCard proposal={proposal} canApply={snapshot.chat.canApply} applyReason={snapshot.chat.applyReason} busy={snapshot.chat.busy} pending={pending}
      childNames={childNames} onView={actions.view.run} onApply={actions.apply.run} onDiscard={actions.discard.run} />
  ) : null

  return (
    <section aria-label="Chat del PR" className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex flex-none flex-col gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <MessageSquare className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Chat del PR</h2>
          <Pill hint="Prototipo con datos de ejemplo. No ejecuta agentes ni modifica repositorios." className="bg-muted text-muted-foreground">Demo</Pill>
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
        {snapshot ? (
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span>{snapshot.chat.runtime}</span><span className="font-mono">{snapshot.chat.model}</span>
            <span className="ml-auto tabular-nums">{costUsd(snapshot.chat.costMicros)}</span>
          </p>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4" aria-label="Conversación">
        {!snapshot && !controller.error ? <Skeleton className="h-20 w-full" /> : null}
        {snapshot?.messages.length === 0 ? (
          <div className="flex flex-col gap-2 py-6">
            <h3 className="text-sm font-medium">¿Qué quieres revisar de este PR?</h3>
            <p className="text-sm text-muted-foreground">Pregunta por el código o pide un cambio. Primero verás una propuesta; el PR no cambia hasta que la apliques.</p>
          </div>
        ) : null}
        {snapshot?.messages.map((message) => (
          <div key={message.id} className="space-y-3">
            <article role={message.role === "system" ? "status" : undefined} className={cn("space-y-2 text-sm", message.role === "user" && "rounded-lg bg-muted px-3 py-2", message.role === "system" && "rounded-lg border px-3 py-2")}>
              <p className="text-xs font-medium text-muted-foreground">{message.role === "user" ? "Tú" : message.role === "assistant" ? "Asistente" : "Estado del chat"}</p>
              <PlainMarkdown source={message.text} />
            </article>
            {proposal && message.proposalRev === proposal.rev ? card : null}
          </div>
        ))}
        {proposal && !snapshot?.messages.some((message) => message.proposalRev === proposal.rev) ? card : null}
        {snapshot?.chat.busy ? <p role="status" className="text-xs text-muted-foreground">El asistente está respondiendo… Puedes interrumpir el turno.</p> : null}
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
        <label htmlFor="pr-chat-message" className="sr-only">Mensaje para el chat</label>
        <Textarea id="pr-chat-message" placeholder="Pregunta o pide un cambio…" value={text} onChange={(event) => setText(event.target.value)}
          className="min-h-20 resize-none" onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault()
              if (!actions.send.reason) actions.send.run()
            }
          }} />
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">⌘Enter envía · Enter agrega una línea</p>
          {snapshot?.chat.busy ? <ChatActionButton action={actions.interrupt}><Square /> Interrumpir turno</ChatActionButton> : <ChatActionButton action={actions.send}><Send /> Enviar mensaje</ChatActionButton>}
        </div>
      </form>
      <AlertDialog open={confirmation !== null} onOpenChange={(value) => !value && controller.setConfirmation(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmation ? CONFIRM[confirmation].title : ""}</AlertDialogTitle>
            <AlertDialogDescription>{confirmation ? CONFIRM[confirmation].description : ""}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Volver</AlertDialogCancel>
            <AlertDialogAction disabled={pending || (confirmation ? !!actions[confirmation].reason : false)} onClick={controller.confirm}>{confirmation ? CONFIRM[confirmation].action : ""}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={controller.diffOpen} onOpenChange={controller.setDiffOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Cambios de la propuesta</DialogTitle>
            <DialogDescription>Estos cambios son del borrador, no del diff actual del PR.</DialogDescription>
          </DialogHeader>
          {!controller.diff && pending ? <Skeleton className="h-40 w-full" /> : null}
          {!controller.diff && controller.error ? (
            <div className="space-y-2">
              <p role="alert" className="text-sm text-destructive">{controller.error}</p>
              <Button size="sm" variant="outline" disabled={pending} onClick={actions.view.run}>Reintentar</Button>
            </div>
          ) : null}
          {controller.diff ? parsePatch(controller.diff.patch).map((file) => (
            <FileDiff key={file.path} file={file} mode="unified" viewed={viewed.has(file.path)} onViewed={(on) => setViewed((previous) => {
              const next = new Set(previous)
              if (on) next.add(file.path)
              else next.delete(file.path)
              return next
            })} />
          )) : null}
        </DialogContent>
      </Dialog>
    </section>
  )
}
