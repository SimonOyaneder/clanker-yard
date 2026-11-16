import type { ClankerProject, Learning, LearningStatus, RepoId } from "@clanker/api"
import { Archive, BookCheck, Check, Copy, Pencil, Plus, ScrollText, Search, SquareCheck, X } from "lucide-react"
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react"
import { useAppData } from "@/app-data"
import { Ago, Hint, Shortcut } from "@/components/common"
import { LearningDetail, type LearningPatchInput } from "@/components/learnings/learning-detail"
import { RolesPills, scopeName, SourcePill } from "@/components/learnings/learning-parts"
import { NewLearningDialog } from "@/components/learnings/new-learning-dialog"
import { ScreenDialog } from "@/components/learnings/screen-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from "@/components/ui/context-menu"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useLiveQuery } from "@/hooks/use-live"
import type { LearningsView as ViewState } from "@/hooks/use-learnings-view"
import { useAppActions } from "@/lib/app-context"
import { copy } from "@/lib/clipboard"
import { approveLabel, capsOf, rejectLabel, rolesOf, scopeFromKey, scopeKey, scopesOf, SOURCE_LABEL, SOURCES, STATUS_HINT, STATUS_LABEL, STATUSES, type TriageAction } from "@/lib/learnings"
import { undoable } from "@/lib/undoable"
import { cn } from "@/lib/utils"

const ALL = "all"
const NO_ROLE = "none"

const typing = (target: EventTarget | null) => !!(target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable='true']")

interface Props {
  /** Todos, con lo que espera su plazo de deshacer ya aplicado. */
  learnings: Learning[]
  projects: ClankerProject[]
  view: ViewState
  /** Editar no emite evento: quien tiene la lista la relee al guardar y al deshacer. */
  onEdited: () => void
}

