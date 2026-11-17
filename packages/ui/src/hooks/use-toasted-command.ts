import { useCallback } from "react"
import { toast } from "sonner"
import { useLive } from "@/hooks/use-live"
import { messageOf } from "@/lib/utils"

/**
 * Corre un comando sobre el core y avisa: `done` en un toast si salió bien, el error tal cual si no. Después
 * relee: los eventos del core también hacen releer, y esto cubre a un core que no los manda (los datos de ejemplo).
 */
export function useToastedCommand(): (work: () => Promise<unknown>, done: string) => Promise<void> {
  const live = useLive()
  return useCallback(
    async (work, done) => {
      try {
        await work()
        toast.success(done)
      } catch (e) {
        toast.error(messageOf(e))
      }
      live.refresh()
    },
    [live],
  )
}
