import { ContextPackage, type DefRecord, Role } from "@clanker/api"
import { useState } from "react"
import { useAppData } from "@/app-data"
import { DefFormFrame } from "@/components/flows/def-form-frame"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useLiveQuery } from "@/hooks/use-live"
import { type RoleDraft, roleDraftOf, roleFromDraft, splitList } from "@/lib/def-form"

interface Props {
  def: DefRecord
  onSaved: () => void
  onCancel: () => void
}

/** Un rol en tres campos: su prompt (markdown), las herramientas que puede usar y los paquetes de contexto que recibe. Sus modos y el esquema de salida se ven pero no se editan aquí. */
export function RoleForm({ def, onSaved, onCancel }: Props) {
  const appData = useAppData()
  const packages = useLiveQuery("library:context", () => appData.defs("context"), { live: false })
  const parsed = Role.safeParse(def.body)
  const [draft, setDraft] = useState<RoleDraft | null>(parsed.success ? roleDraftOf(parsed.data) : null)
  if (!parsed.success || !draft) return <p className="text-[13px] text-destructive">No pude leer este rol: usa "Editar JSON" para arreglarlo.</p>
  const role = parsed.data
  const set = (patch: Partial<RoleDraft>) => setDraft({ ...draft, ...patch })
  // Los paquetes que el rol ya pide siguen visibles aunque ya no exista su def: así se pueden quitar.
  const choices = [...new Set([...(packages.data ?? []).map((d) => d.slug), ...draft.packs])].toSorted()
  const describe = (slug: string) => {
    const pack = ContextPackage.safeParse((packages.data ?? []).find((d) => d.slug === slug)?.body)
    return pack.success ? (pack.data.description ?? pack.data.refs.join(", ")) : "No existe un paquete con este nombre."
  }

  return (
    <DefFormFrame def={def} kind="role" body={roleFromDraft(role, draft)} onSaved={onSaved} onCancel={onCancel}>
      <p className="text-[13px] text-muted-foreground">Un rol es un agente con una tarea fija (implementar, revisar bugs, hacer commits). Aquí cambias cómo piensa y con qué trabaja; qué modelo usa lo decide el perfil.</p>

      <section className="flex flex-col gap-1.5">
        <Label htmlFor="role-prompt">Instrucciones base (markdown)</Label>
        <Textarea id="role-prompt" value={draft.prompt} onChange={(e) => set({ prompt: e.target.value })} spellCheck={false} className="min-h-64 font-mono text-xs" />
        <p className="text-xs text-muted-foreground">Es igual en todos los modos del rol y va al inicio de cada sesión.</p>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-[13px] font-medium">Herramientas</h3>
        <p className="text-xs text-muted-foreground">Qué puede hacer el agente: leer archivos, editar, correr comandos. Restringe un rol que solo debe leer.</p>
        <div className="flex items-center gap-2">
          <Checkbox id="role-all-tools" checked={draft.allTools} onCheckedChange={(v) => set({ allTools: v === true })} />
          <Label htmlFor="role-all-tools" className="text-[13px] font-normal">
            Puede usar todas
          </Label>
        </div>
        {draft.allTools ? null : (
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="role-allow" className="text-xs">
                Solo estas (una por línea)
              </Label>
              <Textarea id="role-allow" value={draft.allow} onChange={(e) => set({ allow: e.target.value })} spellCheck={false} placeholder="Read&#10;Grep" className="min-h-20 font-mono text-xs" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="role-deny" className="text-xs">
                Nunca estas (una por línea)
              </Label>
              <Textarea id="role-deny" value={draft.deny} onChange={(e) => set({ deny: e.target.value })} spellCheck={false} placeholder="Bash" className="min-h-20 font-mono text-xs" />
            </div>
          </div>
        )}
        {!draft.allTools && splitList(draft.allow).length + splitList(draft.deny).length === 0 ? <p className="text-xs text-muted-foreground">Sin ninguna herramienta en las listas, el rol puede usar todas.</p> : null}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-[13px] font-medium">Paquetes de contexto</h3>
        <p className="text-xs text-muted-foreground">Grupos de reglas y skills que el agente recibe además de sus instrucciones (por ejemplo, cómo se hacen los commits).</p>
        {choices.length === 0 ? <p className="text-xs text-muted-foreground">No hay paquetes de contexto todavía.</p> : null}
        <ul className="flex flex-col gap-1.5">
          {choices.map((slug) => (
            <li key={slug} className="flex items-start gap-2">
              <Checkbox id={`pack-${slug}`} checked={draft.packs.includes(slug)} onCheckedChange={(v) => set({ packs: v === true ? [...draft.packs, slug] : draft.packs.filter((p) => p !== slug) })} />
              <Label htmlFor={`pack-${slug}`} className="flex flex-col items-start gap-0 text-[13px] font-normal">
                <span className="font-mono text-xs">{slug}</span>
                <span className="text-xs text-muted-foreground">{describe(slug)}</span>
              </Label>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="text-[13px] font-medium">Modos y esquema de salida</h3>
        <p className="text-xs text-muted-foreground">Solo lectura: {Object.keys(role.modes).join(", ")}. Si necesitas cambiarlos, usa "Editar JSON".</p>
      </section>
    </DefFormFrame>
  )
}
