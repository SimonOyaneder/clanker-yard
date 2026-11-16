import { Check, ChevronRight } from "lucide-react"
import { useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Progress } from "@/components/ui/progress"
import type { SetupStep, SetupStepId } from "@/lib/setup"
import { cn } from "@/lib/utils"

// Los pasos de la configuración inicial: cada uno lleva a donde se hace, y el siguiente por hacer va destacado.
export function SetupChecklist({ steps, onStep }: { steps: readonly SetupStep[]; onStep: (id: SetupStepId) => void }) {
  const next = steps.find((s) => !s.done)
  return (
    <ol aria-label="Configuración" className="flex flex-col gap-0.5">
      {steps.map((step, i) => (
        <li key={step.id}>
          <button
            type="button"
            onClick={() => onStep(step.id)}
            className={cn("flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-accent", step === next && "bg-accent/60")}
          >
            <span
              className={cn(
                "mt-px grid size-4 flex-none place-items-center rounded-full border text-[10px] tabular-nums",
                step.done ? "border-transparent bg-emerald-500 text-white" : step === next ? "border-primary text-primary" : "text-muted-foreground",
              )}
            >
              {step.done ? <Check className="size-3" aria-label="hecho" /> : i + 1}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className={cn("font-medium", step.done && "text-muted-foreground line-through decoration-muted-foreground/50")}>{step.label}</span>
              <span className="text-xs text-muted-foreground">{step.hint}</span>
            </span>
            {step === next ? <ChevronRight className="mt-0.5 size-4 flex-none text-muted-foreground" /> : null}
          </button>
        </li>
      ))}
    </ol>
  )
}

// "Configuración n/5" en el pie de la barra lateral mientras falte algo; abre la lista de pasos.
export function SetupProgress({ steps, onStep }: { steps: readonly SetupStep[]; onStep: (id: SetupStepId) => void }) {
  const [open, setOpen] = useState(false)
  const done = steps.filter((s) => s.done).length
  if (done === steps.length) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="flex flex-col gap-1.5 rounded-md px-1.5 py-1 text-left text-xs hover:bg-sidebar-accent">
          <span className="flex items-center justify-between">
            <span className="font-medium text-sidebar-foreground/80">Configuración</span>
            <span className="text-sidebar-foreground/60 tabular-nums">
              {done}/{steps.length}
            </span>
          </span>
          <Progress value={(done / steps.length) * 100} className="h-1" aria-label={`Configuración: ${done} de ${steps.length} pasos`} />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 p-2 text-[13px]">
        <p className="px-2 pt-1 pb-2 text-xs text-muted-foreground">Lo que falta para lanzar la primera corrida. Desaparece cuando está todo.</p>
        <SetupChecklist
          steps={steps}
          onStep={(id) => {
            setOpen(false)
            onStep(id)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
