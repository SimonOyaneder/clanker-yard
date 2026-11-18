import { type ReactNode, useEffect } from "react"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from "@/components/ui/context-menu"
import { isTypingTarget } from "@/lib/keys"
import { whyNotMerge } from "@/lib/prs/pr-commands"
import { branchOf, type OpenPr } from "@/lib/prs/prs"
import { copy } from "./pr-bits"
import { usePrCommands } from "./pr-commands"

/** Los atajos de las acciones de un PR, con el PR enfocado: la vista de PRs, el menú contextual y la paleta los comparten. */
export const PR_KEYS = { merge: "M", requestReview: "B", rebase: "R", hold: "H", run: "V", publishLocal: "P", view: "↵", openGithub: "O" } as const

export function usePrShortcuts() {
  const commands = usePrCommands()
  const { selected } = commands
  // Los atajos de las acciones actúan sobre el PR enfocado; en un campo, un diálogo o un menú son letras.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selected || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
      if (isTypingTarget(e.target, ["[role='dialog']", "[role='alertdialog']", "[role='menu']", "[role='listbox']"])) return
      const caps = commands.caps(selected)
      const key = e.key.toUpperCase()
      if (key === PR_KEYS.merge && caps.merge && !selected.local) commands.merge(selected)
      else if (key === PR_KEYS.requestReview && caps.requestReview && !selected.local) commands.requestReview(selected)
      else if (key === PR_KEYS.rebase && caps.rebase && !selected.local) commands.rebase(selected)
      else if (key === PR_KEYS.hold && caps.hold && !selected.local) commands.toggleHold(selected)
      else if (key === PR_KEYS.run && caps.run) commands.openRun(selected)
      else if (key === PR_KEYS.publishLocal && caps.publishLocal && selected.local) commands.publishLocal(selected)
      else if (key === PR_KEYS.openGithub && !selected.local) commands.openGithub(selected)
      else return
      e.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [selected, commands])
}

/** El menú contextual de un PR (tarjeta del grafo y fila de la lista): lo que se puede abrir, pedirle al core y copiar. */
export function PrContextMenu({ pr, children }: { pr: OpenPr; children: ReactNode }) {
  const commands = usePrCommands()
  const caps = commands.caps(pr)
  const blocked = pr.local ? undefined : whyNotMerge(pr)
  return (
    <ContextMenu onOpenChange={(open) => open && commands.select(pr.id)}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      {/* El menú está dentro del nodo del grafo: sin esto, el click en un ítem también abre el PR (`onNodeClick`). */}
      <ContextMenuContent className="w-64" onClick={(e) => e.stopPropagation()}>
        <ContextMenuItem onSelect={() => commands.view(pr)}>
          Ver PR <ContextMenuShortcut>{PR_KEYS.view}</ContextMenuShortcut>
        </ContextMenuItem>
        {!pr.local ? (
          <ContextMenuItem onSelect={() => commands.openGithub(pr)}>
            Abrir PR en GitHub <ContextMenuShortcut>{PR_KEYS.openGithub}</ContextMenuShortcut>
          </ContextMenuItem>
        ) : null}
        {pr.local && caps.publishLocal ? (
          <ContextMenuItem onSelect={() => commands.publishLocal(pr)}>
            Publicar ahora <ContextMenuShortcut>{PR_KEYS.publishLocal}</ContextMenuShortcut>
          </ContextMenuItem>
        ) : null}
        {pr.runId !== null ? (
          <ContextMenuItem onSelect={() => commands.openRun(pr)}>
            Ver corrida <ContextMenuShortcut>{PR_KEYS.run}</ContextMenuShortcut>
          </ContextMenuItem>
        ) : null}
        {!pr.local ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem disabled={caps.merge === null} onSelect={() => commands.merge(pr)} title={blocked}>
              {caps.merge === "button" ? "Mergear en GitHub" : "Mergear…"}
              <ContextMenuShortcut>{PR_KEYS.merge}</ContextMenuShortcut>
            </ContextMenuItem>
            {caps.requestReview ? (
              <ContextMenuItem onSelect={() => commands.requestReview(pr)}>
                Pedir review del bot <ContextMenuShortcut>{PR_KEYS.requestReview}</ContextMenuShortcut>
              </ContextMenuItem>
            ) : null}
            {caps.rebase ? (
              <ContextMenuItem onSelect={() => commands.rebase(pr)}>
                Rebasear <ContextMenuShortcut>{PR_KEYS.rebase}</ContextMenuShortcut>
              </ContextMenuItem>
            ) : null}
            <ContextMenuItem onSelect={() => commands.toggleHold(pr)}>
              {pr.state.hold ? "Quitar hold" : "Marcar hold (no mergear nunca)"} <ContextMenuShortcut>{PR_KEYS.hold}</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => copy(pr.state.url, "el link")}>Copiar link</ContextMenuItem>
          </>
        ) : null}
        <ContextMenuItem onSelect={() => copy(branchOf(pr), "la branch")}>Copiar branch</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
