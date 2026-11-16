import type { ClankerProject, Learning, LearningSource, LearningStatus, RepoId } from "@clanker/api"
import { Pill } from "@/components/common"
import { SOURCE_HINT, SOURCE_LABEL, STATUS_HINT } from "@/lib/learnings"
import { tone } from "@/lib/format"

const STATUS_TONE: Record<LearningStatus, string> = { proposed: tone.amber, approved: tone.green, rejected: tone.red, archived: tone.neutral }
const STATUS_PILL: Record<LearningStatus, string> = { proposed: "por revisar", approved: "aprobado", rejected: "rechazado", archived: "retirado" }
const SOURCE_TONE: Record<LearningSource, string> = { import: tone.neutral, agent: tone.violet, human: tone.sky }

export const StatusPill = ({ status }: { status: LearningStatus }) => (
  <Pill className={STATUS_TONE[status]} hint={STATUS_HINT[status]}>
    {STATUS_PILL[status]}
  </Pill>
)

export const SourcePill = ({ source }: { source: LearningSource }) => (
  <Pill className={SOURCE_TONE[source]} hint={SOURCE_HINT[source]}>
    {SOURCE_LABEL[source].toLowerCase()}
  </Pill>
)

/** A qué roles aplica: vacío es todos. Cada chip dice, al pasar el mouse, qué significa. */
export function RolesPills({ roles, max = roles.length }: { roles: string[]; max?: number }) {
  if (roles.length === 0) {
    return (
      <Pill className={tone.neutral} hint="Sin roles: entra al brief de cualquier rol de su alcance.">
        todos los roles
      </Pill>
    )
  }
  const shown = roles.slice(0, max)
  return (
    <>
      {shown.map((role) => (
        <Pill key={role} className={tone.neutral} hint={`Solo entra al brief del rol ${role}.`}>
          {role}
        </Pill>
      ))}
      {roles.length > shown.length ? (
        <Pill className={tone.neutral} hint={`También: ${roles.slice(shown.length).join(", ")}.`}>
          +{roles.length - shown.length}
        </Pill>
      ) : null}
    </>
  )
}

/** El proyecto o el repo al que aplica. */
export function scopeName(l: Pick<Learning, "projectId" | "repoId">, projects: ClankerProject[], repoNames: ReadonlyMap<RepoId, string>): string {
  if (l.projectId) return projects.find((p) => p.id === l.projectId)?.name ?? "Proyecto desconocido"
  return l.repoId ? (repoNames.get(l.repoId) ?? "Repo desconocido") : "Sin alcance"
}
