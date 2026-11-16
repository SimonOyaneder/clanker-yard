import type { ClankerProject, RunId, StepRunId } from "@clanker/api"
import { createContext, type ReactNode, useContext, useMemo, useState } from "react"
import { useAppData } from "@/app-data"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { usePerform } from "@/hooks/use-perform"

// Lo que una persona le pide a una corrida, a un paso o a un proyecto. Cada comando le habla al core, avisa el
// resultado con un toast y hace releer lo que se ve. Lo irreversible o que corta trabajo (cancelar, interrumpir,
// forzar un resultado) pide confirmación; el mensaje a un agente, el texto.

export interface RunCommands {
  pause: (id: RunId) => void
  resume: (id: RunId) => void
  /** Confirma antes: el agente en curso se detiene (con su sesión guardada, `resume` la retoma). */
  interrupt: (id: RunId) => void
  /** Confirma antes: no se puede deshacer. */
  cancel: (id: RunId) => void
  /** `label` es el nodo, para el aviso. */
  retry: (stepId: StepRunId, label: string) => void
  /** Abre el cuadro del mensaje para el agente de ese paso. */
  steer: (stepId: StepRunId, label: string) => void
  /** Confirma antes: el paso no corre y la corrida sigue por el edge de `outcome`. */
  force: (stepId: StepRunId, label: string, outcome: string) => void
  pauseProject: (project: ClankerProject) => void
  resumeProject: (project: ClankerProject) => void
}

const RunCommandsContext = createContext<RunCommands | null>(null)

export function useRunCommands(): RunCommands {
  const commands = useContext(RunCommandsContext)
  if (!commands) throw new Error("useRunCommands fuera de RunCommandsProvider")
  return commands
}

interface Confirm {
  title: string
  description: string
  action: string
  destructive: boolean
  run: () => Promise<unknown>
  done: string
}


export function RunCommandsProvider({ children }: { children: ReactNode }) {
  const appData = useAppData()
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [steer, setSteer] = useState<{ stepId: StepRunId; label: string } | null>(null)

  const perform = usePerform()

  const commands = useMemo<RunCommands>(
    () => ({
      pause: (id) => void perform(() => appData.pauseRun(id), "Corrida pausada: los agentes en curso terminan lo suyo"),
      resume: (id) => void perform(() => appData.resumeRun(id), "Corrida retomada"),
      interrupt: (id) =>
        setConfirm({
          title: "¿Interrumpir la corrida?",
          description: "El agente en curso se detiene ahora y la corrida queda pausada. Al retomarla, el agente sigue su sesión donde iba, sin gastar un intento.",
          action: "Interrumpir",
          destructive: false,
          run: () => appData.interruptRun(id),
          done: "Corrida interrumpida",
        }),
      cancel: (id) =>
        setConfirm({
          title: "¿Cancelar la corrida?",
          description: "Termina la corrida y sus subflujos: los agentes en curso se detienen y la corrida no se puede retomar. El worktree se suelta.",
          action: "Cancelar corrida",
          destructive: true,
          run: () => appData.cancelRun(id),
          done: "Corrida cancelada",
        }),
      retry: (stepId, label) => void perform(() => appData.retryStep(stepId), `Reintentando desde ${label}, con una sesión nueva`),
      steer: (stepId, label) => setSteer({ stepId, label }),
      force: (stepId, label, outcome) =>
        setConfirm({
          title: `¿Forzar «${outcome}» en ${label}?`,
          description: `El paso no se ejecuta (o deja de esperar) y la corrida sigue por el edge «${outcome}». Queda registrado quién lo forzó.`,
          action: "Forzar resultado",
          destructive: true,
          run: () => appData.forceOutcome(stepId, outcome),
          done: `${label} terminó con «${outcome}»`,
        }),
      pauseProject: (project) => void perform(() => appData.pauseProject(project.id), `${project.name} pausado: no lanza issues nuevas, lo que ya corre sigue`),
      resumeProject: (project) => void perform(() => appData.resumeProject(project.id), `${project.name} reanudado`),
    }),
    [appData, perform],
  )

  return (
    <RunCommandsContext.Provider value={commands}>
      {children}
      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Volver</AlertDialogCancel>
            <AlertDialogAction
              variant={confirm?.destructive ? "destructive" : "default"}
              onClick={() => {
                if (confirm) void perform(confirm.run, confirm.done)
              }}
            >
              {confirm?.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <SteerDialog
        target={steer}
        onClose={() => setSteer(null)}
        onSend={(message) => {
          if (steer) void perform(() => appData.steerStep(steer.stepId, message), `Mensaje enviado a ${steer.label}`)
          setSteer(null)
        }}
      />
    </RunCommandsContext.Provider>
  )
}

function SteerDialog({ target, onClose, onSend }: { target: { stepId: StepRunId; label: string } | null; onClose: () => void; onSend: (message: string) => void }) {
  const [message, setMessage] = useState("")
  const send = () => {
    if (!message.trim()) return
    onSend(message.trim())
    setMessage("")
  }
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Mensaje para el agente de {target?.label}</DialogTitle>
          <DialogDescription>Si está trabajando, se detiene y retoma su sesión con tu mensaje. Si ya falló, la corrida sigue desde este paso con la misma sesión.</DialogDescription>
        </DialogHeader>
        <Textarea
          autoFocus
          aria-label="Mensaje para el agente"
          placeholder="Qué tiene que hacer distinto"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send()
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Volver
          </Button>
          <Button disabled={!message.trim()} onClick={send}>
            Enviar mensaje
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
