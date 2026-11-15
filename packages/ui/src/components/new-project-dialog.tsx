import type { ClankerProject, NewProject, TrackerId } from "@clanker/api"
import { useState } from "react"
import { useAppData } from "@/app-data"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

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
}

export function NewProjectDialog({ open, onOpenChange, onCreated }: Props) {
  // Se monta de nuevo en cada apertura: el formulario siempre parte vacío.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">{open ? <Form onCreated={onCreated} onCancel={() => onOpenChange(false)} /> : null}</DialogContent>
    </Dialog>
  )
}

function Form({ onCreated, onCancel }: { onCreated: (project: ClankerProject) => void; onCancel: () => void }) {
  const appData = useAppData()
  const [name, setName] = useState("")
  const [slug, setSlug] = useState<string | null>(null)
  const [tracker, setTracker] = useState<TrackerId>("local")
  const [trackerRef, setTrackerRef] = useState("")
  const [flow, setFlow] = useState("")
  const [profile, setProfile] = useState("")
  const [parallel, setParallel] = useState("1")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const shownSlug = slug ?? slugOf(name)
  const local = tracker === "local"

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const input: NewProject = {
      slug: shownSlug,
      name: name.trim(),
      tracker,
      parallel: Number(parallel),
      ...(local ? {} : { trackerRef: trackerRef.trim() }),
      ...(flow.trim() ? { defaultFlowId: flow.trim() } : {}),
      ...(profile.trim() ? { defaultProfileId: profile.trim() } : {}),
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
          <Label>Tracker</Label>
          <Select value={tracker} onValueChange={(v) => setTracker(v as TrackerId)}>
            <SelectTrigger>
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
          <Input id="project-ref" value={trackerRef} onChange={(e) => setTrackerRef(e.target.value)} required />
          <p className="text-xs text-muted-foreground">El id del proyecto dentro de {TRACKERS.find((t) => t.id === tracker)?.label} del que sale la cola.</p>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="project-flow">Flujo por defecto</Label>
          <Input id="project-flow" className="font-mono" value={flow} onChange={(e) => setFlow(e.target.value)} placeholder="juguete" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="project-profile">Perfil por defecto</Label>
          <Input id="project-profile" className="font-mono" value={profile} onChange={(e) => setProfile(e.target.value)} placeholder="juguete" />
        </div>
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
        <Button type="submit" disabled={saving || !name.trim() || !shownSlug}>
          Crear proyecto
        </Button>
      </DialogFooter>
    </form>
  )
}
