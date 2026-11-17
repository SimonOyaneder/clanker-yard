import type { ClankerProject, ProjectImportResult } from "@clanker/api"
import { Download, Upload } from "lucide-react"
import { useRef, useState } from "react"
import { toast } from "sonner"
import { useAppData } from "@/app-data"
import { ClankerDirNote } from "@/components/flows/clanker-dir-note"
import { Section } from "@/components/settings-form/settings-fields"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { useLive } from "@/hooks/use-live"
import { changeKind, showValue } from "@/lib/flows/def-edit"
import { messageOf } from "@/lib/utils"

const FIELD_LABEL: Record<string, string> = {
  repos: "Repos",
  defaultFlowId: "Flujo por defecto",
  defaultProfileId: "Perfil por defecto",
  queueFilter: "Filtros de la cola",
  statusMapping: "Mapeo de estados",
  flowParams: "Parámetros del flujo",
  parallel: "Cupo del carril dev",
  stackOn: "Cuándo apilar",
  maxCostUsd: "Tope de gasto por corrida",
  conventions: "Convenciones",
}

const labelOf = (path: string) => {
  const [head = "", ...rest] = path.split(".")
  return [FIELD_LABEL[head] ?? head, ...rest].join(" · ")
}

/** Baja `text` como un archivo; en el escritorio es el diálogo de descarga de la ventana. */
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }))
  const link = document.createElement("a")
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}

interface Props {
  project: ClankerProject
  /** Con ajustes sin guardar, importar los pisaría sin que se vea: primero se guardan o se descartan. */
  disabled: boolean
}

// "Exportar configuración" e "Importar": los ajustes del proyecto como un archivo JSON para llevarlos a otra máquina
// o proyecto. Importar nunca escribe a ciegas: primero muestra qué cambia y qué no se pudo mapear a esta máquina.
export function ConfigPortSection({ project, disabled }: Props) {
  const appData = useAppData()
  const live = useLive()
  const picker = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState<{ config: unknown; file: string; preview: ProjectImportResult } | null>(null)

  const exportIt = async () => {
    try {
      const config = await appData.exportProjectConfig(project.id)
      download(`${project.slug}.clanker-project.json`, `${JSON.stringify(config, null, 2)}\n`)
      toast(`Exporté la configuración de ${project.name}.`)
    } catch (e) {
      toast.error(messageOf(e))
    }
  }

  const choose = async (file: File | undefined) => {
    if (picker.current) picker.current.value = ""
    if (!file) return
    let config: unknown
    try {
      config = JSON.parse(await file.text())
    } catch {
      toast.error(`${file.name} no es un JSON: elige un archivo que haya salido de "Exportar configuración".`)
      return
    }
    try {
      setPending({ config, file: file.name, preview: await appData.importProjectConfig({ projectId: project.id, config, dryRun: true }) })
    } catch (e) {
      toast.error(messageOf(e))
    }
  }

  const apply = async () => {
    if (!pending) return
    try {
      await appData.importProjectConfig({ projectId: project.id, config: pending.config, dryRun: false })
      toast(`Importé la configuración en ${project.name}.`)
      live.refresh()
    } catch (e) {
      toast.error(messageOf(e))
    } finally {
      setPending(null)
    }
  }

  const preview = pending?.preview
  const blocked = (preview?.errors.length ?? 0) > 0
  const nothing = preview !== undefined && !blocked && preview.changes.length === 0

  return (
    <Section
      id="config"
      title="Exportar e importar"
      description="Lleva los ajustes de este proyecto a otra máquina o proyecto: repos (por nombre y remoto de GitHub), filtros, mapeo de estados, flujo, perfil, parámetros y convenciones. No incluye cuentas ni tokens."
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={() => void exportIt()}>
          <Download /> Exportar configuración
        </Button>
        <Button size="sm" variant="secondary" onClick={() => picker.current?.click()} disabled={disabled}>
          <Upload /> Importar…
        </Button>
        <input ref={picker} type="file" accept="application/json,.json" aria-label="Archivo de configuración" className="hidden" onChange={(e) => void choose(e.target.files?.[0])} />
        {disabled ? <span className="text-xs text-muted-foreground">Guarda o descarta los cambios de abajo antes de importar.</span> : null}
      </div>
      <ClankerDirNote />
      <p className="text-xs text-muted-foreground">Los flujos, roles y perfiles viajan con el repo: en Flujos, "Exportar al repo" abre un PR con el archivo.</p>

      {pending && preview ? (
        <AlertDialog open onOpenChange={(open) => !open && setPending(null)}>
          <AlertDialogContent className="sm:max-w-2xl">
            <AlertDialogHeader>
              <AlertDialogTitle>Importar {pending.file}</AlertDialogTitle>
              <AlertDialogDescription>
                {blocked ? "No se puede importar todavía: arregla esto primero. No se escribió nada." : nothing ? "Este proyecto ya tiene esta configuración: no cambia nada." : `Esto cambia en ${project.name}. Lo que no se pudo mapear se deja como está.`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <ul aria-label="Cambios" className="max-h-72 divide-y overflow-auto rounded-lg border text-[13px]">
              {preview.errors.map((e, i) => (
                <li key={`e${i}`} className="px-3 py-2 text-destructive">
                  {e.path ? `${labelOf(e.path)}: ` : ""}
                  {e.message}
                </li>
              ))}
              {preview.changes.map((change) => {
                const how = changeKind(change)
                return (
                  <li key={change.path} className="flex flex-col gap-0.5 px-3 py-2">
                    <span>
                      {labelOf(change.path)} <span className="text-muted-foreground">({how === "added" ? "nuevo" : how === "removed" ? "se quita" : "cambia"})</span>
                    </span>
                    <span className="font-mono text-xs break-all">
                      {how !== "added" ? <del className="text-destructive">{showValue(change.before)}</del> : null}
                      {how === "changed" ? " → " : null}
                      {how !== "removed" ? <ins className="text-emerald-700 no-underline dark:text-emerald-400">{showValue(change.after)}</ins> : null}
                    </span>
                  </li>
                )
              })}
            </ul>
            {preview.unmapped.length > 0 ? (
              <div className="flex flex-col gap-1">
                <h3 className="text-[13px] font-medium">No se pudo mapear a esta máquina</h3>
                <ul aria-label="Sin mapear" className="divide-y rounded-lg border text-[13px]">
                  {preview.unmapped.map((u, i) => (
                    <li key={i} className="px-3 py-2 text-amber-700 dark:text-amber-400">
                      {u.message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel>{blocked || nothing ? "Cerrar" : "Cancelar"}</AlertDialogCancel>
              {blocked || nothing ? null : <AlertDialogAction onClick={() => void apply()}>Importar</AlertDialogAction>}
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </Section>
  )
}
