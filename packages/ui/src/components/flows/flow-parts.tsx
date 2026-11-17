import type { ClankerProject } from "@clanker/api"
import { Pill } from "@/components/common"
import { tone } from "@/lib/format"
import { SCOPE_HINT, SCOPE_LABEL, type LibraryRow } from "@/lib/flows/defs-library"

const SCOPE_TONE = { builtin: tone.neutral, pack: tone.violet, user: tone.green, repo: tone.sky } as const

/** De dónde viene la def, con qué pasa al pasar el mouse. */
export const ScopePill = ({ scope }: { scope: LibraryRow["def"]["scope"] }) => (
  <Pill className={SCOPE_TONE[scope]} hint={SCOPE_HINT[scope]}>
    {SCOPE_LABEL[scope].toLowerCase()}
  </Pill>
)

const WHO = { user: "uno tuyo", repo: "uno del repo", pack: "uno de un pack", builtin: "uno incluido" } as const

/** Las marcas de una fila: archivada, interna y quién manda sobre quién cuando comparten slug. */
export function RowPills({ row }: { row: LibraryRow }) {
  return (
    <>
      <ScopePill scope={row.def.scope} />
      {row.def.archivedAt !== null ? (
        <Pill className={tone.amber} hint="No se usa. Conserva sus versiones: se puede restaurar.">
          archivado
        </Pill>
      ) : null}
      {row.internal ? (
        <Pill className={tone.neutral} hint="Lo lanzan otros flujos o el sistema por dentro. No se elige como flujo de un proyecto.">
          interno
        </Pill>
      ) : null}
      {row.overrides ? (
        <Pill className={tone.green} hint={`Hay ${WHO[row.overrides]} con este mismo slug. Mientras este no esté archivado, manda el tuyo.`}>
          manda sobre el {row.overrides === "pack" ? "del pack" : "incluido"}
        </Pill>
      ) : null}
      {row.overriddenBy ? (
        <Pill className={tone.amber} hint={`Hay ${WHO[row.overriddenBy]} con este mismo slug y manda sobre este. Este queda de respaldo.`}>
          reemplazado por {row.overriddenBy === "repo" ? "el del repo" : "el tuyo"}
        </Pill>
      ) : null}
    </>
  )
}

/** En qué proyectos se usa, o por qué no se usa en ninguno. */
export function UsedBy({ projects, internal }: { projects: ClankerProject[]; internal?: boolean }) {
  if (projects.length > 0) return <>{projects.map((p) => p.name).join(", ")}</>
  if (internal) return <span className="text-muted-foreground">Lo usa el sistema por dentro</span>
  return <span className="text-muted-foreground">Ningún proyecto lo usa todavía</span>
}
