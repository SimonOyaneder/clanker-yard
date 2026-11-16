import { useCallback, useEffect, useRef } from "react"
import { isTypingTarget } from "@/lib/keys"

const MAX_HISTORY = 50

export interface NavHistory<L> {
  /** Va a `to` (sobre el lugar de ahora) y lo suma al historial si es otro lugar. */
  go(to: Partial<L>): void
  /** Cambia el lugar sin sumarlo al historial (J y K en una lista no llenan el atrás). */
  replace(to: Partial<L>): void
  goBack(): void
  goForward(): void
}

/**
 * El historial de atrás y adelante, como el de un navegador: `here` es el lugar de ahora, `apply` lo pone en
 * pantalla y `same` dice si dos lugares son el mismo (no se apila uno repetido). Escucha también ⌘[ y ⌘], ⌘← y
 * ⌘→ (fuera de un campo de texto) y los botones de pulgar del mouse.
 */
export function useNavHistory<L extends object>(here: L, apply: (to: L) => void, same: (a: L, b: L) => boolean): NavHistory<L> {
  const current = useRef(here)
  current.current = here
  const back = useRef<L[]>([])
  const forward = useRef<L[]>([])

  const replace = useCallback(
    (to: Partial<L>) => {
      const next = { ...current.current, ...to }
      current.current = next
      apply(next)
    },
    [apply],
  )
  const go = useCallback(
    (to: Partial<L>) => {
      const next = { ...current.current, ...to }
      if (!same(current.current, next)) {
        back.current = [...back.current, current.current].slice(-MAX_HISTORY)
        forward.current = []
      }
      current.current = next
      apply(next)
    },
    [apply, same],
  )
  const step = useCallback(
    (from: { current: L[] }, to: { current: L[] }) => {
      const target = from.current.pop()
      if (!target) return
      to.current.push(current.current)
      current.current = target
      apply(target)
    },
    [apply],
  )
  const goBack = useCallback(() => step(back, forward), [step])
  const goForward = useCallback(() => step(forward, back), [step])

  useEffect(() => {
    // Botones 4 y 5 del mouse (los de pulgar de un MX Master): en el DOM son button 3 y 4.
    const isNav = (e: MouseEvent) => e.button === 3 || e.button === 4
    const onDown = (e: MouseEvent) => {
      if (isNav(e)) e.preventDefault()
    }
    const onUp = (e: MouseEvent) => {
      if (!isNav(e)) return
      e.preventDefault()
      if (e.button === 3) goBack()
      else goForward()
    }
    const onKey = (e: KeyboardEvent) => {
      // ⌘[ / ⌘] por tecla física: Logi Options+ los manda con el código de la tecla de un teclado US,
      // que en el layout español no produce "[" ni "]".
      if (e.metaKey && !e.ctrlKey && !e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight")) {
        e.preventDefault()
        if (e.code === "BracketLeft") goBack()
        else goForward()
        return
      }
      // ⌘← / ⌘→ como en Safari y Finder: en teclados como el español, [ y ] van con ⌥. En un campo de
      // texto no: ahí ⌘← / ⌘→ mueven el cursor al inicio o al final de la línea.
      if (!e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
      if (isTypingTarget(e.target)) return
      e.preventDefault()
      if (e.key === "ArrowLeft") goBack()
      else goForward()
    }
    window.addEventListener("mousedown", onDown)
    window.addEventListener("mouseup", onUp)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("mousedown", onDown)
      window.removeEventListener("mouseup", onUp)
      window.removeEventListener("keydown", onKey)
    }
  }, [goBack, goForward])

  return { go, replace, goBack, goForward }
}
