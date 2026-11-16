import type { DefRecord, DefWrite, DefWriteKind } from "@clanker/api"
import { type ReactNode, useState } from "react"
import { toast } from "sonner"
import { useAppData } from "@/app-data"
import { ChangeDialog } from "@/components/flows/change-dialog"
import { Button } from "@/components/ui/button"
import { messageOf } from "@/lib/undoable"

interface Props {
  def: DefRecord
  kind: DefWriteKind
  /** El body que el formulario armó con lo que la persona eligió. */
  body: unknown
  onSaved: () => void
  onCancel: () => void
  children: ReactNode
}

/**
 * El marco de un formulario que edita el body de una def: sus campos arriba y, abajo, Guardar. Guardar valida con
 * `defs.update` y `dryRun`, muestra el diff en `ChangeDialog` (o lo que impide guardar) y, al confirmar, crea la
 * versión nueva. Es el mismo camino que el editor de JSON, sin la validación en vivo: los campos ya limitan lo que se puede elegir.
 */
export function DefFormFrame({ def, kind, body, onSaved, onCancel, children }: Props) {
  const appData = useAppData()
  const [dry, setDry] = useState<DefWrite | null>(null)
  const [busy, setBusy] = useState(false)

  const review = async () => {
    setBusy(true)
    try {
      setDry(await appData.updateDef({ kind, id: def.id, body, dryRun: true }))
    } catch (e) {
      toast.error(messageOf(e))
    } finally {
      setBusy(false)
    }
  }
  const save = async () => {
    setBusy(true)
    try {
      await appData.updateDef({ kind, id: def.id, body, dryRun: false })
      toast("Guardé una versión nueva. Para volver atrás, elígela en el historial.")
      onSaved()
    } catch (e) {
      toast.error(messageOf(e))
      setDry(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-muted-foreground">Las corridas en curso siguen con la versión con que empezaron: lo que guardes vale para las corridas nuevas.</p>
      {children}
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => void review()}>
          Guardar…
        </Button>
        <Button size="sm" variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
      {dry ? <ChangeDialog title={`Guardar ${def.slug}`} confirmLabel="Guardar versión nueva" write={dry} kind={kind} onConfirm={() => void save()} onCancel={() => setDry(null)} /> : null}
    </div>
  )
}
