import { MAX_BRIEF_LEARNINGS, RESERVED_PROJECT_LEARNINGS, type Learning } from "@clanker/api"
import { Check, Copy, MoreHorizontal, Pencil, ScrollText, Undo2, X } from "lucide-react"
import { useState } from "react"
import { Ago, Hint, Shortcut } from "@/components/common"
import { RolesPills, SourcePill, StatusPill } from "@/components/learnings/learning-parts"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { ChipsInput } from "@/components/settings-form/settings-fields"
import { copy } from "@/lib/clipboard"
import { approveLabel, capsOf, rejectLabel } from "@/lib/learnings"

export interface LearningPatchInput {
  text: string
  roles: string[]
  tags: string[]
}

interface Props {
  learning: Learning
  /** El nombre del proyecto o del repo al que aplica. */
  scope: string
  /** Los roles que ya usa algún learning: ofrecerlos evita escribirlos distinto. */
  knownRoles: string[]
  editing: boolean
  onEditingChange: (on: boolean) => void
  onApprove: () => void
  onReject: () => void
  /** Devuelve el mensaje del fallo (un texto repetido en el mismo alcance, por ejemplo) o `null` si se guardó. */
  onSave: (patch: LearningPatchInput) => Promise<string | null>
  onOpenRun: (() => void) | null
}

