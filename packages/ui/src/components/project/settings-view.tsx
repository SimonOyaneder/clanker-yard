import type { CachedIssue, ClankerProject, DefRecord } from "@clanker/api"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { type RepoRow, useAppData } from "@/app-data"
import { Shortcut } from "@/components/common"
import { SettingsNav, type SettingsNavItem } from "@/components/project/settings-nav"
import { ConventionsSection, FlowSection, LimitsSection, QueueSection, ReposSection, StatusMappingSection } from "@/components/project/settings-sections"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useLive, useLiveQuery } from "@/hooks/use-live"
import { allParamSpecs, changedSections, draftOf, flowParamGroups, managedParams, patchOf, same, type Draft, undoPatch, validate } from "@/lib/project-settings"
import { undoable } from "@/lib/undoable"

/** Lo que la pestaña le da a la paleta y al resto de la app: si hay cambios y cómo guardarlos o descartarlos. */
export interface SettingsControls {
  dirty: boolean
  /** Hay cambios, pero alguno no se puede guardar todavía. */
  blocked: boolean
  save: () => void
  discard: () => void
}

interface TabProps {
  project: ClankerProject
  /** La sección a la que llevar al abrir (`queue` desde "Editar filtros"); `onFocused` avisa que ya se hizo. */
  focus: string | null
  onFocused: () => void
  onControls: (controls: SettingsControls | null) => void
}

// La pestaña Ajustes: edita un borrador y lo guarda de una vez con `projects.update`, con un toast que lo deshace.
export function ProjectSettingsTab(props: TabProps) {
  const appData = useAppData()
  const { project } = props
  const query = useLiveQuery(`settings:${project.id}`, async () => {
    const [flows, profiles, repos, issues] = await Promise.all([appData.defs("flow"), appData.defs("profile"), appData.repos(), appData.issues(project.id)])
    return { flows, profiles, repos, issues }
  })
  if (query.data) return <SettingsForm key={project.id} {...props} {...query.data} />
  if (query.error) {
    return (
      <div role="alert" className="mx-auto mt-16 flex max-w-md flex-col items-center gap-3 text-center">
        <h2 className="text-base font-semibold">No pude leer los ajustes</h2>
        <p className="text-muted-foreground">{query.error}</p>
        <Button size="sm" onClick={query.reload}>
          Reintentar
        </Button>
      </div>
    )
  }
  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-4">
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  )
}

interface Loaded {
  flows: DefRecord[]
  profiles: DefRecord[]
  repos: RepoRow[]
  issues: CachedIssue[]
}

const NAV: SettingsNavItem[] = [
  { id: "repos", label: "Repos" },
  { id: "queue", label: "Filtros de la cola" },
  { id: "status", label: "Mapeo de estados" },
  { id: "flow", label: "Flujo y parámetros" },
  { id: "limits", label: "Apilado y gasto" },
  { id: "conventions", label: "Convenciones" },
]

