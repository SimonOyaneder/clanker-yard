import { Archive, ArchiveRestore, Copy, ExternalLink, Eye, MoreHorizontal, Play, RotateCcw, Square } from "lucide-react"
import type { Loop } from "@/types"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { isRunning, lastSession, useAppActions } from "@/lib/app-context"
import { copy } from "@/lib/clipboard"
import { tone } from "@/lib/format"
import { Hint } from "../common"

// Qué dice `claude agents` de la sesión del EM.
export function agentLabel(loop: Loop): { text: string; tone: string; hint: string } | null {
  const a = loop.agent
  if (!a) return null
  if (a.kind === "interactive")
    return {
      text: `en una terminal${a.status === "busy" ? " · trabajando" : ""}`,
      tone: tone.sky,
      hint: "El EM corre en una sesión interactiva de Claude Code abierta en una terminal, no en background",
    }
  if (a.state === "blocked") return { text: "te está esperando", tone: tone.amber, hint: "El EM está detenido esperando tu respuesta: una pregunta o un permiso." }
  if (a.status === "busy") return { text: "background · trabajando", tone: tone.violet, hint: "El EM corre en background (claude --bg) y está procesando ahora" }
  return { text: "background · en espera", tone: tone.neutral, hint: "El EM corre en background (claude --bg) y está esperando el próximo evento: un slot que termina o el vigilante de PRs" }
}

// Botón principal visible y el resto en "…", como en Linear.
export function AgentControls({ loop }: { loop: Loop }) {
  const actions = useAppActions()
  const a = loop.agent
  const bg = a?.kind === "background" && a.id
  const running = isRunning(loop)
  const session = lastSession(loop)

  return (
    <div className="flex items-center gap-1.5">
      {!running && session ? (
        <Hint label={`claude --bg --resume ${session.id.slice(0, 8)}`}>
          <Button size="sm" variant="secondary" onClick={() => void actions.resume(loop)}>
            <RotateCcw /> Reanudar
          </Button>
        </Hint>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="ghost" className="size-8" aria-label="Más acciones del loop">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {!running ? (
            <>
              {session ? (
                <DropdownMenuItem onSelect={() => void actions.resume(loop)}>
                  <RotateCcw /> Reanudar en background
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onSelect={() => void actions.run(loop)}>
                <Play /> Correr loop de nuevo
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void actions.watch(loop)}>
                <Eye /> Solo vigilar PRs
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          {bg ? (
            <DropdownMenuItem onSelect={() => copy(`claude attach ${a.id}`, "el comando para attacharte al EM")}>
              <Copy />
              <span className="flex min-w-0 flex-col">
                <span>Copiar comando de attach</span>
                <span className="font-mono text-[11px] text-muted-foreground">claude attach {a.id}</span>
              </span>
            </DropdownMenuItem>
          ) : null}
          {loop.projectUrl ? (
            <DropdownMenuItem onSelect={() => actions.openLinear(loop)}>
              <ExternalLink /> Abrir proyecto en Linear
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => actions.setArchived(loop, !loop.archived)}>
            {loop.archived ? <ArchiveRestore /> : <Archive />}
            {loop.archived ? "Desarchivar" : "Archivar"}
          </DropdownMenuItem>
          {bg ? (
            <DropdownMenuItem variant="destructive" onSelect={() => actions.requestStop(loop)}>
              <Square /> Detener EM…
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
