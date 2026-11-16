import type { Lane, Lanes } from "@clanker/api"
import { Minus, Plus, SlidersHorizontal } from "lucide-react"
import { Hint } from "@/components/common"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useAppActions } from "@/lib/app-context"

export const LANE_NAME = { dev: "Carril dev", maintenance: "Carril mantenimiento" } as const satisfies Record<Lane, string>

/** Lo que pasa si el tope queda por debajo de lo que corre: nada se interrumpe, solo no entra nada nuevo. */
export const BELOW_USE = "Las corridas en curso siguen; no entran nuevas hasta que baje."

/** El botón del chip de un carril: abre el popover con la capacidad de los dos carriles de la máquina. */
export function LanesControl({ lanes }: { lanes: Lanes }) {
  return (
    <Popover>
      <Hint label="Cambiar la capacidad de los carriles">
        <PopoverTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label="Cambiar la capacidad de los carriles" className="absolute top-1.5 right-1.5 size-6 text-muted-foreground">
            <SlidersHorizontal />
          </Button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent align="end" className="flex w-80 flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-[13px] font-medium">Capacidad de los carriles</h3>
          <p className="text-xs text-pretty text-muted-foreground">
            El carril es el tope de la máquina entera; <code className="font-mono">parallel</code> es el tope de cada proyecto. Rige al instante.
          </p>
        </div>
        {(["dev", "maintenance"] as const).map((lane) => (
          <LaneStepper key={lane} lane={lane} usage={lanes[lane]} />
        ))}
      </PopoverContent>
    </Popover>
  )
}

/** El stepper de capacidad de un carril: el mismo en el popover de Operación y en Ajustes. */
export function LaneStepper({ lane, usage }: { lane: Lane; usage: Lanes[Lane] }) {
  const actions = useAppActions()
  const set = (capacity: number) => void actions.setLanes(lane, capacity, usage.capacity)
  const name = LANE_NAME[lane].toLowerCase()
  return (
    <div role="group" aria-label={LANE_NAME[lane]} className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col">
          <span className="text-[13px]">{LANE_NAME[lane]}</span>
          <span className="text-xs text-muted-foreground tabular-nums">en uso: {usage.active}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button size="icon-sm" variant="outline" aria-label={`Bajar la capacidad del ${name}`} disabled={usage.capacity <= 1} onClick={() => set(usage.capacity - 1)}>
            <Minus />
          </Button>
          <output aria-label={`Capacidad del ${name}`} className="w-8 text-center text-sm font-medium tabular-nums">
            {usage.capacity}
          </output>
          <Button size="icon-sm" variant="outline" aria-label={`Subir la capacidad del ${name}`} onClick={() => set(usage.capacity + 1)}>
            <Plus />
          </Button>
        </div>
      </div>
      {usage.capacity < usage.active ? <p className="text-xs text-pretty text-amber-700 dark:text-amber-300">{BELOW_USE}</p> : null}
    </div>
  )
}
