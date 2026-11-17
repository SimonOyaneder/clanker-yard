import type { ClankerProject, DefRecord, RepoId, StatusCategory } from "@clanker/api"
import { Ellipsis, Plus } from "lucide-react"
import { useState } from "react"
import type { RepoRow } from "@/app-data"
import { Hint, Pill } from "@/components/common"
import { DefOption } from "@/components/def-option"
import { listsProjects, TrackerProjectPicker } from "@/components/tracker-project-picker"
import { ChipsInput, Field, Section } from "@/components/settings/settings-fields"
import { Button } from "@/components/ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useAppActions } from "@/lib/app-context"
import { defName, selectableFlows } from "@/lib/defs"
import { tone } from "@/lib/format"
import {
  CATEGORY_LABELS,
  type ConventionsDraft,
  type ProjectDraft,
  type FlowParamGroups,
  paramChoices,
  paramHelp,
  paramLabel,
  type ParamSpec,
  type FieldProblems,
  STACK_ON_OPTIONS,
  STATUS_CATEGORIES,
} from "@/lib/project-settings"

/** Lo que cada sección edita y lee: el borrador, cómo cambiarlo y lo que impide guardar. */
export interface SectionProps {
  draft: ProjectDraft
  update: (change: Partial<ProjectDraft>) => void
  problems: FieldProblems
}

// Radix Select no admite un valor vacío en un ítem: "sin valor" se representa con un valor propio.
const NONE = "__none__"

/** El texto de un default para decirlo en una ayuda. */
const shown = (value: string | number | boolean) => (typeof value === "string" ? `"${value}"` : String(value))

const MAX_READERS = 3

const TRACKER_NAMES = { local: "el tracker local", linear: "Linear", "github-issues": "GitHub Issues", jira: "Jira" } as const

