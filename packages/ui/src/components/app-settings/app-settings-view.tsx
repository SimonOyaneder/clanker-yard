import type { DefRecord, Lanes, PackInfo, ProjectDefaults, Repo } from "@clanker/api"
import { useCallback, useMemo, useState } from "react"
import { useAppData } from "@/app-data"
import { AdvancedSection, DefaultsSection, LanesSection, PacksSection } from "@/components/app-settings/app-settings-sections"
import { SaveBar, useSaveShortcut } from "@/components/project/settings-fields"
import { SettingsNav, type SettingsNavItem } from "@/components/project/settings-nav"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useLive, useLiveQuery } from "@/hooks/use-live"
import { DEFAULTS_FIELD_LABELS, type DefaultsDraft, defaultsPatch, defaultsProblems, draftOfDefaults, sameDefaults, undoDefaults } from "@/lib/app-settings"
import { undoable } from "@/lib/undoable"

const NAV: SettingsNavItem[] = [
  { id: "lanes", label: "Carriles" },
  { id: "packs", label: "Packs" },
  { id: "defaults", label: "Proyectos nuevos" },
  { id: "advanced", label: "Avanzado" },
]

// Ajustes de la app: lo que no es de un proyecto. Misma página que los Ajustes de un proyecto (índice, secciones y
// barra de cambios sin guardar); carriles y packs se aplican al momento, los defaults de proyectos nuevos se guardan de una vez.
export function AppSettingsView() {
  const appData = useAppData()
  const query = useLiveQuery("app-settings", async () => {
    const [lanes, packs, repos, defaults, flows, profiles, info] = await Promise.all([
      appData.lanes(),
      appData.packs(),
      appData.repos(),
      appData.projectDefaults(),
      appData.defs("flow"),
      appData.defs("profile"),
      appData.coreInfo(),
    ])
    return { lanes, packs, repos: repos.map((r) => r.repo), defaults, flows, profiles, info }
  })
  const live = useLive()
  if (query.data) return <AppSettingsForm {...query.data} onChanged={live.refresh} />
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
  lanes: Lanes
  packs: PackInfo[]
  repos: Repo[]
  defaults: ProjectDefaults
  flows: DefRecord[]
  profiles: DefRecord[]
  info: { dataDir: string; linearClientId: string }
}

function AppSettingsForm({ lanes, packs, repos, defaults, flows, profiles, info, onChanged }: Loaded & { onChanged: () => void }) {
  const appData = useAppData()
  const base = useMemo(() => draftOfDefaults(defaults), [defaults])
  // `edit` es lo que la persona cambió; sin cambios se ve lo que guardó el core.
  const [edit, setEdit] = useState<DefaultsDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  if (edit && sameDefaults(edit, base)) setEdit(null)
  const draft = edit ?? base
  const problems = useMemo(() => defaultsProblems(draft), [draft])
  const problemCount = Object.keys(problems).length
  const patch = useMemo(() => defaultsPatch(draft, base), [draft, base])

  const update = useCallback(
    (change: Partial<DefaultsDraft>) => {
      setEdit({ ...draft, ...change })
      setSaveError(null)
    },
    [draft],
  )
  const save = useCallback(async () => {
    if (!edit || saving || problemCount) return
    setSaving(true)
    const failure = await undoable(
      `Proyectos nuevos guardados: ${Object.keys(patch).map((f) => DEFAULTS_FIELD_LABELS[f as keyof typeof DEFAULTS_FIELD_LABELS]).join(", ")}`,
      () => appData.setProjectDefaults(patch),
      () => appData.setProjectDefaults(undoDefaults(defaults, patch)).then(onChanged),
    )
    setSaving(false)
    setSaveError(failure)
    if (!failure) onChanged()
  }, [edit, saving, problemCount, patch, appData, defaults, onChanged])
  useSaveShortcut(() => void save())

  return (
    <div className="@container w-full">
      <div className="mx-auto flex max-w-[1108px] flex-col gap-4 @4xl:flex-row @4xl:gap-8">
        <SettingsNav items={NAV} />
        <div className="@container flex max-w-[900px] min-w-0 flex-1 flex-col gap-4">
          <LanesSection lanes={lanes} />
          <PacksSection packs={packs} repos={repos} onChanged={onChanged} />
          <DefaultsSection draft={draft} update={update} problems={problems} flows={flows} profiles={profiles} />
          <AdvancedSection info={info} />

          {edit ? (
            <SaveBar
              message={saveError ?? (problemCount ? `${problemCount === 1 ? "Un campo necesita" : `${problemCount} campos necesitan`} corrección para guardar. Está marcado arriba.` : "Cambios sin guardar en proyectos nuevos.")}
              error={problemCount > 0 || saveError !== null}
              alert={saveError !== null}
              saving={saving}
              canSave={problemCount === 0}
              onDiscard={() => {
                setEdit(null)
                setSaveError(null)
              }}
              onSave={() => void save()}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}
