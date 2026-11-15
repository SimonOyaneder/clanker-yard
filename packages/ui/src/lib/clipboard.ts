import { toast } from "sonner"

export function copy(text: string, what: string): void {
  void navigator.clipboard.writeText(text).then(
    () => toast.success(`Copié ${what}`),
    () => toast.error("No pude copiar"),
  )
}
