import { toast } from "sonner"

export const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Lo reversible se hace directo y avisa con un toast que lo deshace; un fallo se muestra tal cual. Devuelve el
 * mensaje del fallo, o `null` si salió bien, para quien además lo quiera junto al formulario.
 */
export async function undoable(message: string, apply: () => Promise<unknown>, undo: () => Promise<unknown>): Promise<string | null> {
  try {
    await apply()
  } catch (e) {
    toast.error(messageOf(e))
    return messageOf(e)
  }
  toast(message, { action: { label: "Deshacer", onClick: () => void undo().catch((e: unknown) => toast.error(messageOf(e))) } })
  return null
}
