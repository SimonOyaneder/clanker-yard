import type { ClankerProject, DefRecord, Learning } from "@clanker/api"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { type RepoRow, useAppData } from "@/app-data"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { STATUS_LABEL } from "@/lib/learnings"
import { messageOf } from "@/lib/undoable"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: ClankerProject[]
  /** Los que la vista ya conoce: un id repetido en la respuesta de `propose` es un texto que ya existía. */
  learnings: Learning[]
  /** El core ya guardó: quien tiene la lista la relee. */
  onCreated: () => void
}

// «Nuevo learning»: una persona escribe una línea para un proyecto o un repo y, como la app puede aprobar, queda
// aprobado y entra a los briefs desde la próxima corrida. Sin roles marcados vale para todos.
export function NewLearningDialog({ open, onOpenChange, projects, learnings, onCreated }: Props) {
  const appData = useAppData()
  const [repos, setRepos] = useState<RepoRow[]>([])
  const [roleDefs, setRoleDefs] = useState<DefRecord[]>([])
  const [scope, setScope] = useState("")
  const [roles, setRoles] = useState<string[]>([])
  const [text, setText] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setScope("")
    setRoles([])
    setText("")
    setError(null)
    let current = true
    void Promise.all([appData.repos(), appData.defs("role")])
      .then(([r, d]) => current && (setRepos(r), setRoleDefs(d)))
      .catch((e) => current && setError(messageOf(e)))
    return () => {
      current = false
    }
  }, [open, appData])

  const slugs = [...new Set(roleDefs.map((d) => d.slug))].sort()
  const valid = scope !== "" && text.trim() !== ""

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const project = projects.find((p) => `p:${p.id}` === scope)
      const repo = repos.find((r) => `r:${r.repo.id}` === scope)
      const target = project ? { projectId: project.id } : { repoId: repo!.repo.id }
      const proposed = await appData.proposeLearning({ ...target, text, roles })
      if (learnings.some((l) => l.id === proposed.id)) {
        toast(`Ya existía en ese alcance (${STATUS_LABEL[proposed.status].toLowerCase()}): no cambié nada.`)
      } else {
        await appData.approveLearning(proposed.id)
        toast("Learning aprobado: entra a los briefs desde la próxima corrida.")
      }
      onCreated()
      onOpenChange(false)
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Nuevo learning</DialogTitle>
          <DialogDescription>Una línea que un agente futuro necesita saber. Queda aprobado y entra a los briefs desde la próxima corrida.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-learning-scope">Alcance</Label>
            <select id="new-learning-scope" value={scope} onChange={(e) => setScope(e.target.value)} className="h-9 rounded-md border bg-transparent px-2 text-sm">
              <option value="">Elige un proyecto o un repo</option>
              <optgroup label="Proyectos">
                {projects.map((p) => (
                  <option key={p.id} value={`p:${p.id}`}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Repos">
                {repos.map(({ repo }) => (
                  <option key={repo.id} value={`r:${repo.id}`}>
                    {repo.name}
                  </option>
                ))}
              </optgroup>
            </select>
          </div>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-sm font-medium">Roles</legend>
            <p className="text-xs text-muted-foreground">{roles.length === 0 ? "Sin marcar: vale para todos los roles." : "Solo estos roles lo reciben."}</p>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {slugs.map((slug) => (
                <label key={slug} className="flex items-center gap-1.5 text-[13px]">
                  <Checkbox checked={roles.includes(slug)} onCheckedChange={(on) => setRoles(on ? [...roles, slug] : roles.filter((r) => r !== slug))} aria-label={slug} />
                  {slug}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-learning-text">Texto</Label>
            <Input id="new-learning-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Corre `srb tc` con `doppler run --config dev`" />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button disabled={!valid || saving} onClick={() => void save()}>
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
