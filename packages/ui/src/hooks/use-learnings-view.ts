import type { Learning, LearningId, LearningStatus } from "@clanker/api"
import { useCallback, useMemo, useRef, useState } from "react"
import { countByStatus, isFiltered, type LearningFilters, NO_FILTERS, targetsOf, type TriageAction, visibleLearnings } from "@/lib/learnings"
import { readPref, writePref } from "@/lib/prefs"

type Triage = (action: TriageAction, targets: Learning[]) => number

/**
 * El estado de la vista de Learnings: pestaña (se recuerda) y filtros, qué learning está a la vista (`current`, el
 * que mueven J y K), cuáles están marcados (`selection`, la X y las casillas) y si se está editando.
 * `learnings` ya trae lo que espera su plazo de deshacer aplicado: al aprobar uno sale solo de "Por revisar" y
 * lo que sigue pasa a ser el `current`.
 */
export function useLearningsView(learnings: Learning[], decide: Triage) {
  const [tab, setTabState] = useState<LearningStatus>(() => {
    const saved = readPref<string>("learningsTab", "proposed")
    return saved === "approved" || saved === "rejected" || saved === "archived" ? saved : "proposed"
  })
  const [filters, setFilters] = useState<LearningFilters>(NO_FILTERS)
  const [cursorId, setCursorId] = useState<LearningId | null>(null)
  const [selection, setSelection] = useState<ReadonlySet<LearningId>>(new Set())
  const [editingId, setEditingId] = useState<LearningId | null>(null)
  const anchor = useRef<LearningId | null>(null)
  // Dónde estaba el cursor: si el learning a la vista sale de la lista (se aprobó), pasa al que ocupa su lugar.
  const lastIndex = useRef(0)

  const items = useMemo(() => visibleLearnings(learnings, tab, filters), [learnings, tab, filters])
  const counts = useMemo(() => countByStatus(learnings, filters), [learnings, filters])
  const found = items.findIndex((l) => l.id === cursorId)
  if (found >= 0) lastIndex.current = found
  const current = items[found >= 0 ? found : Math.min(lastIndex.current, items.length - 1)] ?? null
  const selected = useMemo(() => items.filter((l) => selection.has(l.id)), [items, selection])
  const editing = current !== null && editingId === current.id

  const setTab = useCallback((next: LearningStatus) => {
    setTabState(next)
    writePref("learningsTab", next)
    setSelection(new Set())
    setEditingId(null)
    setCursorId(null)
    lastIndex.current = 0
  }, [])

  const toggle = useCallback(
    (id: LearningId, range = false) => {
      setSelection((prev) => {
        const next = new Set(prev)
        const from = anchor.current ? items.findIndex((l) => l.id === anchor.current) : -1
        const to = items.findIndex((l) => l.id === id)
        if (range && from >= 0 && to >= 0) {
          const [a, b] = from < to ? [from, to] : [to, from]
          for (const l of items.slice(a, b + 1)) next.add(l.id)
        } else if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      anchor.current = id
    },
    [items],
  )

  const move = useCallback(
    (delta: 1 | -1) => {
      const at = current ? items.findIndex((l) => l.id === current.id) : -1
      const next = items[Math.min(Math.max(at + delta, 0), items.length - 1)]
      if (next) {
        setCursorId(next.id)
        setEditingId(null)
      }
    },
    [items, current],
  )

  const act = useCallback(
    (action: TriageAction, targets: Learning[] = targetsOf(selected, current)) => {
      if (decide(action, targets) > 0) setSelection(new Set())
    },
    [decide, selected, current],
  )

  return {
    tab,
    setTab,
    filters,
    setFilters: useCallback((patch: Partial<LearningFilters>) => setFilters((f) => ({ ...f, ...patch })), []),
    clearFilters: useCallback(() => setFilters(NO_FILTERS), []),
    filtered: isFiltered(filters),
    items,
    counts,
    current,
    select: useCallback((id: LearningId) => {
      setCursorId(id)
      setEditingId(null)
    }, []),
    move,
    selected,
    toggle,
    selectAll: useCallback(() => setSelection(new Set(items.map((l) => l.id))), [items]),
    clearSelection: useCallback(() => setSelection(new Set()), []),
    editing,
    setEditing: useCallback((on: boolean, id: LearningId | undefined = current?.id) => setEditingId(on && id ? id : null), [current]),
    /** Aprueba o rechaza los marcados, o el que está a la vista si no hay ninguno marcado (o `targets`, si se pasan). */
    act,
    /** Sobre quién actúan A y R ahora. */
    targets: targetsOf(selected, current),
  }
}

export type LearningsView = ReturnType<typeof useLearningsView>
