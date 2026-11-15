import { ScrollText, TriangleAlert } from "lucide-react"
import type { CoreLink, CoreState } from "@/host"
import { Button } from "@/components/ui/button"

// Aviso sobre el contenido cuando el core no está vivo. Los datos de abajo se atenúan.
export function StatusBanner({ core, state }: { core: CoreLink; state: Exclude<CoreState, { status: "live" }> }) {
  const down = state.status === "down"
  return (
    <div role="alert" className="flex flex-none items-center gap-3 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-[13px]">
      <TriangleAlert className="size-4 flex-none text-destructive" />
      <div className="min-w-0 flex-1">
        <span className="font-medium">{down ? "El core está caído" : "Levantando el core…"}</span>
        {down ? <span className="ml-2 text-muted-foreground">{state.reason}</span> : null}
      </div>
      {down ? (
        <>
          <Button size="sm" variant="outline" onClick={core.openLogs}>
            <ScrollText /> Ver logs
          </Button>
          <Button size="sm" onClick={core.retry}>
            Reintentar
          </Button>
        </>
      ) : null}
    </div>
  )
}
