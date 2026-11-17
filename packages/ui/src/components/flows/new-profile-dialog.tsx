import { type DefRecord, Profile } from "@clanker/api"
import { useState } from "react"
import { toast } from "sonner"
import { useAppData } from "@/app-data"
import { SelectField } from "@/components/flows/select-field"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { profileSummary, slugProblem } from "@/lib/flows/def-form"
import { nameOf } from "@/lib/flows/defs-library"
import { messageOf } from "@/lib/utils"

interface Props {
  /** Los perfiles vigentes: de uno de ellos parte el nuevo. Todos los de scope `user` (archivados incluidos) ocupan su slug. */
  profiles: DefRecord[]
  onCreated: (created: DefRecord) => void
  onClose: () => void
}

/** Crea un perfil tuyo con otro nombre, a partir de uno existente (incluido o tuyo): se ajusta después con "Editar". */
export function NewProfileDialog({ profiles, onCreated, onClose }: Props) {
  const appData = useAppData()
  const bases = profiles.filter((p) => p.archivedAt === null && Profile.safeParse(p.body).success)
  const [slug, setSlug] = useState("")
  const [baseId, setBaseId] = useState((bases.find((p) => p.slug === "medio") ?? bases[0])?.id ?? "")
  const [busy, setBusy] = useState(false)
  const base = bases.find((p) => p.id === baseId)
  const problem = slug === "" ? null : slugProblem(slug, profiles.map((p) => p.slug))

  const create = async () => {
    if (!base) return
    setBusy(true)
    try {
      onCreated(await appData.createDef({ kind: "profile", slug, body: base.body }))
      toast(`Creé el perfil "${slug}". Cámbiale los modelos con "Editar".`)
      onClose()
    } catch (e) {
      toast.error(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nuevo perfil</DialogTitle>
          <DialogDescription>Un perfil elige qué modelo usa cada agente del flujo. Parte de uno que ya existe y después le cambias lo que quieras.</DialogDescription>
        </DialogHeader>
        <form
          id="new-profile"
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (base && slug !== "" && !problem) void create()
          }}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="new-profile-slug">Nombre</Label>
            <Input id="new-profile-slug" value={slug} onChange={(e) => setSlug(e.target.value.trim())} placeholder="dev-opus-reviews-haiku" aria-invalid={problem !== null} autoFocus />
            {problem ? <p className="text-xs text-destructive">{problem}</p> : null}
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="new-profile-base">Parte de</Label>
            <SelectField label="Parte de" value={baseId} options={bases.map((p) => ({ value: p.id, label: nameOf(p) }))} onChange={setBaseId} />
            {base ? <p className="text-xs text-muted-foreground">{profileSummary(Profile.parse(base.body))}</p> : <p className="text-xs text-destructive">No hay ningún perfil vigente del que partir.</p>}
          </div>
        </form>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="new-profile" disabled={busy || !base || slug === "" || problem !== null}>
            Crear perfil
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