const describedBy = (id: string, hint: boolean, error: string | undefined) => [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined

// ───────────────────────── Repos

export function TrackerSection({ draft, update, project }: SectionProps & { project: ClankerProject }) {
  const actions = useAppActions()
  const label = project.tracker
  return (
    <Section
      id="tracker"
      title="Proyecto del tracker"
      description={`De qué proyecto de ${label} sale la cola. Cambiarlo solo se puede mientras el proyecto no tenga issues en el caché; con issues, crea un proyecto nuevo.`}
    >
      <Field id="tracker-project" label="Proyecto del tracker">
        {listsProjects(project.tracker) ? (
          <TrackerProjectPicker id="tracker-project" tracker={project.tracker} value={draft.trackerRef} onChange={(trackerRef, trackerAccount) => update({ trackerRef, trackerAccount })} onOpenConnections={actions.goConnections} />
        ) : (
          <Input id="tracker-project" value={draft.trackerRef} onChange={(e) => update({ trackerRef: e.target.value })} />
        )}
      </Field>
    </Section>
  )
}

export function ReposSection({ draft, update, problems, project, registered }: SectionProps & { project: ClankerProject; registered: RepoRow[] }) {
  const actions = useAppActions()
  const byId = new Map(registered.map((r) => [r.repo.id, r.repo]))
  const available = registered.filter((r) => !draft.repos.some((d) => d.repoId === r.repo.id))
  const setLabels = (repoId: RepoId, labels: string[]) => update({ repos: draft.repos.map((r) => (r.repoId === repoId ? { ...r, labels } : r)) })
  const makeDefault = (repoId: RepoId) => update({ repos: [...draft.repos.filter((r) => r.repoId === repoId), ...draft.repos.filter((r) => r.repoId !== repoId)] })
  const remove = (repoId: RepoId) => update({ repos: draft.repos.filter((r) => r.repoId !== repoId) })

  return (
    <Section
      id="repos"
      title="Repos"
      description="Una issue se trabaja en el primer repo de la lista que tenga alguno de sus labels; si ninguno calza, en el primero. Los repos se registran en Conexiones."
    >
      {draft.repos.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-4 text-[13px] text-muted-foreground">
          {project.name} no tiene repos: un flujo que necesita uno no puede arrancar. Agrega uno de los registrados
          {registered.length === 0 ? " (todavía no hay ninguno: regístralo en Conexiones)" : ""}.
        </p>
      ) : (
        <ul className="overflow-hidden rounded-lg border">
          {draft.repos.map((entry, i) => {
            const row = byId.get(entry.repoId)
            const name = row?.name ?? entry.repoId
            const error = problems[`repo:${entry.repoId}`]
            const id = `repo-labels-${entry.repoId}`
            const rowActions = [
              ...(i > 0 ? [{ label: "Hacer repo por defecto", run: () => makeDefault(entry.repoId) }] : []),
              { label: "Quitar del proyecto", run: () => remove(entry.repoId), destructive: true },
            ]
            return (
              <li key={entry.repoId} className="border-b last:border-b-0">
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <div className="flex flex-col gap-1.5 px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{name}</span>
                        {row?.remote ? <span className="font-mono text-xs text-muted-foreground">{row.remote}</span> : null}
                        {i === 0 ? (
                          <Pill className={tone.neutral} hint="Donde van las issues cuyos labels no calzan con ningún repo.">
                            por defecto
                          </Pill>
                        ) : null}
                        <DropdownMenu>
                          <Hint label={`Acciones de ${name}`}>
                            <DropdownMenuTrigger asChild>
                              <Button size="icon-sm" variant="ghost" className="ml-auto" aria-label={`Acciones de ${name}`}>
                                <Ellipsis />
                              </Button>
                            </DropdownMenuTrigger>
                          </Hint>
                          <DropdownMenuContent align="end" className="w-52">
                            {rowActions.map((action) => (
                              <DropdownMenuItem key={action.label} variant={action.destructive ? "destructive" : "default"} onSelect={action.run}>
                                {action.label}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      <ChipsInput
                        id={id}
                        value={entry.labels}
                        onChange={(labels) => setLabels(entry.repoId, labels)}
                        label={`Labels de ${name}`}
                        placeholder="Labels de issue que mandan acá (Enter para agregar)"
                        invalid={!!error}
                        describedBy={describedBy(id, false, error)}
                      />
                      {error ? (
                        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
                          {error}
                        </p>
                      ) : null}
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-52">
                    {rowActions.map((action) => (
                      <ContextMenuItem key={action.label} variant={action.destructive ? "destructive" : "default"} onSelect={action.run}>
                        {action.label}
                      </ContextMenuItem>
                    ))}
                  </ContextMenuContent>
                </ContextMenu>
              </li>
            )
          })}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <Select
          value=""
          onValueChange={(id) => {
            const picked = available.find((r) => r.repo.id === id)
            if (picked) update({ repos: [...draft.repos, { repoId: picked.repo.id, labels: [] }] })
          }}
          disabled={available.length === 0}
        >
          <SelectTrigger size="sm" aria-label="Agregar un repo registrado" className="w-72">
            <Plus />
            <SelectValue placeholder={available.length ? "Agregar un repo registrado" : "No quedan repos por agregar"} />
          </SelectTrigger>
          <SelectContent>
            {available.map((r) => (
              <SelectItem key={r.repo.id} value={r.repo.id}>
                {r.repo.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="ghost" onClick={actions.goConnections}>
          Registrar otro en Conexiones
        </Button>
      </div>
    </Section>
  )
}

// ───────────────────────── Cola

export function QueueSection({ draft, update, problems }: SectionProps) {
  return (
    <Section id="queue" title="Filtros de la cola" description="Qué issues del tracker entran a la cola. Los tres se combinan: la issue cumple todos.">
      <Field
        id="queue-status"
        label="Estados"
        hint={draft.status.length ? "La issue está en alguno de estos estados." : "Sin ninguno rige el default: solo Todo."}
      >
        <ToggleGroup
          id="queue-status"
          type="multiple"
          variant="outline"
          size="sm"
          value={draft.status}
          onValueChange={(status) => update({ status: STATUS_CATEGORIES.filter((s) => status.includes(s)) })}
          aria-label="Estados que entran a la cola"
          className="flex-wrap"
        >
          {STATUS_CATEGORIES.map((s) => (
            <ToggleGroupItem key={s} value={s} className="h-8 px-3 text-[13px]">
              {CATEGORY_LABELS[s]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Field>
      <Field id="queue-labels" label="Labels que debe tener" hint="La issue tiene todos. Vacío no pide ninguno.">
        <ChipsInput id="queue-labels" value={draft.labels} onChange={(labels) => update({ labels })} placeholder="clanker (Enter para agregar)" describedBy="queue-labels-hint" />
      </Field>
      <Field
        id="queue-exclude"
        label="Labels que la sacan de la cola"
        hint="Vacío excluye `no-clanker`, el default."
        error={problems.excludeLabels}
      >
        <ChipsInput
          id="queue-exclude"
          value={draft.excludeLabels}
          onChange={(excludeLabels) => update({ excludeLabels })}
          placeholder="no-clanker"
          invalid={!!problems.excludeLabels}
          describedBy={describedBy("queue-exclude", true, problems.excludeLabels)}
        />
      </Field>
    </Section>
  )
}

// ───────────────────────── Mapeo de estados

const AUTO = "__auto__"

export function StatusMappingSection({
  draft,
  update,
  project,
  observed,
}: SectionProps & { project: ClankerProject; observed: { rawStatus: string; status: StatusCategory }[] }) {
  const [adding, setAdding] = useState("")
  // Los estados que se agregaron a mano y todavía no tienen categoría propia.
  const [added, setAdded] = useState<string[]>([])
  if (project.tracker === "local") {
    return (
      <Section id="status" title="Mapeo de estados" description="Cómo cada estado del tracker cuenta como una categoría.">
        <p className="text-[13px] text-muted-foreground">El tracker local ya usa las categorías como estados: no hay nada que mapear. Con Linear u otro tracker, cada estado suyo se traduce a una categoría y aquí se ajusta.</p>
      </Section>
    )
  }
  // Cada estado que las issues del proyecto traen, con la categoría que hoy le da el adapter; más los que ya se ajustaron.
  const names = [...new Set([...observed.map((o) => o.rawStatus), ...Object.keys(draft.statusMapping), ...added])].sort()
  const effective = new Map(observed.map((o) => [o.rawStatus, o.status]))
  const set = (name: string, value: string) => {
    const next = { ...draft.statusMapping, [name]: value as StatusCategory }
    if (value === AUTO) delete next[name]
    update({ statusMapping: next })
  }
  const add = () => {
    const name = adding.trim()
    if (!name) return
    setAdded((list) => (list.includes(name) ? list : [...list, name]))
    setAdding("")
  }
  return (
    <Section
      id="status"
      title="Mapeo de estados"
      description={`Cada estado de ${TRACKER_NAMES[project.tracker]} cuenta como una categoría. Elige una para ajustar la que da el adapter; "Automática" deja la del adapter. Al guardar, las issues del proyecto se releen.`}
    >
      {names.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-4 text-[13px] text-muted-foreground">Todavía no hay issues sincronizadas con estados que mostrar. Agrega a mano el nombre exacto de un estado del tracker para ajustarlo.</p>
      ) : (
        <ul className="overflow-hidden rounded-lg border">
          {names.map((name) => {
            const mapped = draft.statusMapping[name]
            return (
              <li key={name} className="flex items-center gap-3 border-b px-3 py-1.5 last:border-b-0">
                <span className="min-w-0 flex-1 truncate">{name}</span>
                {mapped === undefined && effective.has(name) ? <span className="text-xs text-muted-foreground">hoy: {CATEGORY_LABELS[effective.get(name)!]}</span> : null}
                <Select value={mapped ?? AUTO} onValueChange={(value) => set(name, value)}>
                  <SelectTrigger size="sm" aria-label={`Categoría de ${name}`} className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={AUTO}>Automática</SelectItem>
                    {STATUS_CATEGORIES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {CATEGORY_LABELS[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </li>
            )
          })}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <Input
          aria-label="Nombre de un estado del tracker"
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              add()
            }
          }}
          placeholder="Otro estado, con su nombre exacto"
          className="h-8 w-80 text-[13px]"
        />
        <Button size="sm" variant="outline" onClick={add} disabled={!adding.trim()}>
          Agregar estado
        </Button>
      </div>
    </Section>
  )
}

// ───────────────────────── Flujo y parámetros

/** `readers` son los flujos que leen este parámetro del proyecto, cada uno con el default que usa si queda vacío; `also` dice si el flujo por defecto ya lo lee. */
function ParamField({ spec, draft, update, problems, readers, also }: SectionProps & { spec: ParamSpec; readers: ParamSpec["flows"]; also: boolean }) {
  const id = `param-${spec.name}`
  const error = problems[`param:${spec.name}`]
  const value = draft.params[spec.name] ?? ""
  const set = (text: string) => update({ params: { ...draft.params, [spec.name]: text } })
  const hint = (
    <>
      {paramHelp(spec.name) ? `${paramHelp(spec.name)} ` : null}
      {spec.default === null ? "Vacío usa el default de cada flujo." : `Vacío usa el default del flujo (${shown(spec.default)}).`}
      {readers.length
        ? ` ${also ? "También lo" : "Lo"} lee${readers.length > 1 ? "n" : ""}: ${readers
            .slice(0, MAX_READERS)
            .map((f) => `${f.slug} (default ${shown(f.default)})`)
            .join(", ")}${readers.length > MAX_READERS ? ` y ${readers.length - MAX_READERS} más` : ""}.`
        : null}
    </>
  )
  const choices = paramChoices(spec.name) ?? (spec.type === "boolean" ? [{ value: "true", label: "Sí" }, { value: "false", label: "No" }] : undefined)
  return (
    <Field id={id} label={paramLabel(spec.name)} hint={hint} error={error}>
      {choices ? (
        <Select value={value || NONE} onValueChange={(v) => set(v === NONE ? "" : v)}>
          <SelectTrigger id={id} size="sm" aria-invalid={!!error} aria-describedby={describedBy(id, true, error)} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{spec.default === null ? "Default de cada flujo" : `Default del flujo (${shown(spec.default)})`}</SelectItem>
            {choices.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={id}
          value={value}
          onChange={(e) => set(e.target.value)}
          inputMode={spec.type === "number" ? "numeric" : undefined}
          placeholder={spec.default === null ? "según el flujo" : String(spec.default)}
          aria-invalid={!!error}
          aria-describedby={describedBy(id, true, error)}
          className="h-8 w-full text-[13px]"
        />
      )}
    </Field>
  )
}

export function FlowSection({
  draft,
  update,
  problems,
  flows,
  profiles,
  groups,
}: SectionProps & { flows: DefRecord[]; profiles: DefRecord[]; groups: FlowParamGroups }) {
  const flowOf = flows.find((f) => f.slug === draft.defaultFlowId)
  return (
    <Section
      id="flow"
      title="Flujo y parámetros"
      description="Los parámetros pisan los defaults del flujo en este proyecto, sin crear una versión nueva del flujo. Valen para las corridas nuevas; las que ya corren siguen con los suyos."
    >
      <div className="grid gap-4 @xl:grid-cols-2">
        <Field id="default-flow" label="Flujo por defecto" hint="El que corre una issue si no se pide otro.">
          <Select value={draft.defaultFlowId ?? NONE} onValueChange={(v) => update({ defaultFlowId: v === NONE ? null : v })}>
            <SelectTrigger id="default-flow" size="sm" className="w-full">
              <SelectValue>{flowOf ? defName(flowOf) : (draft.defaultFlowId ?? "Sin flujo")}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Sin flujo</SelectItem>
              {selectableFlows(flows, draft.defaultFlowId).map((f) => (
                <SelectItem key={f.slug} value={f.slug}>
                  <DefOption def={f} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id="default-profile" label="Perfil por defecto" hint="Con el que corren los pasos de agente.">
          <Select value={draft.defaultProfileId ?? NONE} onValueChange={(v) => update({ defaultProfileId: v === NONE ? null : v })}>
            <SelectTrigger id="default-profile" size="sm" className="w-full">
              <SelectValue>{draft.defaultProfileId ?? "Sin perfil"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Sin perfil</SelectItem>
              {profiles.map((p) => (
                <SelectItem key={p.slug} value={p.slug}>
                  <DefOption def={p} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      {draft.defaultFlowId === null ? (
        <p className="text-[13px] text-muted-foreground">Sin flujo por defecto, `runs.start` pide el flujo en cada llamada. Elige uno para ajustar sus parámetros.</p>
      ) : groups.own.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">El flujo {draft.defaultFlowId} no declara parámetros con default.</p>
      ) : (
        <div className="grid gap-4 @xl:grid-cols-2 @3xl:grid-cols-3">
          {groups.own.map((spec) => (
            <ParamField key={spec.name} spec={spec} draft={draft} update={update} problems={problems} readers={spec.flows.filter((f) => f.slug !== draft.defaultFlowId)} also />
          ))}
        </div>
      )}
      {groups.triggered.length ? (
        <div className="flex flex-col gap-3 border-t pt-4">
          <div className="flex flex-col gap-0.5">
            <h3 className="text-[13px] font-medium">Flujos que arrancan solos</h3>
            <p className="text-xs text-muted-foreground">Un conflicto, un comentario o un merge lanzan estos flujos sin pasar por la cola. Leen los mismos parámetros del proyecto.</p>
          </div>
          <div className="grid gap-4 @xl:grid-cols-2 @3xl:grid-cols-3">
            {groups.triggered.map((spec) => (
              <ParamField key={spec.name} spec={spec} draft={draft} update={update} problems={problems} readers={spec.flows} also={false} />
            ))}
          </div>
        </div>
      ) : null}
    </Section>
  )
}

// ───────────────────────── Apilado y gasto

export function LimitsSection({ draft, update, problems }: SectionProps) {
  const option = STACK_ON_OPTIONS.find((o) => o.value === draft.stackOn)
  return (
    <Section
      id="limits"
      title="Apilado y gasto"
      description="Cuándo una issue bloqueada se apila sobre el PR de su bloqueante, cuántas corridas del proyecto van a la vez y cuánto puede gastar cada corrida."
    >
      <div className="grid gap-4 @xl:grid-cols-2 @3xl:grid-cols-3">
        <Field id="stack-on" label="Apilar sobre el PR del bloqueante cuando" hint={option?.hint}>
          <Select value={draft.stackOn} onValueChange={(v) => update({ stackOn: v as ProjectDraft["stackOn"] })}>
            <SelectTrigger id="stack-on" size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STACK_ON_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field
          id="parallel"
          label="Corridas a la vez del proyecto"
          hint="Cuántas corridas de este proyecto pueden ir a la vez. No es el carril: el carril es el tope de la máquina entera y se cambia desde Operación."
          error={problems.parallel}
        >
          <Input
            id="parallel"
            value={draft.parallel}
            onChange={(e) => update({ parallel: e.target.value })}
            inputMode="numeric"
            aria-invalid={!!problems.parallel}
            aria-describedby={describedBy("parallel", true, problems.parallel)}
            className="h-8 w-full text-[13px]"
          />
        </Field>
        <Field id="max-cost" label="Tope de gasto por corrida (USD)" hint="Vacío es sin tope. Una corrida que lo pasa se estaciona y pide tu decisión." error={problems.maxCostUsd}>
          <Input
            id="max-cost"
            value={draft.maxCostUsd}
            onChange={(e) => update({ maxCostUsd: e.target.value })}
            inputMode="decimal"
            placeholder="Sin tope"
            aria-invalid={!!problems.maxCostUsd}
            aria-describedby={describedBy("max-cost", true, problems.maxCostUsd)}
            className="h-8 w-full text-[13px]"
          />
        </Field>
      </div>
    </Section>
  )
}

// ───────────────────────── Convenciones

export function ConventionsSection({ draft, update, problems, hasContext }: SectionProps & { hasContext: boolean }) {
  const c = draft.conventions
  const set = (change: Partial<ConventionsDraft>) => update({ conventions: { ...c, ...change } })
  return (
    <Section id="conventions" title="Convenciones" description="Reglas del proyecto para los comentarios y los PRs. Lo que dejes vacío lo decide el pack.">
      <div className="grid gap-4 @xl:grid-cols-2">
        <Field id="comment-prefix" label="Prefijo de los comentarios" hint="Empieza cada comentario que el sistema deja en un PR.">
          <Input id="comment-prefix" value={c.commentPrefix} onChange={(e) => set({ commentPrefix: e.target.value })} placeholder="[clanker]" className="h-8 text-[13px]" />
        </Field>
        <Field id="council-prefix" label="Prefijo de los comentarios del council" hint="Marca los threads que el sistema debe atender.">
          <Input id="council-prefix" value={c.councilPrefix} onChange={(e) => set({ councilPrefix: e.target.value })} placeholder="[clanker-council]" className="h-8 text-[13px]" />
        </Field>
        <Field id="commits" label="Formato de commits">
          <Select value={c.commits || NONE} onValueChange={(v) => set({ commits: v === NONE ? "" : (v as ConventionsDraft["commits"]) })}>
            <SelectTrigger id="commits" size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Según el pack</SelectItem>
              <SelectItem value="conventional">Conventional Commits</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field id="no-ai" label="Sin atribución a una IA en commits y PRs">
          <div className="flex h-8 items-center gap-3">
            <Switch
              id="no-ai"
              checked={c.noAiAttribution === "yes"}
              onCheckedChange={(on) => set({ noAiAttribution: on ? "yes" : "no" })}
              aria-describedby="no-ai-state"
            />
            <span id="no-ai-state" className="text-xs text-muted-foreground">
              {c.noAiAttribution === "" ? "Según el pack" : c.noAiAttribution === "yes" ? "Sí, nunca se menciona" : "No: se permite"}
            </span>
            {c.noAiAttribution !== "" ? (
              <Button size="xs" variant="ghost" onClick={() => set({ noAiAttribution: "" })}>
                Volver al pack
              </Button>
            ) : null}
          </div>
        </Field>
        <Field id="pr-template" label="Plantilla de la descripción del PR" hint="Ruta relativa al pack." error={problems.prTemplate}>
          <Input
            id="pr-template"
            value={c.prTemplate}
            onChange={(e) => set({ prTemplate: e.target.value })}
            placeholder="templates/pr.md"
            aria-invalid={!!problems.prTemplate}
            aria-describedby={describedBy("pr-template", true, problems.prTemplate)}
            className="h-8 text-[13px]"
          />
        </Field>
        <Field id="omit-sections" label="Secciones que se omiten del PR" hint="Por nombre, como aparecen en la plantilla.">
          <ChipsInput id="omit-sections" value={c.omitSections} onChange={(omitSections) => set({ omitSections })} placeholder="Capturas (Enter para agregar)" describedBy="omit-sections-hint" />
        </Field>
      </div>
      {hasContext ? <p className="text-xs text-muted-foreground">El contexto extra por rol de este proyecto se conserva tal cual: se edita con la API.</p> : null}
    </Section>
  )
}
