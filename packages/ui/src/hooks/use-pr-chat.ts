import type { Client } from "@clanker/api"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ChatData } from "@/app-data"
import { proposalApplyReason, proposalDiscardReason } from "@/components/prs/chat-proposal"
import { useLiveQuery } from "@/hooks/use-live"
import { isTypingTarget, overlayOpen } from "@/lib/keys"
import { messageOf } from "@/lib/utils"

export const CHAT_KEYS = { toggle: "⇧⌘C", send: "⌘Enter", interrupt: "⌥I", reset: "⌥R", view: "⌥V", apply: "⌥A", discard: "⌥D" } as const
export type ChatActionId = Exclude<keyof typeof CHAT_KEYS, "toggle">
export interface ChatAction {
  label: string
  keys: string
  reason: string | null
  run: () => void
}

type ProposalDiff = Awaited<ReturnType<Client["chats"]["proposal"]>>

export function usePrChat(prId: string, data: ChatData | null) {
  const query = useLiveQuery(`chat:${prId}`, () => data ? data.chat({ prId }) : Promise.resolve(null))
  const { reload } = query
  const snapshot = query.data
  const [open, setOpen] = useState(true)
  const [text, setText] = useState("")
  const [pending, setPending] = useState(false)
  const executing = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<"apply" | "discard" | "reset" | null>(null)
  const [diff, setDiff] = useState<ProposalDiff | null>(null)
  const [diffOpen, setDiffOpen] = useState(false)
  const toggle = useCallback(() => setOpen((value) => !value), [])

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

  const actions = useMemo<Record<ChatActionId, ChatAction>>(() => {
    const chat = snapshot?.chat
    const proposal = snapshot?.proposal
    const unavailable = pending ? "Espera a que termine la operación." : !chat ? query.error ? "Reintenta cargar el chat." : "Espera a que cargue el chat." : null
    const busy = chat?.busy ? "Interrumpe el turno antes de continuar." : null
    const applying = proposal?.status === "applying" ? "Espera a que termine la aplicación." : null
    const archived = chat?.status === "archived" ? "Este chat está archivado." : null
    const request = (next: typeof confirmation) => {
      setOpen(true)
      setConfirmation(next)
    }
    const proposalProps = proposal && chat ? { proposal, canApply: chat.canApply, applyReason: chat.applyReason, busy: chat.busy, pending } : null
    return {
      send: {
        label: "Enviar mensaje", keys: CHAT_KEYS.send,
        reason: unavailable ?? archived ?? busy ?? applying ?? (!text.trim() ? "Escribe un mensaje para enviar." : null),
        run: () => {
          if (data && chat) void perform(async () => {
            await data.sendChat({ chatId: chat.id, text: text.trim() })
            setText("")
          })
        },
      },
      interrupt: {
        label: "Interrumpir turno", keys: CHAT_KEYS.interrupt,
        reason: unavailable ?? (!chat?.busy ? "No hay un turno en curso." : null),
        run: () => { if (data && chat) void perform(() => data.interruptChat({ chatId: chat.id })) },
      },
      reset: {
        label: "Reiniciar chat", keys: CHAT_KEYS.reset,
        reason: unavailable ?? busy ?? applying,
        run: () => request("reset"),
      },
      view: {
        label: "Ver cambios", keys: CHAT_KEYS.view,
        reason: unavailable ?? (!proposal ? "Todavía no hay una propuesta." : null),
        run: () => {
          if (data && chat && proposal) {
            setOpen(true)
            setDiff(null)
            setDiffOpen(true)
            void perform(async () => setDiff(await data.chatProposal({ chatId: chat.id, rev: proposal.rev })))
          }
        },
      },
      apply: {
        label: "Aplicar propuesta", keys: CHAT_KEYS.apply,
        reason: unavailable ?? (proposalProps ? proposalApplyReason(proposalProps) : "Todavía no hay una propuesta."),
        run: () => request("apply"),
      },
      discard: {
        label: "Descartar propuesta", keys: CHAT_KEYS.discard,
        reason: unavailable ?? (proposalProps ? proposalDiscardReason(proposalProps) : "Todavía no hay una propuesta."),
        run: () => request("discard"),
      },
    }
  }, [snapshot, pending, text, data, perform, query.error])

  const confirm = useCallback(() => {
    const chat = snapshot?.chat
    const proposal = snapshot?.proposal
    if (!data || !chat || !confirmation || actions[confirmation].reason) return
    const next = confirmation
    setConfirmation(null)
    void perform(async () => {
      if (next === "apply" && proposal) await data.applyProposal({ chatId: chat.id, rev: proposal.rev })
      if (next === "discard") await data.discardProposal({ chatId: chat.id })
      if (next === "reset") {
        await data.resetChat({ chatId: chat.id })
        setText("")
      }
    })
  }, [data, snapshot, confirmation, actions, perform])

  useEffect(() => {
    if (!data) return
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing || overlayOpen() || document.querySelector("[role='alertdialog']")) return
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "c") {
        event.preventDefault()
        toggle()
      } else if (open && event.altKey && !event.metaKey && !event.ctrlKey && !isTypingTarget(event.target)) {
        const id = Object.entries({ KeyI: "interrupt", KeyR: "reset", KeyV: "view", KeyA: "apply", KeyD: "discard" } as const).find(([code]) => event.code === code)?.[1]
        if (!id) return
        event.preventDefault()
        if (!actions[id].reason) actions[id].run()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [data, open, toggle, actions])

  return {
    supported: data !== null, snapshot, open, toggle, text, setText, pending,
    error: error ?? query.error, reload, actions, confirmation, setConfirmation, confirm,
    diff, diffOpen, setDiffOpen,
  }
}

export type PrChatController = ReturnType<typeof usePrChat>