function SettingsForm({ project, focus, onFocused, onControls, flows, profiles, repos, issues }: TabProps & Loaded) {
  const appData = useAppData()
  const live = useLive()
  const managed = useMemo(() => managedParams(flows), [flows])
  const base = useMemo(() => draftOf(project, managed), [project, managed])
  // `edit` es lo que la persona cambió; sin cambios se ve el proyecto tal como llega del core.
  const [edit, setEdit] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Cuando el proyecto ya refleja lo editado (tras guardar o al volver a como estaba), se vuelve a seguirlo.
  if (edit && same(edit, base)) setEdit(null)
  const draft = edit ?? base

  const groups = useMemo(() => flowParamGroups(flows, draft.defaultFlowId), [flows, draft.defaultFlowId])
  const specs = useMemo(() => allParamSpecs(flows, draft.defaultFlowId), [flows, draft.defaultFlowId])
  const shownSpecs = useMemo(() => [...groups.own, ...groups.triggered], [groups])
  const problems = useMemo(() => validate(draft, shownSpecs), [draft, shownSpecs])
  const problemList = Object.values(problems)
  const dirty = edit !== null
  const patch = useMemo(() => patchOf(draft, base, project, specs), [draft, base, project, specs])
  const observed = useMemo(() => {
    const byRaw = new Map(issues.map((i) => [i.rawStatus, i.status] as const))
    return [...byRaw].map(([rawStatus, status]) => ({ rawStatus, status }))
  }, [issues])

  const update = useCallback(
    (change: Partial<Draft>) => {
      setEdit({ ...draft, ...change })
      setSaveError(null)
    },
    [draft],
  )

  const save = useCallback(async () => {
    if (!dirty || saving || problemList.length) return
    setSaving(true)
    const failure = await undoable(
      `Ajustes de ${project.name} guardados: ${changedSections(patch).join(", ")}`,
      () => appData.updateProject(project.id, patch),
      () => appData.updateProject(project.id, undoPatch(project, patch)),
    )
    setSaving(false)
    setSaveError(failure)
    if (!failure) live.refresh()
  }, [dirty, saving, problemList.length, project, patch, appData, live])
  const discard = useCallback(() => {
    setEdit(null)
    setSaveError(null)
  }, [])

  // ⌘S guarda desde cualquier campo; la paleta usa los mismos controles.
  const latest = useRef({ save, discard })
  latest.current = { save, discard }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey || e.code !== "KeyS") return
      e.preventDefault()
      void latest.current.save()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  const blocked = dirty && problemList.length > 0
  useEffect(() => {
    onControls({ dirty, blocked, save: () => void latest.current.save(), discard: () => latest.current.discard() })
    return () => onControls(null)
  }, [dirty, blocked, onControls])

  // "Editar filtros" y compañía llevan a su sección. Con un menú todavía abierto (se está cerrando) el foco no se queda: se espera a que se vaya.
  useEffect(() => {
    if (!focus) return
    let frame = 0
    let waited = 0
    const arrive = () => {
      if (document.querySelector('[role="menu"]') && waited++ < 60) {
        frame = requestAnimationFrame(arrive)
        return
      }
      const section = document.getElementById(`settings-${focus}`)
      section?.scrollIntoView({ block: "start" })
      section?.querySelector<HTMLElement>("input")?.focus({ preventScroll: true })
      onFocused()
    }
    frame = requestAnimationFrame(arrive)
    return () => cancelAnimationFrame(frame)
  }, [focus, onFocused])

  const shared = { draft, update, problems }
  return (
    <div className="@container w-full">
      <div className="mx-auto flex max-w-[1108px] flex-col gap-4 @4xl:flex-row @4xl:gap-8">
        <SettingsNav items={NAV} />
        <div className="@container flex max-w-[900px] min-w-0 flex-1 flex-col gap-4">
          <ReposSection {...shared} project={project} registered={repos} />
          <QueueSection {...shared} />
          <StatusMappingSection {...shared} project={project} observed={observed} />
          <FlowSection {...shared} flows={flows} profiles={profiles} groups={groups} />
          <LimitsSection {...shared} />
          <ConventionsSection {...shared} hasContext={project.conventions.context !== undefined} />

          {dirty ? (
            <div
              role="region"
              aria-label="Cambios sin guardar"
              className="sticky bottom-4 z-10 flex items-center gap-3 rounded-lg border bg-background/95 px-4 py-3 shadow-sm backdrop-blur"
            >
              <p className={problemList.length || saveError ? "text-[13px] text-destructive" : "text-[13px] text-muted-foreground"} role={saveError ? "alert" : undefined}>
                {saveError ?? (problemList.length ? `${problemList.length === 1 ? "Un campo necesita" : `${problemList.length} campos necesitan`} corrección para guardar. Está marcado arriba.` : `Cambios sin guardar en ${changedSections(patch).join(", ")}.`)}
              </p>
              <div className="ml-auto flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={discard} disabled={saving}>
                  Descartar
                </Button>
                <Button size="sm" onClick={() => void save()} disabled={saving || problemList.length > 0}>
                  Guardar cambios
                  <Shortcut keys="⌘S" className="ml-1 opacity-70" />
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
