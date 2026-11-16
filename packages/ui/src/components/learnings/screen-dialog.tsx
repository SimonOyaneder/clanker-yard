import type { Learning, LearningVerdict } from "@clanker/api"
import { Archive, Loader2 } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { useAppData } from "@/app-data"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { messageOf } from "@/lib/utils"

type State = { kind: "loading" } | { kind: "ready"; rejected: LearningVerdict[] } | { kind: "error"; message: string }

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  learnings: Learning[]
  /** El core ya archivó: quien tiene la lista la relee. */
  onArchived: () => void
}

// «Filtrar con el criterio»: un agente barato revisa los propuestos por agentes y esta ventana muestra, antes de
// tocar nada, cuáles archivaría y por qué. Archivar no borra: los archivados se ven en Retirados y se pueden aprobar.
export function ScreenDialog({ open, onOpenChange, learnings, onArchived }: Props) {
  const appData = useAppData()
  const [state, setState] = useState<State>({ kind: "loading" })
  const [archiving, setArchiving] = useState(false)

  useEffect(() => {
    if (!open) return
    let current = true
    setState({ kind: "loading" })
    appData
      .screenLearnings()
      .then((verdicts) => current && setState({ kind: "ready", rejected: verdicts.filter((v) => !v.keep) }))
      .catch((e) => current && setState({ kind: "error", message: messageOf(e) }))
    return () => {
      current = false
    }
  }, [open, appData])

  const archive = async (rejected: LearningVerdict[]) => {
    setArchiving(true)
    try {
      await appData.archiveLearnings(rejected.map((v) => v.id))
      toast(`Archivé ${rejected.length} learning${rejected.length === 1 ? "" : "s"}. Están en Retirados.`)
      onArchived()
      onOpenChange(false)
    } catch (e) {
      toast.error(`No pude archivar: ${messageOf(e)}`)
    } finally {
      setArchiving(false)
    }
  }

  const textOf = (id: string) => learnings.find((l) => l.id === id)?.text ?? id

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>Filtrar con el criterio</DialogTitle>
          <DialogDescription>
            Un agente revisa los propuestos por agentes: se queda lo reutilizable, no obvio, comprobado y de una línea. Nada se archiva hasta que lo confirmes, y lo archivado se puede volver a aprobar.
          </DialogDescription>
        </DialogHeader>
        {state.kind === "loading" ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Revisando los propuestos…
          </p>
        ) : state.kind === "error" ? (
          <p role="alert" className="text-sm text-destructive">
            {state.message}
          </p>
        ) : state.rejected.length === 0 ? (
          <p className="text-sm text-muted-foreground">Todos los propuestos por agentes cumplen el criterio: no hay nada que archivar.</p>
        ) : (
          <>
            <p className="text-sm">
              {state.rejected.length} no cumplen el criterio y se archivarían:
            </p>
            <ul aria-label="Learnings a archivar" className="max-h-80 divide-y overflow-y-auto rounded border">
              {state.rejected.map((v) => (
                <li key={v.id} className="flex flex-col gap-1 px-3 py-2 text-[13px]">
                  <span className="leading-snug">{textOf(v.id)}</span>
                  <span className="text-xs text-muted-foreground">{v.reason}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {state.kind === "ready" && state.rejected.length > 0 ? "Cancelar" : "Cerrar"}
          </Button>
          {state.kind === "ready" && state.rejected.length > 0 ? (
            <Button disabled={archiving} onClick={() => void archive(state.rejected)}>
              <Archive /> Archivar {state.rejected.length}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
