import type { DefRecord, DefWrite, DefWriteKind } from "@clanker/api"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { useAppData } from "@/app-data"
import { ChangeDialog } from "@/components/flows/change-dialog"
import { JsonEditor } from "@/components/flows/json-editor"
import { Button } from "@/components/ui/button"
import { lineIssues, type LineIssue, syntaxIssue } from "@/lib/def-edit"
import { messageOf } from "@/lib/undoable"

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
  const latest = useRef(0)

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

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-muted-foreground">Las corridas en curso siguen con la versión con que empezaron: lo que guardes vale para las corridas nuevas.</p>
      <JsonEditor label={`Contenido de ${def.slug} en JSON`} value={text} onChange={setText} issues={issues} />
      <div className="flex items-center gap-2">
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
      {review && dry ? <ChangeDialog title={`Guardar ${def.slug}`} confirmLabel="Guardar versión nueva" write={dry} kind={kind} onConfirm={() => void save()} onCancel={() => setReview(false)} /> : null}
    </div>
  )
}
