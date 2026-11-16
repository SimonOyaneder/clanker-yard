import type { ClankerProject, DefRecord, NewProject, TrackerId } from "@clanker/api"
import { useState } from "react"
import { useAppData } from "@/app-data"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { DefOption } from "@/components/def-option"
import { listsProjects, TrackerProjectPicker } from "@/components/tracker-project-picker"
import { useLiveQuery } from "@/hooks/use-live"
import { defaultFlowSlug, defaultProfileSlug, defName, selectableFlows } from "@/lib/defs"

const TRACKERS: { id: TrackerId; label: string }[] = [
  { id: "local", label: "Local" },
  { id: "linear", label: "Linear" },
  { id: "github-issues", label: "GitHub Issues" },
  { id: "jira", label: "Jira" },
]

export function slugOf(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (project: ClankerProject) => void
  /** El tracker no está conectado o falló: lleva a Conexiones (el diálogo se cierra). */
  onOpenConnections: () => void
}

export function NewProjectDialog({ open, onOpenChange, onCreated, onOpenConnections }: Props) {
  // Se monta de nuevo en cada apertura: el formulario siempre parte vacío.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">{open ? <Form onCreated={onCreated} onCancel={() => onOpenChange(false)} onOpenConnections={onOpenConnections} /> : null}</DialogContent>
    </Dialog>
  )
}

function Form({ onCreated, onCancel, onOpenConnections }: { onCreated: (project: ClankerProject) => void; onCancel: () => void; onOpenConnections: () => void }) {
  const appData = useAppData()
  const [name, setName] = useState("")
  const [slug, setSlug] = useState<string | null>(null)
  const [tracker, setTracker] = useState<TrackerId>("local")
  const [trackerRef, setTrackerRef] = useState("")
  // La cuenta del proyecto elegido; solo la fija el selector (un id escrito a mano no la trae).
  const [trackerAccount, setTrackerAccount] = useState<string | null>(null)
  // `null` es "no tocado": vale el default de lo que haya llegado.
  const [pickedFlow, setPickedFlow] = useState<string | null>(null)
  const [pickedProfile, setPickedProfile] = useState<string | null>(null)
  const [pickedParallel, setPickedParallel] = useState<string | null>(null)
  // Lo que se preselecciona son los defaults de proyectos nuevos de Ajustes; sin ellos, lo de siempre.
  const defs = useLiveQuery(
    "new-project:defs",
    async () => ({ flows: selectableFlows(await appData.defs("flow")), profiles: await appData.defs("profile"), defaults: await appData.projectDefaults() }),
    { live: false },
  )
  const flow = pickedFlow ?? defs.data?.defaults.defaultFlowId ?? defaultFlowSlug(defs.data?.flows ?? [])
  const profile = pickedProfile ?? defs.data?.defaults.defaultProfileId ?? defaultProfileSlug(defs.data?.profiles ?? [])
  const parallel = pickedParallel ?? String(defs.data?.defaults.parallel ?? 1)
  const setParallel = setPickedParallel
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const shownSlug = slug ?? slugOf(name)
  const local = tracker === "local"
  const picker = listsProjects(tracker)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const input: NewProject = {
      slug: shownSlug,
      name: name.trim(),
      tracker,
      parallel: Number(parallel),
      ...(local ? {} : { trackerRef: trackerRef.trim(), ...(trackerAccount ? { trackerAccount } : {}) }),
      ...(flow ? { defaultFlowId: flow } : {}),
      ...(profile ? { defaultProfileId: profile } : {}),
    }
    setSaving(true)
    setError(null)
    try {
      onCreated(await appData.createProject(input))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Nuevo proyecto</DialogTitle>
        <DialogDescription>Un proyecto junta una cola de issues de un tracker con el flujo que las trabaja.</DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="project-name">Nombre</Label>
        <Input id="project-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Boundaries de engines" required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="project-slug">Slug</Label>
        <Input id="project-slug" className="font-mono" value={shownSlug} onChange={(e) => setSlug(e.target.value)} placeholder="boundaries-de-engines" required />
        <p className="text-xs text-muted-foreground">Es único y es como lo nombran la CLI y el MCP.</p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="project-tracker">Tracker</Label>
          <Select
            value={tracker}
            onValueChange={(v) => {
              setTracker(v as TrackerId)
              setTrackerRef("")
              setTrackerAccount(null)
            }}
          >
            <SelectTrigger id="project-tracker">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TRACKERS.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="project-parallel">Corridas en paralelo</Label>
          <Input id="project-parallel" type="number" min={1} value={parallel} onChange={(e) => setParallel(e.target.value)} required />
        </div>
      </div>
      {local ? null : (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="project-ref">Proyecto del tracker</Label>
          {picker ? (
            <TrackerProjectPicker id="project-ref" tracker={tracker} value={trackerRef} onChange={(ref, account) => { setTrackerRef(ref); setTrackerAccount(account) }} onOpenConnections={onOpenConnections} />
          ) : (
            <>
              <Input id="project-ref" value={trackerRef} onChange={(e) => { setTrackerRef(e.target.value); setTrackerAccount(null) }} required />
              <p className="text-xs text-muted-foreground">El id del proyecto dentro de {TRACKERS.find((t) => t.id === tracker)?.label} del que sale la cola.</p>
            </>
          )}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <DefSelect id="project-flow" label="Flujo por defecto" noun="flujos" query={defs} defs={defs.data?.flows} value={flow} onChange={setPickedFlow} />
        <DefSelect id="project-profile" label="Perfil por defecto" noun="perfiles" query={defs} defs={defs.data?.profiles} value={profile} onChange={setPickedProfile} />
      </div>

      {error ? (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" disabled={saving || !name.trim() || !shownSlug || (!local && !trackerRef.trim())}>
          Crear proyecto
        </Button>
      </DialogFooter>
    </form>
  )
}

// Un flujo o perfil por defecto: el nombre y, más chico y en mono, el slug que usan la CLI y el MCP.
function DefSelect({
  id,
  label,
  noun,
  query,
  defs,
  value,
  onChange,
}: {
  id: string
  label: string
  noun: string
  query: { error?: string | null; reload: () => void }
  defs: DefRecord[] | undefined
  value: string
  onChange: (slug: string) => void
}) {
  const selected = defs?.find((d) => d.slug === value)
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {query.error ? (
        <p role="alert" className="text-xs text-destructive">
          No pude leer los {noun}: {query.error}{" "}
          <button type="button" className="underline" onClick={query.reload}>
            Reintentar
          </button>
        </p>
      ) : !defs ? (
        <Skeleton aria-label={`Cargando ${noun}`} className="h-9 w-full" />
      ) : defs.length === 0 ? (
        <p className="text-xs text-muted-foreground">No hay {noun}: el proyecto se crea sin uno por defecto.</p>
      ) : (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger id={id} className="w-full">
            <SelectValue>{selected ? defName(selected) : null}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {defs.map((d) => (
              <SelectItem key={d.slug} value={d.slug}>
                <DefOption def={d} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  )
}
