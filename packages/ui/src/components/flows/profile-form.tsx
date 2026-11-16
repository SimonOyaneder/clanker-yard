import { type AgentOptions, type DefRecord, Profile } from "@clanker/api"
import { useState } from "react"
import { useAppData } from "@/app-data"
import { DefFormFrame } from "@/components/flows/def-form-frame"
import { SelectField } from "@/components/flows/select-field"
import { useLiveQuery } from "@/hooks/use-live"
import { profileSummary, withRole } from "@/lib/def-form"

interface Props {
  def: DefRecord
  onSaved: () => void
  onCancel: () => void
}

const DEFAULT_EFFORT = ""

/** El perfil como tabla: una fila por rol del flujo, con el modelo y el esfuerzo que usa. Las opciones las da el core. */
export function ProfileForm({ def, onSaved, onCancel }: Props) {
  const appData = useAppData()
  const options = useLiveQuery("agent-options", () => appData.agentOptions(), { live: false })
  const parsed = Profile.safeParse(def.body)
  const [draft, setDraft] = useState<Profile | null>(parsed.success ? parsed.data : null)
  if (!draft) return <p className="text-[13px] text-destructive">No pude leer este perfil: usa "Editar JSON" para arreglarlo.</p>
  if (!options.data) return <p className="text-[13px] text-muted-foreground">{options.error ?? "Cargando los modelos disponibles…"}</p>

  return (
    <DefFormFrame def={def} kind="profile" body={draft} onSaved={onSaved} onCancel={onCancel}>
      <p className="text-[13px] text-muted-foreground">Elige qué modelo usa cada agente del flujo: uno más potente trabaja mejor, pero cuesta más. El esfuerzo es cuánto piensa antes de responder.</p>
      <p aria-label="Resumen" className="text-[13px] font-medium">
        {profileSummary(draft) || "Sin roles"}
      </p>
      <ProfileTable options={options.data} profile={draft} onChange={setDraft} />
    </DefFormFrame>
  )
}

function ProfileTable({ options, profile, onChange }: { options: AgentOptions; profile: Profile; onChange: (next: Profile) => void }) {
  const models = options.models.map((m) => ({ value: m.id, label: m.label }))
  const efforts = [{ value: DEFAULT_EFFORT, label: "Por defecto" }, ...options.efforts.map((e) => ({ value: e.id, label: e.id }))]
  const aboutModel = (id: string) => options.models.find((m) => m.id === id)?.about
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="border-b text-left text-xs text-muted-foreground">
          <th className="py-1.5 pr-3 font-normal">Rol</th>
          <th className="py-1.5 pr-3 font-normal">Modelo</th>
          <th className="py-1.5 font-normal">Esfuerzo</th>
        </tr>
      </thead>
      <tbody className="divide-y">
        {Object.entries(profile.roles).map(([role, spec]) => (
          <tr key={role}>
            <td className="py-1.5 pr-3 align-top font-mono text-xs">{role}</td>
            <td className="py-1.5 pr-3">
              <SelectField label={`Modelo de ${role}`} value={spec.model} options={models} onChange={(model) => onChange(withRole(profile, role, { ...spec, model }))} />
              <p className="mt-0.5 text-xs text-muted-foreground">{aboutModel(spec.model) ?? "Modelo que el core no lista: se conserva tal cual."}</p>
            </td>
            <td className="py-1.5 align-top">
              <SelectField
                label={`Esfuerzo de ${role}`}
                value={spec.effort ?? DEFAULT_EFFORT}
                options={efforts}
                onChange={(effort) => onChange(withRole(profile, role, { ...spec, effort: effort === DEFAULT_EFFORT ? undefined : (effort as typeof spec.effort) }))}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
