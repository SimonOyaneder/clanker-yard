import type { AgentRuntimeId, ChatRef } from "@clanker/api"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { type AppData, supportsChat } from "@/app-data"
import { proposalApplyReason, proposalDiscardReason } from "@/components/prs/chat-proposal"
import { UNDO_MS } from "@/hooks/use-decision-resolver"
import { useLiveQuery } from "@/hooks/use-live"
import { isTypingTarget, overlayOpen } from "@/lib/keys"
import { messageOf } from "@/lib/utils"

export const CHAT_KEYS = { toggle: "⇧⌘C", send: "⌘Enter", interrupt: "⌥I", reset: "⌥R", view: "⌥V", apply: "⇧⌘Enter", discard: "⌥D", cite: "⌥K" } as const
export type ChatActionId = Exclude<keyof typeof CHAT_KEYS, "toggle" | "cite">
export interface ChatAction {
  label: string
  keys: string
  reason: string | null
  run: () => void
}

/** Lo que la persona eligió para el próximo turno; `null` es seguir con lo del chat. */
export interface ChatChoice {
  runtime: AgentRuntimeId
  model: string
}

/** El pedido que manda "Rehacer sobre el PR actual" a una propuesta que quedó atrás. */
export const REDO_MESSAGE = (rev: number) => `El PR cambió desde la propuesta ${rev}: rehazla sobre su punta actual.`

/** Ejemplos del estado vacío: lo que se le puede pedir al chat. */
export const CHAT_EXAMPLES = [
  "Explícame qué cambia este PR y qué riesgos ves.",
  "Agrega un test para el caso borde que falta.",
  "Renombra lo que quedó con un nombre confuso y ajusta sus usos.",
] as const

