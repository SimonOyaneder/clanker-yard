import type { Decision, DecisionId, DecisionKind, ProjectId } from "@clanker/api"
import { useMemo, useState } from "react"
import { type InboxTab, visibleDecisions } from "@/lib/decisions"
import { readPref, writePref } from "@/lib/prefs"

/**
 * El estado de la bandeja: pestaña y filtros (la pestaña se recuerda) y qué decisión está a la vista.
 * `selectedId` viene de la ruta (`/inbox/:decision?`); sin ella, o si ya no está en la lista, es la primera.
 * `resolving` son las que se respondieron y esperan el plazo de deshacer: no cuentan como pendientes.
 */
export function useInbox(decisions: Decision[], resolving: ReadonlyMap<DecisionId, unknown>, selectedId: DecisionId | null) {
  const [tab, setTabState] = useState<InboxTab>(() => (readPref<string>("inboxTab", "pending") === "resolved" ? "resolved" : "pending"))
  const [projectId, setProjectId] = useState<ProjectId | null>(null)
  const [kind, setKind] = useState<DecisionKind | null>(null)
  // Responder con texto libre: de la decisión que está a la vista.
  const [respondingTo, setRespondingTo] = useState<DecisionId | null>(null)

  const open = useMemo(() => decisions.filter((d) => d.status !== "pending" || !resolving.has(d.id)), [decisions, resolving])
  const pending = useMemo(() => open.filter((d) => d.status === "pending"), [open])
  const items = useMemo(() => visibleDecisions(open, { tab, projectId, kind }), [open, tab, projectId, kind])
  const current = items.find((d) => d.id === selectedId) ?? items[0] ?? null
  const filtered = projectId !== null || kind !== null

  return {
    tab,
    setTab: (next: InboxTab) => {
      setTabState(next)
      writePref("inboxTab", next)
    },
    projectId,
    setProjectId,
    kind,
    setKind,
    clearFilters: () => {
      setProjectId(null)
      setKind(null)
    },
    filtered,
    items,
    current,
    pending,
    /** `true` si la decisión a la vista está en modo "Responder…". */
    responding: current !== null && respondingTo === current.id,
    setResponding: (on: boolean, id: DecisionId | undefined = current?.id) => setRespondingTo(on && id ? id : null),
  }
}

export type Inbox = ReturnType<typeof useInbox>
