import { requestChatFocus } from "@/lib/chat-focus"
import type { ClankerProject, RunId } from "@clanker/api"
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { useAppData } from "@/app-data"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { useHost } from "@/host"
import { useToastedCommand } from "@/hooks/use-toasted-command"
import { type PrCaps, prCaps } from "@/lib/prs/pr-commands"
import { branchOf, type GithubPr, type LocalPr, type OpenPr } from "@/lib/prs/prs"
import { messageOf } from "@/lib/utils"

// Lo que una persona le pide a un PR (`prs.*` del core): mergear según la estrategia del pack, pedir la review del
// bot, rebasear, marcar hold y abrir la corrida que lo abrió. Cada comando le habla al core, avisa el resultado
// con un toast y hace releer lo que se ve. Mergear pide confirmación: comenta en GitHub con tu cuenta.

/** El clic en un PR que ya está en GitHub abre GitHub; la vista interna queda en ⌘+clic y Enter. */
export const OPEN_HINT = "Clic: abrir en GitHub · ⌘+clic o Enter: ver en la app"

/** Lo que se le puede pedir a un PR. No cambia con los datos ni con la selección: una tarjeta que solo actúa no se re-renderiza. */
export interface PrActions {
  select: (id: string | null) => void
  caps: (pr: OpenPr) => PrCaps
  /** Con la estrategia `comment` confirma antes; con `button` abre el PR en GitHub, donde se mergea. */
  merge: (pr: GithubPr) => void
  requestReview: (pr: GithubPr) => void
  rebase: (pr: GithubPr) => void
  /** Marca "no mergear nunca", o lo quita si ya estaba. */
  toggleHold: (pr: GithubPr) => void
  /** Va a la corrida que abrió el PR, en su proyecto. */
  openRun: (pr: OpenPr) => void
  /** Va a una corrida cualquiera (la que aplica la propuesta del chat), en su proyecto. */
  openRunById: (runId: RunId) => void
  /** Publica ya en GitHub un PR local, para pedir review temprano. */
  publishLocal: (pr: LocalPr) => void
  view: (pr: OpenPr) => void
  /** El clic en un PR: uno que ya está en GitHub abre GitHub; uno local, o con `internal` (⌘+clic), abre la vista interna. */
  open: (pr: OpenPr, internal: boolean) => void
  /** Abre el PR con su chat enfocado. */
  chat: (pr: OpenPr) => void
  openGithub: (pr: GithubPr) => void
}

export interface PrCommands extends PrActions {
  /** El PR sobre el que actúan los atajos y la paleta: el último que se enfocó, si sigue abierto. */
  selected: OpenPr | null
  /** Los PRs abiertos que cuelgan de `id` (apilados o con base combinada): lo que restackea aplicar un cambio en él. */
  childrenOf: (id: string) => OpenPr[]
}

const PrActionsContext = createContext<PrActions | null>(null)
const PrCommandsContext = createContext<PrCommands | null>(null)

/** Las acciones sin la selección: para lo que se dibuja una vez por PR (tarjetas, menús). */
export function usePrActions(): PrActions {
  const actions = useContext(PrActionsContext)
  if (!actions) throw new Error("usePrActions fuera de PrCommandsProvider")
  return actions
}

export function usePrCommands(): PrCommands {
  const commands = useContext(PrCommandsContext)
  if (!commands) throw new Error("usePrCommands fuera de PrCommandsProvider")
  return commands
}


interface Props {
  prs: readonly OpenPr[]
  projects: readonly ClankerProject[]
  onOpenRun: (slug: string, runId: RunId) => void
  onOpenPr: (id: string) => void
  children: ReactNode
}

export function PrCommandsProvider({ prs, projects, onOpenRun, onOpenPr, children }: Props) {
  const appData = useAppData()
  const host = useHost()
  const [selectedId, select] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<GithubPr | null>(null)

  const perform = useToastedCommand()
  // Lo que viene de la app se lee al usarse: así las acciones no cambian cada vez que App se re-renderiza.
  const latest = useRef({ projects, onOpenRun, onOpenPr })
  useEffect(() => {
    latest.current = { projects, onOpenRun, onOpenPr }
  })

  // La corrida en su proyecto; lee `latest` al usarse, así no cambia con cada render.
  const openRunById = useCallback((runId: RunId) => {
    appData.run(runId).then(
      (run) => {
        const project = latest.current.projects.find((p) => p.id === run.projectId)
        if (project) latest.current.onOpenRun(project.slug, runId)
        else toast.error("Esa corrida no es de ningún proyecto")
      },
      (e: unknown) => toast.error(messageOf(e)),
    )
  }, [appData])

  const actions = useMemo<PrActions>(
    () => ({
      select,
      caps: prCaps,
      merge: (pr) => (prCaps(pr).merge === "button" ? host.openExternal(pr.state.url) : setConfirming(pr)),
      requestReview: (pr) => void perform(() => appData.requestPrReview(pr.ref), `Le pedí review al bot en ${pr.state.key}`),
      rebase: (pr) => void perform(() => appData.rebasePr(pr.ref), `Rebase de ${pr.state.key} en marcha: corre en el carril de mantenimiento`),
      view: (pr) => {
        select(pr.id)
        latest.current.onOpenPr(pr.id)
      },
      chat: (pr) => {
        requestChatFocus(pr.id)
        select(pr.id)
        latest.current.onOpenPr(pr.id)
      },
      openGithub: (pr) => host.openExternal(pr.state.url),
      open: (pr, internal) => {
        select(pr.id)
        if (pr.local || internal) latest.current.onOpenPr(pr.id)
        else host.openExternal(pr.state.url)
      },
      publishLocal: (pr) => void perform(() => appData.publishLocalPr(pr.id), `Publicando ${branchOf(pr)} en GitHub: corre en el carril de mantenimiento`),
      toggleHold: (pr) =>
        void perform(
          () => appData.setPrHold({ ref: pr.ref, hold: !pr.state.hold }),
          pr.state.hold ? `${pr.state.key} sin hold: vuelve a ofrecerse cuando esté listo` : `${pr.state.key} en hold: no se ofrece ni se mergea`,
        ),
      openRun: (pr) => {
        if (pr.runId !== null) openRunById(pr.runId)
      },
      openRunById: (runId) => openRunById(runId),
    }),
    [appData, host, perform, openRunById],
  )
  const commands = useMemo<PrCommands>(() => ({
    ...actions,
    selected: prs.find((p) => p.id === selectedId) ?? null,
    childrenOf: (id) => prs.filter((p) => p.parents.includes(id)),
  }), [actions, prs, selectedId])

  return (
    <PrActionsContext.Provider value={actions}>
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
    </PrActionsContext.Provider>
  )
}
