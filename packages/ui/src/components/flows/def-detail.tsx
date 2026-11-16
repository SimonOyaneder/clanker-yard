import { type DefRecord, type DefWrite, type DefWriteKind, FlowDef, Profile, Role } from "@clanker/api"
import { Archive, ArchiveRestore, Braces, Copy, GitPullRequestDraft, Pencil, Undo2 } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { useAppData } from "@/app-data"
import { Ago } from "@/components/common"
import { ChangeDialog } from "@/components/flows/change-dialog"
import { DefEditor } from "@/components/flows/def-editor"
import { ExportToRepoDialog } from "@/components/flows/export-to-repo-dialog"
import { RowPills, UsedBy } from "@/components/flows/flow-parts"
import { ProfileForm } from "@/components/flows/profile-form"
import { RoleForm } from "@/components/flows/role-form"
import { FlowDefGraph } from "@/components/project/run-graph"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { useLiveQuery } from "@/hooks/use-live"
import { profileSummary } from "@/lib/def-form"
import { duplicateOf, isReadOnly, KIND_LABEL, type LibraryRow, nameOf, repoOrigin, sourceLabel } from "@/lib/defs-library"
import { messageOf, undoable } from "@/lib/undoable"
import { cn } from "@/lib/utils"

interface Props {
  row: LibraryRow
  /** Todas las defs del kind (archivadas incluidas): de ahí sale un slug libre para la copia. */
  defs: DefRecord[]
  /** Quien tiene la lista la relee tras cada cambio, y abre la def que se acaba de crear. */
  onChanged: (opened?: DefRecord) => void
  /** Un flujo en edición pide toda la vista: quien tiene la lista la esconde mientras `on`. */
  onFocusChange?: (on: boolean) => void
}

