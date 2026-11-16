import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** Lo que muestra una vista entera cuando no pudo leer sus datos del core: qué no se leyó, por qué y reintentar. */
export function PageLoadError({ title, message, onRetry, extra, className }: { title: string; message: string; onRetry: () => void; extra?: ReactNode; className?: string }) {
  return (
    <div role="alert" className={cn("mx-auto mt-16 flex max-w-md flex-col items-center gap-3 text-center", className)}>
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="text-muted-foreground">{message}</p>
      <div className="flex gap-2">
        <Button size="sm" onClick={onRetry}>
          Reintentar
        </Button>
        {extra}
      </div>
    </div>
  )
}
