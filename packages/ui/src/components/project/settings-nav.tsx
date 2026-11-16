import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"

export interface SettingsNavItem {
  /** El id de la sección, sin el prefijo `settings-` que lleva su ancla. */
  id: string
  label: string
}

const anchor = (id: string) => document.getElementById(`settings-${id}`)

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement; node; node = node.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(node).overflowY)) return node
  }
  return null
}

/** Cuánto bajo el borde del scroll tiene que haber pasado el título de una sección para contarla como la visible. */
const READING_LINE = 96

/** La sección que se está leyendo: la última cuyo inicio ya pasó la línea de lectura, o la última al llegar al fondo. */
function useActiveSection(ids: string[]) {
  const [active, setActive] = useState(ids[0]!)
  const key = ids.join(",")
  useEffect(() => {
    const list = key.split(",")
    const scroller = scrollParent(anchor(list[0]!))
    if (!scroller) return
    let frame = 0
    const measure = () => {
      frame = 0
      const line = scroller.getBoundingClientRect().top + READING_LINE
      const atBottom = scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2
      const passed = list.filter((id) => (anchor(id)?.getBoundingClientRect().top ?? Infinity) <= line)
      setActive(atBottom ? list[list.length - 1]! : (passed[passed.length - 1] ?? list[0]!))
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    schedule()
    scroller.addEventListener("scroll", schedule, { passive: true })
    window.addEventListener("resize", schedule)
    return () => {
      cancelAnimationFrame(frame)
      scroller.removeEventListener("scroll", schedule)
      window.removeEventListener("resize", schedule)
    }
  }, [key])
  return [active, setActive] as const
}

/**
 * El índice de Ajustes. En ancho es una columna fija a la izquierda; en angosto son tabs con scroll horizontal que se
 * quedan arriba. Lo decide el ancho del contenedor (`@4xl`), que ya descuenta la barra lateral de la app.
 */
export function SettingsNav({ items }: { items: SettingsNavItem[] }) {
  const [active, setActive] = useActiveSection(items.map((i) => i.id))
  return (
    <nav
      aria-label="Secciones de Ajustes"
      className="sticky top-0 z-10 -mx-6 flex gap-1 overflow-x-auto border-b bg-background px-6 py-2 @4xl:top-5 @4xl:mx-0 @4xl:w-44 @4xl:shrink-0 @4xl:flex-col @4xl:self-start @4xl:overflow-visible @4xl:border-0 @4xl:p-0"
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-current={item.id === active ? "location" : undefined}
          onClick={() => {
            setActive(item.id)
            anchor(item.id)?.scrollIntoView({ block: "start", behavior: "smooth" })
          }}
          className={cn(
            "shrink-0 rounded-md px-2.5 py-1 text-left text-[13px] whitespace-nowrap text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            item.id === active && "bg-accent font-medium text-foreground",
          )}
        >
          {item.label}
        </button>
      ))}
    </nav>
  )
}