export function usePrChat(prId: string, appData: AppData) {
  const data = supportsChat(appData) ? appData : null
  const query = useLiveQuery(`chat:${prId}`, () => data ? data.chat({ prId }) : Promise.resolve(null), { on: ["chat.*", "run.finished", "run.status"] })
  const breakers = useLiveQuery("chat-breakers", () => data ? appData.breakers() : Promise.resolve([]), { on: ["breaker.*"] })
  const options = useLiveQuery("chat-agent-options", () => data ? appData.agentOptions() : Promise.resolve(null), { live: false })
  const { reload } = query
  const snapshot = query.data
  const [open, setOpen] = useState(true)
  const [text, setText] = useState("")
  const [refs, setRefs] = useState<ChatRef[]>([])
  const [choice, setChoice] = useState<ChatChoice | null>(null)
  const [pending, setPending] = useState(false)
  const executing = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<"apply" | null>(null)
  /** Reiniciar o descartar esperan `UNDO_MS` antes de llegar al core: mientras tanto se pueden deshacer. */
  const [deferred, setDeferred] = useState<"reset" | "discard" | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [diffOpen, setDiffOpen] = useState(false)
  const composer = useRef<HTMLTextAreaElement | null>(null)
  const toggle = useCallback(() => setOpen((value) => !value), [])
  const focusComposer = useCallback((onFocused?: () => void) => {
    setOpen(true)
    // El panel puede estar montándose, y la vista que se abre enfoca lo suyo al montar: se reintenta hasta que el
    // composer exista y se quede con el foco.
    let tries = 0
    const attempt = () => {
      composer.current?.focus()
      if (composer.current && document.activeElement === composer.current) onFocused?.()
      else if (++tries < 20) setTimeout(attempt, 50)
    }
    setTimeout(attempt, 0)
  }, [])

  const perform = useCallback(async (operation: () => Promise<unknown>) => {
    if (executing.current) return
    executing.current = true
    setPending(true)
    setError(null)
    try {
      await operation()
      reload()
    } catch (e) {
      setError(messageOf(e))
    } finally {
      executing.current = false
      setPending(false)
    }
  }, [reload])

  const chat = snapshot?.chat
  const runtime = choice?.runtime ?? chat?.runtime
  const breaker = runtime ? breakers.data?.find((b) => b.scope === `runtime:${runtime}`) : undefined
  const runtimeOptions = options.data?.runtimes

  const defer = useCallback((kind: "reset" | "discard", operation: () => Promise<unknown>) => {
    setDeferred(kind)
    const undo = () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      setDeferred(null)
    }
    toast(kind === "reset" ? "Reinicio el chat en unos segundos" : "Descarto la propuesta en unos segundos", { duration: UNDO_MS, action: { label: "Deshacer", onClick: undo } })
    timer.current = setTimeout(() => {
      timer.current = null
      setDeferred(null)
      void perform(operation)
    }, UNDO_MS)
  }, [perform])
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const send = useCallback((message: string, withRefs: ChatRef[]) => {
    if (!data || !chat) return
    void perform(async () => {
      await data.sendChat({ chatId: chat.id, text: message, ...(withRefs.length ? { refs: withRefs } : {}), ...(choice ? { runtime: choice.runtime, model: choice.model } : {}) })
      setText("")
      setRefs([])
      setChoice(null)
    })
  }, [data, chat, choice, perform])

  const actions = useMemo<Record<ChatActionId, ChatAction>>(() => {
    const proposal = snapshot?.proposal
    const unavailable = pending ? "Espera a que termine la operación." : !chat ? query.error ? "Reintenta cargar el chat." : "Espera a que cargue el chat." : null
    const busy = chat?.busy ? "El agente está respondiendo: espera o interrumpe el turno." : null
    const applying = proposal?.status === "applying" ? "Espera a que termine la aplicación." : null
    const archived = chat?.status === "archived" ? "Este chat está archivado." : null
    const waiting = deferred ? "Espera unos segundos o deshaz el cambio pendiente." : null
    const paused = breaker ? `El runtime ${breaker.label.replace(/^runtime:/, "")} está en pausa: ${breaker.reason}` : null
    const proposalProps = proposal && chat ? { proposal, canApply: chat.canApply, applyReason: chat.applyReason, busy: chat.busy, pending } : null
    return {
      send: {
        label: "Enviar mensaje", keys: CHAT_KEYS.send,
        reason: unavailable ?? archived ?? busy ?? applying ?? waiting ?? paused ?? (!text.trim() ? "Escribe un mensaje para enviar." : null),
        run: () => send(text.trim(), refs),
      },
      interrupt: {
        label: "Interrumpir turno", keys: CHAT_KEYS.interrupt,
        reason: unavailable ?? (!chat?.busy ? "No hay un turno en curso." : null),
        run: () => { if (data && chat) void perform(() => data.interruptChat({ chatId: chat.id })) },
      },
      reset: {
        label: "Reiniciar chat", keys: CHAT_KEYS.reset,
        reason: unavailable ?? busy ?? applying ?? waiting,
        run: () => { if (data && chat) defer("reset", async () => { await data.resetChat({ chatId: chat.id }); setText(""); setRefs([]) }) },
      },
      view: {
        label: "Ver cambios", keys: CHAT_KEYS.view,
        reason: unavailable ?? (!proposal ? "Todavía no hay una propuesta." : null),
        // La vista del PR abre su pestaña Propuesta, que lee el patch de la rev que se elija.
        run: () => { if (proposal) setDiffOpen(true) },
      },
      apply: {
        label: "Aplicar propuesta", keys: CHAT_KEYS.apply,
        reason: unavailable ?? waiting ?? (proposalProps ? proposalApplyReason(proposalProps) : "Todavía no hay una propuesta."),
        run: () => {
          setOpen(true)
          setConfirmation("apply")
        },
      },
      discard: {
        label: "Descartar propuesta", keys: CHAT_KEYS.discard,
        reason: unavailable ?? waiting ?? (proposalProps ? proposalDiscardReason(proposalProps) : "Todavía no hay una propuesta."),
        run: () => { if (data && chat) defer("discard", () => data.discardProposal({ chatId: chat.id })) },
      },
    }
  }, [snapshot, chat, pending, text, refs, data, perform, query.error, deferred, breaker, defer, send])

  const confirm = useCallback(() => {
    const proposal = snapshot?.proposal
    if (!data || !chat || confirmation !== "apply" || actions.apply.reason || !proposal) return
    setConfirmation(null)
    void perform(() => data.applyProposal({ chatId: chat.id, rev: proposal.rev }))
  }, [data, snapshot, chat, confirmation, actions, perform])

  /** "Rehacer sobre el PR actual": le pide al agente la misma propuesta sobre la punta nueva. */
  const redo = useCallback(() => {
    const proposal = snapshot?.proposal
    if (proposal) send(REDO_MESSAGE(proposal.rev), [])
  }, [snapshot, send])

  /** Cita líneas o un thread en el composer: van con el próximo mensaje. */
  const cite = useCallback((ref: ChatRef) => {
    setRefs((current) => current.some((r) => JSON.stringify(r) === JSON.stringify(ref)) ? current : [...current, ref])
    focusComposer()
  }, [focusComposer])
  const uncite = useCallback((index: number) => setRefs((current) => current.filter((_, i) => i !== index)), [])

  useEffect(() => {
    if (!data) return
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing || overlayOpen() || document.querySelector("[role='alertdialog']")) return
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "c") {
        event.preventDefault()
        toggle()
      } else if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === "Enter") {
        event.preventDefault()
        if (!actions.apply.reason) actions.apply.run()
      } else if (open && event.altKey && !event.metaKey && !event.ctrlKey && !isTypingTarget(event.target)) {
        const id = Object.entries({ KeyI: "interrupt", KeyR: "reset", KeyV: "view", KeyD: "discard" } as const).find(([code]) => event.code === code)?.[1]
        if (!id) return
        event.preventDefault()
        if (!actions[id].reason) actions[id].run()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [data, open, toggle, actions])

  return {
    supported: data !== null, snapshot, open, setOpen, toggle, text, setText, pending,
    error: error ?? query.error, reload, actions, confirmation, setConfirmation, confirm,
    diffOpen, setDiffOpen, refs, cite, uncite, composer, focusComposer, redo, deferred,
    choice, setChoice, runtimeOptions, breaker: breaker ?? null,
  }
}

export type PrChatController = ReturnType<typeof usePrChat>
