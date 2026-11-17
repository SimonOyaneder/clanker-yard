import type { DefWrite, DefWriteKind } from "@clanker/api"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { changeKind, describePath, plain, showValue } from "@/lib/flows/def-edit"

interface Props {
  title: string
  confirmLabel: string
  /** El resultado de `updateDef` con `dryRun`: el diff contra la versión vigente, o lo que impide guardar. */
  write: DefWrite
  kind: DefWriteKind
  onConfirm: () => void
  onCancel: () => void
}

const MARK = { added: "+", removed: "−", changed: "~" } as const

/** Qué cambia respecto de la versión vigente, antes de crear una versión nueva. */
export function ChangeDialog({ title, confirmLabel, write, kind, onConfirm, onCancel }: Props) {
  const blocked = write.errors.length > 0
  const nothing = !blocked && !write.changed
  return (
    <AlertDialog open onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent className="sm:max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>
            {blocked
              ? "No se puede guardar todavía: arregla esto primero."
              : nothing
                ? "Es igual a la versión vigente: no se crea una versión nueva."
                : "Esto cambia respecto de la versión vigente. Se guarda como una versión nueva; las corridas en curso siguen con la versión con que empezaron."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul aria-label="Cambios" className="max-h-72 divide-y overflow-auto rounded-lg border text-[13px]">
          {write.errors.map((e, i) => (
            <li key={i} className="px-3 py-2 text-destructive">
              {describePath(kind, e.path)}: {plain(e.message)}
            </li>
          ))}
          {write.diff.map((change) => {
            const how = changeKind(change)
            return (
              <li key={change.path} className="flex flex-col gap-0.5 px-3 py-2">
                <span>
                  <span className="mr-2 font-mono text-xs text-muted-foreground">{MARK[how]}</span>
                  {describePath(kind, change.path)} <span className="text-muted-foreground">({how === "added" ? "nuevo" : how === "removed" ? "se quita" : "cambia"})</span>
                </span>
                <span className="font-mono text-xs break-all">
                  {how !== "added" ? <del className="text-destructive">{showValue(change.before)}</del> : null}
                  {how === "changed" ? " → " : null}
                  {how !== "removed" ? <ins className="text-emerald-700 no-underline dark:text-emerald-400">{showValue(change.after)}</ins> : null}
                </span>
              </li>
            )
          })}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel>{blocked || nothing ? "Cerrar" : "Seguir editando"}</AlertDialogCancel>
          {blocked || nothing ? null : <AlertDialogAction onClick={onConfirm}>{confirmLabel}</AlertDialogAction>}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