// El learning a la vista: lo que dice, a quién le aplica y lo que se puede hacer con él. Editar cambia el texto y los
// roles y tags; el alcance (proyecto o repo) lo fija el core al crearlo y no se mueve.
export function LearningDetail({ learning, scope, knownRoles, editing, onEditingChange, onApprove, onReject, onSave, onOpenRun }: Props) {
  const caps = capsOf(learning)
  return (
    <article aria-label="Learning" className="flex max-w-2xl flex-col gap-5">
      <header className="flex flex-wrap items-center gap-1.5">
        <StatusPill status={learning.status} />
        <SourcePill source={learning.source} />
        <span className="text-xs text-muted-foreground">
          {scope} · <Ago at={learning.createdAt} />
        </span>
      </header>

      {editing ? (
        <EditForm key={learning.id} learning={learning} knownRoles={knownRoles} onSave={onSave} onCancel={() => onEditingChange(false)} />
      ) : (
        <>
          <p className="text-[15px] leading-relaxed whitespace-pre-wrap">{learning.text}</p>
          <dl className="grid grid-cols-[88px_1fr] items-center gap-x-3 gap-y-2.5 text-[13px]">
            <dt className="text-muted-foreground">Roles</dt>
            <dd className="flex flex-wrap gap-1">
              <RolesPills roles={learning.roles} />
            </dd>
            <dt className="text-muted-foreground">Tags</dt>
            <dd className="flex flex-wrap gap-1">
              {learning.tags.length ? learning.tags.map((t) => <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-xs">{t}</span>) : <span className="text-muted-foreground">Sin tags</span>}
            </dd>
            <dt className="text-muted-foreground">Alcance</dt>
            <dd>{scope}</dd>
          </dl>
          <p className="text-[13px] text-muted-foreground">
            {learning.status === "approved"
              ? `Puede entrar al brief de las corridas de ${scope}. De los ${MAX_BRIEF_LEARNINGS} cupos, se reservan hasta ${RESERVED_PROJECT_LEARNINGS} para el proyecto cuando hay learnings propios. En cada alcance tienen prioridad los específicos del rol.`
              : learning.status === "proposed"
                ? `Al aprobarlo entra, desde la próxima corrida, al brief de ${scope}. Mientras tanto ningún agente lo ve.`
                : learning.status === "rejected"
                  ? "No entró nunca a un brief. Si cambias de opinión, se puede aprobar."
                  : "Estaba aprobado y se retiró: ya no entra a los briefs."}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {caps.approve ? (
              <Hint label={`${approveLabel(learning)}: entra a los briefs de su alcance`} keys="A">
                <Button size="sm" onClick={onApprove}>
                  <Check /> {approveLabel(learning)}
                </Button>
              </Hint>
            ) : null}
            {caps.reject ? (
              <Hint label={learning.status === "approved" ? "Retirar: deja de entrar a los briefs" : "Rechazar: no entrará a ningún brief"} keys="R">
                <Button size="sm" variant="secondary" onClick={onReject}>
                  <X /> {rejectLabel(learning)}
                </Button>
              </Hint>
            ) : null}
            <Hint label="Editar el texto, los roles y los tags" keys="E">
              <Button size="sm" variant="ghost" onClick={() => onEditingChange(true)}>
                <Pencil /> Editar
              </Button>
            </Hint>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label="Más acciones">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-52">
                {onOpenRun ? (
                  <>
                    <DropdownMenuItem onSelect={onOpenRun}>
                      <ScrollText /> Abrir la corrida de origen
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                ) : null}
                <DropdownMenuItem onSelect={() => copy(learning.text, "el texto del learning")}>
                  <Copy /> Copiar texto
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => copy(learning.id, "el ID del learning")}>
                  <Copy /> Copiar ID
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </>
      )}
    </article>
  )
}

function EditForm({ learning, knownRoles, onSave, onCancel }: { learning: Learning; knownRoles: string[]; onSave: Props["onSave"]; onCancel: () => void }) {
  const [text, setText] = useState(learning.text)
  const [roles, setRoles] = useState(learning.roles)
  const [tags, setTags] = useState(learning.tags)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])
  const changed = text.trim() !== learning.text || !same(roles, learning.roles) || !same(tags, learning.tags)
  const valid = text.trim() !== ""

  const save = async () => {
    if (!changed || !valid || saving) return
    setSaving(true)
    const failure = await onSave({ text: text.trim(), roles, tags })
    setSaving(false)
    if (failure) setError(failure)
  }
  const suggestions = knownRoles.filter((r) => !roles.includes(r))

  return (
    <form
      aria-label="Editar learning"
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault()
          e.stopPropagation()
          onCancel()
        } else if (e.key === "Enter" && e.metaKey) {
          e.preventDefault()
          void save()
        }
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="learning-text">Texto</Label>
        <Textarea id="learning-text" autoFocus value={text} aria-invalid={!valid || undefined} onChange={(e) => (setText(e.target.value), setError(null))} className="min-h-24 text-[14px] leading-relaxed" />
        <p className="text-xs text-muted-foreground">Una línea que un agente futuro necesite saber. Tal cual se lee, entra al brief.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="learning-roles">Roles</Label>
        <ChipsInput id="learning-roles" value={roles} onChange={setRoles} placeholder="Todos los roles" describedBy="learning-roles-hint" />
        <p id="learning-roles-hint" className="text-xs text-muted-foreground">
          Sin roles, el learning entra al brief de cualquier rol. Escribe un rol y Enter para limitarlo.
        </p>
        {suggestions.length ? (
          <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            Ya usados:
            {suggestions.map((role) => (
              <button key={role} type="button" onClick={() => setRoles([...roles, role])} className="rounded bg-muted px-1.5 py-0.5 text-foreground hover:bg-accent">
                + {role}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="learning-tags">Tags</Label>
        <ChipsInput id="learning-tags" value={tags} onChange={setTags} placeholder="Sin tags" />
      </div>
      <p className="text-xs text-muted-foreground">
        El alcance ({learning.projectId ? "proyecto" : "repo"}) lo fija el core al crear el learning y no se edita.
        {learning.status === "approved" ? " Este learning ya está aprobado: el cambio vale desde la próxima corrida." : ""}
      </p>
      {error ? (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={!changed || !valid || saving}>
          Guardar <Shortcut keys="⌘⏎" className="ml-1 opacity-70" />
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          <Undo2 /> Cancelar
        </Button>
      </div>
    </form>
  )
}
