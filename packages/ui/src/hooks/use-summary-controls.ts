import { useCallback, useEffect, useState } from "react"
import { DEFAULT_RANGE, ORIGINS, type Origin, type RangePreset, type SummaryRange } from "@/lib/summary"

/** Rango, origen y vista (gráficos o tablas) del Resumen. Viven en `App` para que la paleta y los atajos los muevan. */
export interface SummaryControls {
  range: SummaryRange
  origin: Origin
  asTables: boolean
  setRange: (range: SummaryRange) => void
  setPreset: (preset: RangePreset) => void
  setOrigin: (origin: Origin) => void
  toggleTables: () => void
  /** F: todo, 7 días, 30 días y de vuelta; el personalizado solo se elige con el selector. */
  cycleRange: () => void
  /** O: todas, importadas, Yard. */
  cycleOrigin: () => void
}

const next = <T,>(all: readonly T[], current: T) => all[(all.indexOf(current) + 1) % all.length]!
const CYCLED_RANGES = ["all", "7d", "30d"] as const satisfies readonly RangePreset[]

/** Con `active` (el Resumen a la vista) T, O y F cambian la vista, el origen y el rango, fuera de campos de texto y sin diálogos abiertos. */
export function useSummaryControls(active: boolean): SummaryControls {
  const [range, setRange] = useState<SummaryRange>(DEFAULT_RANGE)
  const [origin, setOrigin] = useState<Origin>("all")
  const [asTables, setAsTables] = useState(false)
  const setPreset = useCallback((preset: RangePreset) => setRange((r) => ({ ...r, preset })), [])
  const toggleTables = useCallback(() => setAsTables((t) => !t), [])
  const cycleRange = useCallback(() => setRange((r) => ({ ...DEFAULT_RANGE, preset: next(CYCLED_RANGES, CYCLED_RANGES.find((p) => p === r.preset) ?? "30d") })), [])
  const cycleOrigin = useCallback(() => setOrigin((o) => next(ORIGINS, o)), [])

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat) return
      if ((e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable='true'], [role='combobox']")) return
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return
      const key = e.key.toLowerCase()
      if (key === "t") toggleTables()
      else if (key === "o") cycleOrigin()
      else if (key === "f") cycleRange()
      else return
      e.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [active, toggleTables, cycleOrigin, cycleRange])

  return { range, origin, asTables, setRange, setPreset, setOrigin, toggleTables, cycleRange, cycleOrigin }
}
