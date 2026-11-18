import { useNow } from "@/hooks/use-now"
import { elapsed } from "@/lib/format"

/**
 * Cuánto lleva algo: `base` ms ya cerrados más lo que corre desde `since` (si sigue abierto). Es una hoja con su propio
 * reloj: lo que corre avanza cada segundo sin re-renderizar la vista, el grafo ni la lista donde está.
 */
export function Elapsed({ base = 0, since = null }: { base?: number; since?: number | null }) {
  const now = useNow(since !== null)
  return <>{elapsed(base + (since === null ? 0 : now - since))}</>
}
