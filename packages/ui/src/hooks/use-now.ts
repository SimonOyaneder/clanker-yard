import { useEffect, useState } from "react"

// La hora actual, refrescada cada segundo mientras `active` (para el tiempo de lo que sigue corriendo).
export function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return active ? now : Date.now()
}
