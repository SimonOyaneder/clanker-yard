import { toast } from "sonner"
import type { Launched, Result } from "@/types"

// Muestra el resultado de lanzar un EM en background.
export async function reportLaunch(p: Promise<Result<Launched>>, what: string): Promise<boolean> {
  const r = await p
  if (!r.ok) {
    toast.error(r.error)
    return false
  }
  const id = r.data.id
  toast.success(`${what} en background${id ? ` · ${id}` : ""}`, { description: r.data.name })
  return true
}