// Una def a la vista: de dónde viene, quién la usa, su contenido en la versión elegida y el historial de versiones.
// Las acciones son las que el core acepta: duplicar cualquiera; archivar y restaurar solo lo tuyo.
export function DefDetail({ row, defs, onChanged, onFocusChange }: Props) {
  const appData = useAppData()
  const { def } = row
  const [version, setVersion] = useState<number | null>(null)
  const [confirmArchive, setConfirmArchive] = useState(false)
  // Roles y perfiles se editan con su formulario; el JSON es la salida avanzada y lo único que tienen los flujos.
  const [editing, setEditing] = useState<"form" | "json" | null>(null)
  const [exporting, setExporting] = useState(false)
  const [revert, setRevert] = useState<{ to: DefRecord; write: DefWrite } | null>(null)
  const kind = def.kind as DefWriteKind
  const repos = useLiveQuery("def-repos", () => appData.repos(), { live: false })
  const versions = useLiveQuery(`def-versions:${kind}:${def.id}:${def.currentVersion}`, () => appData.defVersions(kind, def.id), { live: false })
  const shown = versions.data?.find((v) => v.version === version) ?? versions.data?.[0]
  const readOnly = isReadOnly(def)
  const archived = def.archivedAt !== null
  const editable = !readOnly && !archived

  const focused = editing === "json" && kind === "flow"
  useEffect(() => {
    if (!focused) return
    onFocusChange?.(true)
    return () => onFocusChange?.(false)
  }, [focused, onFocusChange])

  const duplicate = async () => {
    const copy = duplicateOf(def, defs)
    let created: DefRecord | undefined
    const failure = await undoable(
      copy.overrides ? `Ahora tienes tu propio ${KIND_LABEL[kind].singular} "${copy.slug}": manda sobre el incluido` : `Creé "${copy.slug}", una copia tuya`,
      async () => {
        created = await appData.createDef({ kind, slug: copy.slug, body: copy.body })
        onChanged(created)
      },
      async () => {
        if (created) await appData.archiveDef(kind, created.id)
        onChanged()
      },
    )
    return failure
  }
  // Volver a una versión es una versión nueva con ese contenido: antes se muestra qué cambia (o por qué ya no cabe).
  const askRevert = async (to: DefRecord) => {
    try {
      setRevert({ to, write: await appData.updateDef({ kind, id: def.id, body: to.body, dryRun: true }) })
    } catch (e) {
      toast.error(messageOf(e))
    }
  }
  const confirmRevert = async () => {
    if (!revert) return
    try {
      await appData.updateDef({ kind, id: def.id, body: revert.to.body, dryRun: false })
      toast(`Volví a la versión ${revert.to.version}: quedó como versión nueva.`)
      setVersion(null)
      onChanged()
    } catch (e) {
      toast.error(messageOf(e))
    } finally {
      setRevert(null)
    }
  }
  const saved = () => {
    setEditing(null)
    setVersion(null)
    onChanged()
  }
  const archive = () =>
    undoable(
      `Archivé ${nameOf(def)}`,
      () => appData.archiveDef(kind, def.id).then(() => onChanged()),
      () => appData.restoreDef(kind, def.id).then(() => onChanged()),
    )
  const restore = () =>
    undoable(
      `Restauré ${nameOf(def)}`,
      () => appData.restoreDef(kind, def.id).then(() => onChanged()),
      () => appData.archiveDef(kind, def.id).then(() => onChanged()),
    )
  // Archivar lo que un proyecto usa y nada más lo reemplaza lo deja sin eso: antes se pregunta.
  const askArchive = () => (row.projects.length > 0 && row.overrides === null ? setConfirmArchive(true) : void archive())

  if (focused) return <DefEditor def={def} kind={kind} onCancel={() => setEditing(null)} onSaved={saved} />

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto px-6 py-5">
      <header className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-medium">{nameOf(def)}</h2>
            <p className="font-mono text-xs text-muted-foreground">{def.slug}</p>
            {def.scope === "repo" ? <RepoOrigin def={def} repoName={repos.data?.find((r) => r.repo.id === def.repoId)?.repo.name} /> : null}
          </div>
          <div className="flex flex-none items-center gap-2">
            <Button size="sm" variant={readOnly ? "default" : "secondary"} onClick={() => void duplicate()}>
              <Copy /> {readOnly ? "Duplicar para editar" : "Duplicar"}
            </Button>
            {editable && !editing && kind !== "flow" ? (
              <Button size="sm" onClick={() => setEditing("form")}>
                <Pencil /> Editar
              </Button>
            ) : null}
            {editable && !editing ? (
              <Button size="sm" variant={kind === "flow" ? "default" : "secondary"} onClick={() => setEditing("json")}>
                {kind === "flow" ? <Pencil /> : <Braces />} {kind === "flow" ? "Editar" : "Editar JSON (avanzado)"}
              </Button>
            ) : null}
            {editable && def.scope === "user" ? (
              <Button size="sm" variant="secondary" onClick={() => setExporting(true)}>
                <GitPullRequestDraft /> Exportar al repo
              </Button>
            ) : null}
            {editable ? (
              <Button size="sm" variant="secondary" onClick={askArchive}>
                <Archive /> Archivar
              </Button>
            ) : null}
            {!readOnly && archived ? (
              <Button size="sm" variant="secondary" onClick={() => void restore()}>
                <ArchiveRestore /> Restaurar
              </Button>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <RowPills row={row} />
          <span className="text-xs text-muted-foreground tabular-nums">versión {def.currentVersion}</span>
        </div>
        <p className="text-[13px] text-pretty text-muted-foreground">{explain(row, kind)}</p>
        <p className="text-[13px]">
          <span className="text-muted-foreground">Se usa en: </span>
          <UsedBy projects={row.projects} internal={row.internal} />
        </p>
      </header>

      <section aria-label="Contenido" className={cn("flex flex-col gap-2", editing === null && "min-h-0")}>
        {editing === "json" ? (
          <DefEditor def={def} kind={kind} onCancel={() => setEditing(null)} onSaved={saved} />
        ) : editing === "form" && kind === "profile" ? (
          <ProfileForm def={def} onCancel={() => setEditing(null)} onSaved={saved} />
        ) : editing === "form" && kind === "role" ? (
          <RoleForm def={def} onCancel={() => setEditing(null)} onSaved={saved} />
        ) : !shown ? (
          <p className="text-[13px] text-muted-foreground">{versions.error ?? "Cargando…"}</p>
        ) : kind === "flow" ? (
          <FlowBody def={shown} />
        ) : kind === "role" ? (
          <RoleBody def={shown} />
        ) : (
          <ProfileBody def={shown} />
        )}
      </section>

      <section aria-label="Versiones" className="flex flex-col gap-2">
        <h3 className="text-[13px] font-medium">Historial de versiones</h3>
        <ul className="divide-y rounded-lg border text-[13px]">
          {(versions.data ?? []).map((v) => (
            <li key={v.version} className="flex items-center">
              <button
                type="button"
                aria-pressed={v.version === shown?.version}
                onClick={() => setVersion(v.version)}
                className={cn("flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left hover:bg-accent", v.version === shown?.version && "bg-accent")}
              >
                <span className="w-16 flex-none font-medium tabular-nums">versión {v.version}</span>
                {v.version === def.currentVersion ? <span className="flex-none text-xs text-muted-foreground">vigente</span> : null}
                <span className="min-w-0 flex-1 truncate text-muted-foreground">guardada por {sourceLabel(v.source)}</span>
                <Ago at={v.createdAt} className="flex-none text-xs text-muted-foreground" />
              </button>
              {editable && v.version !== def.currentVersion ? (
                <Button size="sm" variant="ghost" className="mr-1 flex-none" onClick={() => void askRevert(v)} aria-label={`Volver a la versión ${v.version}`}>
                  <Undo2 /> Volver a esta versión
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">Las corridas en curso siguen con la versión con que empezaron. Elige una versión para ver su contenido.{editable ? " Volver a una versión crea una versión nueva con ese contenido: no borra las demás." : ""}</p>
      </section>

      {exporting ? <ExportToRepoDialog def={def} kind={kind} onClose={() => setExporting(false)} /> : null}
      {revert ? <ChangeDialog title={`Volver a la versión ${revert.to.version}`} confirmLabel="Volver a esta versión" write={revert.write} kind={kind} onConfirm={() => void confirmRevert()} onCancel={() => setRevert(null)} /> : null}

      <AlertDialog open={confirmArchive} onOpenChange={setConfirmArchive}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Archivar {nameOf(def)}?</AlertDialogTitle>
            <AlertDialogDescription>
              {row.projects.map((p) => p.name).join(", ")} {row.projects.length === 1 ? "lo usa" : "lo usan"} y no hay otro con el mismo slug que lo reemplace: se quedará sin {KIND_LABEL[kind].singular} hasta que restaures este o elijas otro. Las corridas que ya empezaron no cambian.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void archive()}>Archivar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** De qué repo, archivo y commit viene una def del repo (un archivo que se editó en la app ya no es el del commit, pero sigue siendo del repo). */
function RepoOrigin({ def, repoName }: { def: DefRecord; repoName: string | undefined }) {
  const origin = repoOrigin(def.source)
  return (
    <p className="text-xs text-muted-foreground">
      Del repo {repoName ?? "(no registrado en esta máquina)"}
      {origin ? <> · <span className="font-mono">{origin.file}</span> · commit <span className="font-mono">{origin.commit}</span></> : null}
    </p>
  )
}

// Un flujo se edita dibujándolo o como JSON desde el mismo botón.
const EDIT_HINT: Record<DefWriteKind, string> = { flow: '"Editar"', role: '"Editar"', profile: '"Editar"' }

/** Qué significa el estado de esta def y qué pasa si se toca. */
function explain(row: LibraryRow, kind: DefWriteKind): string {
  const thing = KIND_LABEL[kind].singular
  const { def } = row
  if (def.archivedAt !== null) return `Está archivado: no se usa. Conserva sus versiones y las corridas anteriores no cambian. Restáuralo para volver a usarlo.`
  if (row.overriddenBy) return `Hay un ${thing} ${row.overriddenBy === "repo" ? "del repo" : "tuyo"} con el mismo slug y manda sobre este. Este queda de respaldo: si archivas el otro, vuelve a usarse.`
  if (isReadOnly(def)) return `Viene ${def.scope === "pack" ? "en un pack" : "con la app"} y no se edita directo. "Duplicar para editar" crea uno tuyo con el mismo slug: desde ese momento manda el tuyo y este queda de respaldo.`
  if (row.overrides) return `Es tuyo y manda sobre el ${row.overrides === "pack" ? "del pack" : "incluido"} con el mismo slug. Si lo archivas, vuelve a usarse el otro. ${EDIT_HINT[kind]} lo cambia y guarda una versión nueva.`
  return `Es ${def.scope === "repo" ? "del repo" : "tuyo"}. ${EDIT_HINT[kind]} lo cambia y guarda una versión nueva; puedes archivarlo cuando ya no lo quieras y restaurarlo después.`
}

const Unreadable = ({ what }: { what: string }) => <p className="text-[13px] text-destructive">No pude leer {what}: su contenido no coincide con el formato esperado.</p>

function FlowBody({ def }: { def: DefRecord }) {
  const flow = FlowDef.safeParse(def.body)
  if (!flow.success) return <Unreadable what="este flujo" />
  return (
    <>
      <h3 className="text-[13px] font-medium">Pasos del flujo · versión {def.version}</h3>
      <div className="h-[380px] flex-none">
        <FlowDefGraph def={flow.data} />
      </div>
    </>
  )
}

function RoleBody({ def }: { def: DefRecord }) {
  const role = Role.safeParse(def.body)
  if (!role.success) return <Unreadable what="este rol" />
  return (
    <>
      <h3 className="text-[13px] font-medium">Modos · versión {def.version}</h3>
      <ul className="divide-y rounded-lg border text-[13px]">
        {Object.entries(role.data.modes).map(([mode, spec]) => (
          <li key={mode} className="flex items-baseline gap-3 px-3 py-2">
            <span className="w-28 flex-none font-mono text-xs">{mode}</span>
            <span className="min-w-0 flex-1 text-muted-foreground">termina con: {spec.outcomes.join(", ")}</span>
          </li>
        ))}
      </ul>
      <h3 className="text-[13px] font-medium">Instrucciones base</h3>
      <pre className="max-h-64 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">{role.data.prompt}</pre>
    </>
  )
}

function ProfileBody({ def }: { def: DefRecord }) {
  const profile = Profile.safeParse(def.body)
  if (!profile.success) return <Unreadable what="este perfil" />
  return (
    <>
      <h3 className="text-[13px] font-medium">Modelo de cada rol · versión {def.version}</h3>
      <p className="text-[13px] text-muted-foreground">{profileSummary(profile.data)}</p>
      <ul className="divide-y rounded-lg border text-[13px]">
        {Object.entries(profile.data.roles).map(([role, spec]) => (
          <li key={role} className="flex items-baseline gap-3 px-3 py-2">
            <span className="w-36 flex-none font-mono text-xs">{role}</span>
            <span className="min-w-0 flex-1 text-muted-foreground">
              {spec.model}
              {spec.effort ? ` · esfuerzo ${spec.effort}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </>
  )
}

