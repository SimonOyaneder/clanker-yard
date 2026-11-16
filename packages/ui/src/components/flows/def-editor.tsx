import { type DefRecord, type DefWrite, type DefWriteKind, FlowDef } from "@clanker/api"
import { Maximize2, Minimize2 } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { useAppData } from "@/app-data"
import { ChangeDialog } from "@/components/flows/change-dialog"
import { FlowCanvasEditor } from "@/components/flows/flow-canvas-editor"
import { JsonEditor } from "@/components/flows/json-editor"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { lineIssues, type LineIssue, syntaxIssue } from "@/lib/def-edit"
import { cn, messageOf } from "@/lib/utils"

const DEBOUNCE_MS = 300

interface Props {
  /** La def con su versión vigente: de ahí parte el texto y contra ella se calcula el diff. */
  def: DefRecord
  kind: DefWriteKind
  /** Se guardó una versión nueva. */
  onSaved: () => void
  onCancel: () => void
}

/**
 * Edita el body de una def como JSON. Mientras se escribe, `defs.update` con `dryRun` valida con las mismas reglas
 * que el core (sin guardar) y cada error se marca en su línea. Guardar muestra el diff y crea una versión nueva.
 * Sirve igual para flujos, roles y perfiles: solo cambia el texto de los lugares (`describePath`).
 * Un flujo se edita también en un canvas: es otra vista del mismo texto, así que validar, ver el diff y guardar es
 * una sola ruta para las dos pestañas.
 */
export function DefEditor({ def, kind, onSaved, onCancel }: Props) {
  const appData = useAppData()
  const original = JSON.stringify(def.body, null, 2)
  const [text, setText] = useState(original)
  const [issues, setIssues] = useState<LineIssue[]>([])
  const [dry, setDry] = useState<DefWrite | null>(null)
  const [checking, setChecking] = useState(false)
  const [review, setReview] = useState(false)
  const [saving, setSaving] = useState(false)
  const [mode, setMode] = useState<"canvas" | "json">(kind === "flow" ? "canvas" : "json")
  const [fullscreen, setFullscreen] = useState(false)
  const latest = useRef(0)
  // El flujo que el canvas dibuja: el texto, si es JSON y tiene la forma de un flujo.
  const flow = useMemo(() => {
    if (kind !== "flow") return null
    try {
      const parsed = FlowDef.safeParse(JSON.parse(text))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }, [kind, text])

  useEffect(() => {
    const ticket = ++latest.current
    const syntax = syntaxIssue(text)
    if (syntax) {
      setIssues([syntax])
      setDry(null)
      setChecking(false)
      return
    }
    setChecking(true)
    const timer = setTimeout(() => {
      appData.updateDef({ kind, id: def.id, body: JSON.parse(text), dryRun: true }).then(
        (write) => {
          if (ticket !== latest.current) return
          setDry(write)
          setIssues(lineIssues(kind, text, write.errors))
          setChecking(false)
        },
        (e: unknown) => {
          if (ticket !== latest.current) return
          setDry(null)
          setIssues([{ line: 1, message: messageOf(e) }])
          setChecking(false)
        },
      )
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [text, appData, kind, def.id])

  // Escape sale de pantalla completa (no de la edición: no se pierde lo escrito). Un menú o diálogo abierto se queda con su Escape.
  useEffect(() => {
    if (!fullscreen || review) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) setFullscreen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [fullscreen, review])

  const save = async () => {
    setSaving(true)
    try {
      await appData.updateDef({ kind, id: def.id, body: JSON.parse(text), dryRun: false })
      toast("Guardé una versión nueva. Para volver atrás, elígela en el historial.")
      onSaved()
    } catch (e) {
      toast.error(messageOf(e))
      setReview(false)
    } finally {
      setSaving(false)
    }
  }

  const unchanged = text === original || (dry !== null && !dry.changed)
  const status = issues.length > 0 ? `${issues.length} ${issues.length === 1 ? "problema" : "problemas"} por arreglar` : checking || !dry ? "Revisando…" : unchanged ? "Sin cambios" : `${dry.diff.length} ${dry.diff.length === 1 ? "cambio" : "cambios"} por guardar`

  // Un flujo se edita enfocado: el canvas toma todo el alto y los botones van arriba, siempre a la vista.
  const focused = kind === "flow"
  const actions = (
    <div className="flex flex-none items-center gap-2">
      <Button size="sm" disabled={issues.length > 0 || checking || !dry || unchanged || saving} onClick={() => setReview(true)}>
        Guardar…
      </Button>
      <Button size="sm" variant="secondary" onClick={onCancel}>
        Cancelar
      </Button>
      <span role="status" className="text-xs text-muted-foreground">
        {status}
      </span>
    </div>
  )
  const note = <p className={cn("text-[13px] text-muted-foreground", focused && "min-w-0 flex-1 truncate")} title="Las corridas en curso siguen con la versión con que empezaron: lo que guardes vale para las corridas nuevas.">Las corridas en curso siguen con la versión con que empezaron: lo que guardes vale para las corridas nuevas.</p>

  return (
    <div className={cn("flex flex-col gap-3", focused && "h-full min-h-0 gap-2 p-3", fullscreen && "fixed inset-0 z-50 h-auto bg-background")}>
      {focused ? (
        <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-2">
          <span className="font-mono text-xs">{def.slug}</span>
          <Tabs value={mode} onValueChange={(m) => setMode(m as typeof mode)}>
            <TabsList>
              <TabsTrigger value="canvas">Canvas</TabsTrigger>
              <TabsTrigger value="json">JSON</TabsTrigger>
            </TabsList>
          </Tabs>
          {note}
          {actions}
          <Button size="sm" variant="secondary" aria-pressed={fullscreen} onClick={() => setFullscreen(!fullscreen)}>
            {fullscreen ? <Minimize2 /> : <Maximize2 />} {fullscreen ? "Salir de pantalla completa" : "Pantalla completa"}
          </Button>
        </div>
      ) : (
        note
      )}
      <div className={cn(focused && "min-h-0 flex-1")}>
        {mode === "canvas" && flow ? (
          <FlowCanvasEditor defId={def.id} flow={flow} onChange={(next) => setText(JSON.stringify(next, null, 2))} errors={dry?.errors ?? []} warnings={dry?.warnings ?? []} />
        ) : mode === "canvas" ? (
          <div className="flex flex-col gap-2 text-[13px]">
            <p>El flujo no se puede dibujar todavía: su contenido no tiene la forma de un flujo. Arréglalo en la pestaña JSON.</p>
            <ul aria-label="Problemas por arreglar" className="flex flex-col gap-1 rounded-lg border p-3 text-destructive">
              {issues.map((i) => (
                <li key={`${i.line}:${i.message}`}>{i.message}</li>
              ))}
            </ul>
          </div>
        ) : (
          <JsonEditor label={`Contenido de ${def.slug} en JSON`} value={text} onChange={setText} issues={issues} fill={focused} />
        )}
      </div>
      {focused ? null : actions}
      {review && dry ? <ChangeDialog title={`Guardar ${def.slug}`} confirmLabel="Guardar versión nueva" write={dry} kind={kind} onConfirm={() => void save()} onCancel={() => setReview(false)} /> : null}
    </div>
  )
}