// La revisión de learnings (`docs/design.html#d-ui`): lista a la izquierda con casillas para triar en lote, el
// learning a la vista a la derecha. Aprobar es de la app: lo aprobado entra a los briefs sin otra revisión.
export function LearningsView({ learnings, projects, view, onEdited }: Props) {
  const appData = useAppData()
  const actions = useAppActions()
  const search = useRef<HTMLInputElement>(null)
  const { items, current, selected, counts, tab } = view
  const [screening, setScreening] = useState(false)
  const [creating, setCreating] = useState(false)

  // El nombre de cada repo con learnings: solo se piden las recetas si hay alguno con alcance de repo.
  const { repos: repoIds } = useMemo(() => scopesOf(learnings), [learnings])
  const repoData = useLiveQuery(`learning-repos:${repoIds.join(",")}`, async () => (repoIds.length ? await appData.repos() : []), { live: false })
  const repoNames = useMemo(() => new Map<RepoId, string>((repoData.data ?? []).map((r) => [r.repo.id, r.repo.name])), [repoData.data])
  const roles = useMemo(() => rolesOf(learnings), [learnings])
  const scopes = useMemo(() => scopesOf(learnings), [learnings])
  const scopeOf = (l: Learning) => scopeName(l, projects, repoNames)
  const openRunOf = (l: Learning) => {
    const slug = projects.find((p) => p.id === l.projectId)?.slug
    return slug && l.sourceRunId ? () => actions.openRun(slug, l.sourceRunId!) : null
  }

  // J y K, X, A, R, E, ⌘A, Esc y /. Z (deshacer) vive en la app: el aviso sigue ahí aunque cambies de vista.
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.ctrlKey || e.altKey || e.repeat || typing(e.target)) return
    if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return
    const key = e.key.toLowerCase()
    if (e.metaKey) {
      if (key === "a" && !e.shiftKey) {
        e.preventDefault()
        view.selectAll()
      }
      return
    }
    if (e.shiftKey && key !== "/") return
    if (key === "j" || key === "k") view.move(key === "j" ? 1 : -1)
    else if (key === "x" && current) view.toggle(current.id)
    else if (key === "a" && view.targets.some((l) => capsOf(l).approve)) view.act("approve")
    else if (key === "r" && view.targets.some((l) => capsOf(l).reject)) view.act("reject")
    else if (key === "e" && current) {
      e.preventDefault()
      view.setEditing(true)
    } else if (key === "/") {
      e.preventDefault()
      search.current?.focus()
    } else if (key === "escape" && selected.length) view.clearSelection()
  })
  useEffect(() => {
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // El learning a la vista se mantiene visible al moverse con J y K.
  useEffect(() => {
    document.querySelector(`[data-learning="${current?.id}"]`)?.scrollIntoView?.({ block: "nearest" })
  }, [current?.id])

  const save = (l: Learning) => async (patch: LearningPatchInput): Promise<string | null> => {
    const before = { text: l.text, roles: l.roles, tags: l.tags }
    // Editar no emite evento: la lista se relee a mano al guardar y al deshacer.
    const failure = await undoable(
      "Guardé los cambios del learning",
      () => appData.updateLearning({ id: l.id, ...patch }).then(onEdited),
      () => appData.updateLearning({ id: l.id, ...before }).then(onEdited),
    )
    if (!failure) view.setEditing(false)
    return failure
  }

  const bulk = selected.length > 0
  const allVisible = items.length > 0 && selected.length === items.length
  const approvable = view.targets.filter((l) => capsOf(l).approve).length
  const rejectable = view.targets.filter((l) => capsOf(l).reject).length

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-none flex-wrap items-center gap-3 border-b px-4 py-2">
        <Tabs value={tab} onValueChange={(v) => view.setTab(v as LearningStatus)} className="gap-0">
          <TabsList>
            {STATUSES.map((status) => (
              <Hint key={status} label={STATUS_HINT[status]}>
                <TabsTrigger value={status}>
                  {STATUS_LABEL[status]} <span className="text-xs tabular-nums opacity-70">{counts[status]}</span>
                </TabsTrigger>
              </Hint>
            ))}
          </TabsList>
        </Tabs>
        <div className="relative min-w-36 max-w-60 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={search}
            value={view.filters.query}
            onChange={(e) => view.setFilters({ query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation()
                if (view.filters.query) view.setFilters({ query: "" })
                else e.currentTarget.blur()
              }
            }}
            placeholder="Buscar en el texto o los tags…"
            aria-label="Buscar learnings"
            className="h-8 w-full pr-7 pl-7 text-[13px]"
          />
          <Shortcut keys="/" className="absolute top-1/2 right-1.5 -translate-y-1/2" />
        </div>
        <Select value={scopeKey(view.filters.scope)} onValueChange={(v) => view.setFilters({ scope: scopeFromKey(v) })}>
          <SelectTrigger size="sm" aria-label="Filtrar por proyecto o repo">
            <SelectValue>{view.filters.scope ? undefined : "Alcance"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todos los alcances</SelectItem>
            {scopes.projects.length ? (
              <SelectGroup>
                <SelectSeparator />
                <SelectLabel>Proyectos</SelectLabel>
                {scopes.projects.map((id) => (
                  <SelectItem key={id} value={`p:${id}`}>
                    {projects.find((p) => p.id === id)?.name ?? id}
                  </SelectItem>
                ))}
              </SelectGroup>
            ) : null}
            {scopes.repos.length ? (
              <SelectGroup>
                <SelectSeparator />
                <SelectLabel>Repos</SelectLabel>
                {scopes.repos.map((id) => (
                  <SelectItem key={id} value={`r:${id}`}>
                    {repoNames.get(id) ?? id}
                  </SelectItem>
                ))}
              </SelectGroup>
            ) : null}
          </SelectContent>
        </Select>
        <Select value={view.filters.role === null ? ALL : view.filters.role === "" ? NO_ROLE : view.filters.role} onValueChange={(v) => view.setFilters({ role: v === ALL ? null : v === NO_ROLE ? "" : v })}>
          <SelectTrigger size="sm" aria-label="Filtrar por rol">
            <SelectValue>{view.filters.role === null ? "Rol" : undefined}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todos los roles</SelectItem>
            <SelectItem value={NO_ROLE}>Sin rol (valen para todos)</SelectItem>
            {roles.map((role) => (
              <SelectItem key={role} value={role}>
                {role}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={view.filters.source ?? ALL} onValueChange={(v) => view.setFilters({ source: v === ALL ? null : (v as Learning["source"]) })}>
          <SelectTrigger size="sm" aria-label="Filtrar por origen">
            <SelectValue>{view.filters.source ? undefined : "Origen"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todos los orígenes</SelectItem>
            {SOURCES.map((source) => (
              <SelectItem key={source} value={source}>
                {SOURCE_LABEL[source]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {view.filtered ? (
          <Button size="sm" variant="ghost" onClick={view.clearFilters}>
            Quitar filtros
          </Button>
        ) : null}
        <Button size="sm" className="ml-auto" onClick={() => setCreating(true)}>
          <Plus /> Nuevo learning
        </Button>
        {learnings.some((l) => l.status === "proposed" && l.source === "agent") ? (
          <Hint label="Un agente revisa los propuestos por agentes con el criterio (reutilizable, no obvio, comprobado, una línea) y te muestra cuáles archivaría">
            <Button size="sm" variant="secondary" onClick={() => setScreening(true)}>
              <Archive /> Filtrar con el criterio
            </Button>
          </Hint>
        ) : null}
      </div>
      <NewLearningDialog open={creating} onOpenChange={setCreating} projects={projects} learnings={learnings} onCreated={onEdited} />
      <ScreenDialog open={screening} onOpenChange={setScreening} learnings={learnings} onArchived={onEdited} />

      {learnings.length === 0 ? (
        <NothingYet />
      ) : items.length === 0 ? (
        <Empty view={view} />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(360px,520px)_minmax(0,1fr)]">
          <div className="flex min-h-0 flex-col border-r">
            <div className={cn("flex h-10 flex-none items-center gap-3 border-b px-4 text-[13px]", bulk && "bg-muted/50")}>
              <Hint label={allVisible ? "Quitar la selección" : `Marcar los ${items.length} que se ven`} keys="⌘A">
                <Checkbox
                  aria-label={allVisible ? "Quitar la selección" : "Marcar todos los que se ven"}
                  checked={allVisible ? true : bulk ? "indeterminate" : false}
                  onCheckedChange={() => (allVisible ? view.clearSelection() : view.selectAll())}
                />
              </Hint>
              {bulk ? (
                <>
                  <span className="font-medium tabular-nums">
                    {selected.length} marcado{selected.length === 1 ? "" : "s"}
                  </span>
                  <span className="flex-1" />
                  {approvable ? (
                    <Hint label={`${selected.length === 1 ? "Aprobar" : `Aprobar ${approvable}`}: entran a los briefs de su alcance`} keys="A">
                      <Button size="xs" onClick={() => view.act("approve")}>
                        <Check /> Aprobar {approvable}
                      </Button>
                    </Hint>
                  ) : null}
                  {rejectable ? (
                    <Hint label={tab === "approved" ? "Retirar: dejan de entrar a los briefs" : "Rechazar: no entrarán a ningún brief"} keys="R">
                      <Button size="xs" variant="secondary" onClick={() => view.act("reject")}>
                        <X /> {tab === "approved" ? "Retirar" : "Rechazar"} {rejectable}
                      </Button>
                    </Hint>
                  ) : null}
                  <Hint label="Quitar la selección" keys="⎋">
                    <Button size="xs" variant="ghost" onClick={view.clearSelection}>
                      Limpiar
                    </Button>
                  </Hint>
                </>
              ) : (
                <span className="text-muted-foreground tabular-nums">
                  {items.length} {STATUS_LABEL[tab].toLowerCase()}
                  {view.filtered ? " con estos filtros" : ""}
                </span>
              )}
            </div>
            <ul aria-label={`Learnings: ${STATUS_LABEL[tab].toLowerCase()}`} data-learnings-list className="min-h-0 flex-1 divide-y overflow-y-auto">
              {items.map((l) => (
                <Row
                  key={l.id}
                  learning={l}
                  scope={scopeOf(l)}
                  active={l.id === current?.id}
                  checked={selected.some((s) => s.id === l.id)}
                  groupSize={selected.length}
                  onSelect={() => view.select(l.id)}
                  onToggle={(range) => view.toggle(l.id, range)}
                  onAct={(action) => {
                    const inSelection = selected.some((s) => s.id === l.id)
                    view.act(action, inSelection ? selected : [l])
                  }}
                  onEdit={() => {
                    view.select(l.id)
                    view.setEditing(true, l.id)
                  }}
                  onOpenRun={openRunOf(l)}
                />
              ))}
            </ul>
          </div>
          <section aria-label="Detalle del learning" className="min-h-0 overflow-y-auto px-6 py-5">
            {current ? (
              <LearningDetail
                key={current.id}
                learning={current}
                scope={scopeOf(current)}
                knownRoles={roles}
                editing={view.editing}
                onEditingChange={(on) => view.setEditing(on, current.id)}
                onApprove={() => view.act("approve", [current])}
                onReject={() => view.act("reject", [current])}
                onSave={save(current)}
                onOpenRun={openRunOf(current)}
              />
            ) : null}
          </section>
        </div>
      )}
    </div>
  )
}

function Row({
  learning,
  scope,
  active,
  checked,
  groupSize,
  onSelect,
  onToggle,
  onAct,
  onEdit,
  onOpenRun,
}: {
  learning: Learning
  scope: string
  active: boolean
  checked: boolean
  /** Cuántos hay marcados: si esta fila es uno de varios, el menú actúa sobre todos. */
  groupSize: number
  onSelect: () => void
  onToggle: (range: boolean) => void
  onAct: (action: TriageAction) => void
  onEdit: () => void
  onOpenRun: (() => void) | null
}) {
  const caps = capsOf(learning)
  const many = checked && groupSize > 1
  const suffix = many ? ` ${groupSize} marcados` : ""
  return (
    <li data-learning={learning.id} className={cn("flex items-start gap-3 px-4 py-2.5", active && "bg-muted/60 shadow-[inset_2px_0_0_var(--primary)]", checked && "bg-accent/40")}>
      <Checkbox
        aria-label={`Marcar «${learning.text.slice(0, 40)}»`}
        checked={checked}
        onClick={(e) => {
          // Shift marca el rango desde el último marcado, como en una lista de correo.
          e.preventDefault()
          onToggle(e.shiftKey)
        }}
        className="mt-0.5"
      />
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            aria-current={active ? "true" : undefined}
            onClick={onSelect}
            className="flex min-w-0 flex-1 flex-col gap-1.5 rounded text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <span className="line-clamp-2 text-[13px] leading-snug">{learning.text}</span>
            <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <SourcePill source={learning.source} />
              <RolesPills roles={learning.roles} max={2} />
              <span className="min-w-0 truncate">{scope}</span>
              <span>·</span>
              <Ago at={learning.createdAt} className="flex-none" />
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-64">
          {caps.approve ? (
            <ContextMenuItem onSelect={() => onAct("approve")}>
              <Check /> {approveLabel(learning)}
              {suffix}
              <ContextMenuShortcut>A</ContextMenuShortcut>
            </ContextMenuItem>
          ) : null}
          {caps.reject ? (
            <ContextMenuItem onSelect={() => onAct("reject")}>
              <X /> {rejectLabel(learning)}
              {suffix}
              <ContextMenuShortcut>R</ContextMenuShortcut>
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem onSelect={onEdit}>
            <Pencil /> Editar texto y roles…
            <ContextMenuShortcut>E</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onToggle(false)}>
            <SquareCheck /> {checked ? "Quitar de los marcados" : "Marcar"}
            <ContextMenuShortcut>X</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          {onOpenRun ? (
            <ContextMenuItem onSelect={onOpenRun}>
              <ScrollText /> Abrir la corrida de origen
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem onSelect={() => copy(learning.text, "el texto del learning")}>
            <Copy /> Copiar texto
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => copy(learning.id, "el ID del learning")}>
            <Copy /> Copiar ID
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  )
}

// Un estado vacío que dice qué hacer, no solo que no hay nada.
function Empty({ view }: { view: ViewState }) {
  const others = STATUSES.filter((s) => s !== view.tab).reduce((sum, s) => sum + view.counts[s], 0)
  if (view.filtered) {
    return (
      <EmptyBlock title="Ningún learning coincide con los filtros">
        {others > 0 ? `Con estos filtros hay ${others} en otras pestañas.` : "Prueba con otro texto, otro rol u otro origen."}
        <Button size="sm" variant="secondary" onClick={view.clearFilters}>
          Quitar filtros
        </Button>
      </EmptyBlock>
    )
  }
  if (view.tab === "proposed") {
    return (
      <EmptyBlock title="Nada por revisar">
        Los agentes proponen learnings en el reporte de cada paso, y la importación del clanker-loop los deja aquí. Ninguno entra a un brief hasta que lo apruebes.
        <Button size="sm" variant="secondary" onClick={() => view.setTab("approved")}>
          Ver los aprobados
        </Button>
      </EmptyBlock>
    )
  }
  return (
    <EmptyBlock title={`No hay learnings ${view.tab === "approved" ? "aprobados" : view.tab === "rejected" ? "rechazados" : "retirados"}`}>
      {view.tab === "approved" ? "Aprueba los que sirvan en Por revisar: entran a los briefs de su alcance desde la próxima corrida." : STATUS_HINT[view.tab]}
      <Button size="sm" variant="secondary" onClick={() => view.setTab("proposed")}>
        Ir a Por revisar
      </Button>
    </EmptyBlock>
  )
}

function NothingYet() {
  return (
    <EmptyBlock title="Todavía no hay learnings">
      Un learning es algo que un agente futuro necesita saber del proyecto. Los agentes los proponen al terminar un paso, y los del clanker-loop viejo se traen con la importación. Todos llegan aquí para que los apruebes.
      <Button size="sm" variant="secondary" onClick={() => copy("clanker import legacy --from <carpeta del loop> --dry-run", "el comando de importación")}>
        <Copy /> Copiar el comando de importación
      </Button>
    </EmptyBlock>
  )
}

function EmptyBlock({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mx-auto mt-24 flex max-w-sm flex-col items-center gap-2 px-4 text-center">
      <BookCheck className="size-6 text-muted-foreground" />
      <h2 className="text-base font-semibold">{title}</h2>
      {children ? <div className="flex flex-col items-center gap-2 text-muted-foreground">{children}</div> : null}
    </div>
  )
}
