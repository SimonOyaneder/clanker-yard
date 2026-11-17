import type { ClankerProject, RunId } from "@clanker/api"
import { createContext, type ReactNode, useContext, useMemo, useState } from "react"
import { toast } from "sonner"
import { useAppData } from "@/app-data"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { useHost } from "@/host"
import { useToastedCommand } from "@/hooks/use-toasted-command"
import { type PrCaps, prCaps } from "@/lib/pr-commands"
import type { OpenPr } from "@/lib/prs"
import { messageOf } from "@/lib/utils"

// Lo que una persona le pide a un PR (`prs.*` del core): mergear según la estrategia del pack, pedir la review del
// bot, rebasear, marcar hold y abrir la corrida que lo abrió. Cada comando le habla al core, avisa el resultado
// con un toast y hace releer lo que se ve. Mergear pide confirmación: comenta en GitHub con tu cuenta.

export interface PrCommands {
  /** El PR sobre el que actúan los atajos y la paleta: el último que se enfocó, si sigue abierto. */
  selected: OpenPr | null
  select: (id: string | null) => void
  caps: (pr: OpenPr) => PrCaps
  /** Con la estrategia `comment` confirma antes; con `button` abre el PR en GitHub, donde se mergea. */
  merge: (pr: OpenPr) => void
  requestReview: (pr: OpenPr) => void
  rebase: (pr: OpenPr) => void
  /** Marca "no mergear nunca", o lo quita si ya estaba. */
  toggleHold: (pr: OpenPr) => void
  /** Va a la corrida que abrió el PR, en su proyecto. */
  openRun: (pr: OpenPr) => void
}

const PrCommandsContext = createContext<PrCommands | null>(null)

export function usePrCommands(): PrCommands {
  const commands = useContext(PrCommandsContext)
  if (!commands) throw new Error("usePrCommands fuera de PrCommandsProvider")
  return commands
}


interface Props {
  prs: readonly OpenPr[]
  projects: readonly ClankerProject[]
  onOpenRun: (slug: string, runId: RunId) => void
  children: ReactNode
}

export function PrCommandsProvider({ prs, projects, onOpenRun, children }: Props) {
  const appData = useAppData()
  const host = useHost()
  const [selectedId, select] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<OpenPr | null>(null)

  const perform = useToastedCommand()

  const commands = useMemo<PrCommands>(
    () => ({
      selected: prs.find((p) => p.id === selectedId) ?? null,
      select,
      caps: prCaps,
      merge: (pr) => (prCaps(pr).merge === "button" ? host.openExternal(pr.state.url) : setConfirming(pr)),
      requestReview: (pr) => void perform(() => appData.requestPrReview(pr.ref), `Le pedí review al bot en ${pr.state.key}`),
      rebase: (pr) => void perform(() => appData.rebasePr(pr.ref), `Rebase de ${pr.state.key} en marcha: corre en el carril de mantenimiento`),
      toggleHold: (pr) =>
        void perform(
          () => appData.setPrHold(pr.ref, !pr.state.hold),
          pr.state.hold ? `${pr.state.key} sin hold: vuelve a ofrecerse cuando esté listo` : `${pr.state.key} en hold: no se ofrece ni se mergea`,
        ),
      openRun: (pr) => {
        const runId = pr.runId
        if (runId === null) return
        appData.run(runId).then(
          (run) => {
            const project = projects.find((p) => p.id === run.projectId)
            if (project) onOpenRun(project.slug, runId)
            else toast.error("La corrida que abrió este PR no es de ningún proyecto")
          },
          (e: unknown) => toast.error(messageOf(e)),
        )
      },
    }),
    [prs, selectedId, appData, host, perform, projects, onOpenRun],
  )

  return (
    <PrCommandsContext.Provider value={commands}>
      {children}
      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Mergear {confirming?.state.key}?</AlertDialogTitle>
            <AlertDialogDescription>
              Se comenta <code className="rounded bg-muted px-1 py-px font-mono text-[12px]">{confirming?.state.merge.command}</code> en el PR desde tu cuenta de GitHub, y la estrategia del pack lo mergea. Antes se
              relee el PR: si ya no está listo, no se comenta nada.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Volver</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirming) void perform(() => appData.mergePr(confirming.ref), `Pedí el merge de ${confirming.state.key}`)
              }}
            >
              Mergear
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PrCommandsContext.Provider>
  )
}
