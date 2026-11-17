import type { ClankerProject, DecisionId, RunDetail, RunId } from "@clanker/api"
import { useEffect, useRef } from "react"
import { toast } from "sonner"
import { PROJECT_TABS, type ProjectTab } from "@/components/project/project-view"
import type { RunCommands } from "@/components/run/run-commands"
import { STEP_TAB_KEYS, type StepTab } from "@/components/run/step-panel"
import type { RunTab } from "@/components/run/run-view"
import { isTypingTarget, overlayOpen } from "@/lib/keys"
import type { runCaps } from "@/lib/project/run-commands"

/** Lo que los atajos globales de la app leen y hacen; lo arma `Shell` en cada render. */
export interface ShellShortcuts {
  module: string
  /** Los proyectos de la barra, en orden: ⌘1 a ⌘9. */
  barSlugs: readonly string[]
  selectProject(slug: string): void
  goInbox(): void
  goLearnings(): void
  goConnections(): void
  goTab(tab: ProjectTab): void
  connectLinear(): void
  probeClaude(): Promise<void>
  /** Deshace la última decisión respondida; devuelve su id si había una. */
  undoDecision(): DecisionId | null
  /** Deshace la última decisión de learnings que todavía no se mandó. */
  undoLearnings(): boolean
  selectDecision(id: DecisionId): void
  runId: RunId | null
  /** La corrida abierta, si ya se leyó. */
  run: RunDetail | undefined
  caps: ReturnType<typeof runCaps> | null
  commands: RunCommands
  project: ClankerProject | null
  stepNode: string | null
  closeStep(): void
  closeRun(): void
  setRunTab(tab: RunTab): void
  setStepTab(tab: StepTab): void
}

/**
 * Los atajos de teclado de la ventana, en un solo listener que lee siempre lo último de `shortcuts`. El
 * historial (⌘[, ⌘], ⌘←, ⌘→) lo maneja `useNavHistory`; cada vista maneja los suyos.
 */
export function useShellShortcuts(shortcuts: ShellShortcuts): void {
  const latest = useRef(shortcuts)
  latest.current = shortcuts

  useEffect(() => {
    // G y luego I, A o C (como en Linear): el G queda armado un segundo.
    let armed: ReturnType<typeof setTimeout> | undefined
    const handlers: ((e: KeyboardEvent, s: ShellShortcuts) => boolean | void)[] = [
      // ⌘1 a ⌘9: el proyecto de la barra en ese lugar.
      (e, s) => {
        if (!e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return
        const digit = /^Digit([1-9])$/.exec(e.code)?.[1]
        const target = digit ? s.barSlugs[Number(digit) - 1] : undefined
        if (!target) return
        s.selectProject(target)
        return true
      },
      // ⇧⌘I y ⇧⌘A van a la Bandeja y a Learnings, ⇧⌘L conecta Linear y ⇧⌘T prueba Claude.
      (e, s) => {
        if (!e.metaKey || !e.shiftKey || e.altKey || e.ctrlKey) return
        if (e.code === "KeyL") s.connectLinear()
        else if (e.code === "KeyI") s.goInbox()
        else if (e.code === "KeyA") s.goLearnings()
        else if (e.code === "KeyT") void s.probeClaude()
        else return
        return true
      },
      // G y luego C, A o I: Conexiones, Learnings o la Bandeja.
      (e, s) => {
        if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
        if (isTypingTarget(e.target, ["[role='dialog']"])) return
        const key = e.key.toLowerCase()
        const fired = armed !== undefined && (key === "c" || key === "i" || key === "a")
        if (fired) {
          if (key === "c") s.goConnections()
          else if (key === "a") s.goLearnings()
          else s.goInbox()
        }
        clearTimeout(armed)
        armed = key === "g" ? setTimeout(() => (armed = undefined), 1000) : undefined
        return fired
      },
      // ⇧⌘1, ⇧⌘2 y ⇧⌘3: Operación, Resumen y Ajustes del proyecto (también desde una corrida: vuelve al proyecto).
      (e, s) => {
        if (!e.metaKey || !e.shiftKey || e.altKey || e.ctrlKey) return
        const target = { Digit1: PROJECT_TABS[0], Digit2: PROJECT_TABS[1], Digit3: PROJECT_TABS[2] }[e.code]
        if (!target) return
        s.goTab(target)
        return true
      },
      // Z deshace la última decisión que se respondió (o, sin ella, la última de learnings) mientras no se haya mandado al core.
      (e, s) => {
        if (e.key.toLowerCase() !== "z" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat) return
        if (isTypingTarget(e.target, ["[role='dialog']"])) return
        const undone = s.undoDecision()
        if (!undone) return s.undoLearnings()
        if (s.module === "inbox") s.selectDecision(undone)
        else toast("Volvió a la bandeja", { duration: 1500 })
        return true
      },
      // Esc sube un nivel: del panel del paso a la corrida y de la corrida al proyecto, salvo que haya un diálogo o menú abierto.
      (e, s) => {
        if (e.key !== "Escape" || !s.runId || s.module !== "projects" || overlayOpen()) return
        if (s.stepNode) s.closeStep()
        else s.closeRun()
      },
      // G y L cambian entre el grafo y la línea de tiempo de la corrida abierta; con el panel de un paso, T, B, R, A e I eligen su pestaña.
      (e, s) => {
        if (!s.runId || s.module !== "projects" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
        if (isTypingTarget(e.target) || overlayOpen()) return
        const key = e.key.toLowerCase()
        const tab = key === "g" ? "graph" : key === "l" ? "timeline" : null
        if (tab) return s.setRunTab(tab)
        const step = s.stepNode ? STEP_TAB_KEYS[key] : undefined
        // La pestaña principal depende del nodo (transcript o comando): `transcript` cae a la primera de las suyas.
        if (step) s.setStepTab(step === "main" ? "transcript" : step)
      },
      // ⌘. interrumpe, ⇧⌘. pausa o retoma, ⇧⌘R reintenta el paso fallido, ⇧⌘⌫ cancela la corrida abierta y ⇧⌘Y pausa o reanuda el proyecto.
      (e, s) => {
        if (!e.metaKey || e.altKey || e.ctrlKey || s.module !== "projects") return
        const { caps, commands, project } = s
        const run = s.runId && s.run?.id === s.runId ? s.run : undefined
        if (!e.shiftKey && e.code === "Period" && run && caps?.interrupt) commands.interrupt(run.id)
        else if (e.shiftKey && e.code === "Period" && run && caps?.pause) commands.pause(run.id)
        else if (e.shiftKey && e.code === "Period" && run && caps?.resume) commands.resume(run.id)
        else if (e.shiftKey && e.code === "KeyR" && caps?.failedStep) commands.retry(caps.failedStep.id, caps.failedStep.nodeId)
        else if (e.shiftKey && e.key === "Backspace" && run && caps?.cancel) commands.cancel(run.id)
        else if (e.shiftKey && e.code === "KeyY" && !s.runId && project?.status === "active") commands.pauseProject(project)
        else if (e.shiftKey && e.code === "KeyY" && !s.runId && project?.status === "paused") commands.resumeProject(project)
        else return
        return true
      },
    ]
    // Cada atajo mira la tecla por su cuenta, como si tuviera su listener; el que la usa la marca como usada.
    const onKey = (e: KeyboardEvent) => {
      for (const handle of handlers) if (handle(e, latest.current) === true) e.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => {
      clearTimeout(armed)
      window.removeEventListener("keydown", onKey)
    }
  }, [])
}
