import type { ClankerProject, DefRecord, DefWriteKind } from "@clanker/api"
import { DEF_TRIGGERS } from "@/lib/live-triggers"
import { ChevronRight, Plus } from "lucide-react"
import { useMemo, useState } from "react"
import { useAppData } from "@/app-data"
import { DefDetail } from "@/components/flows/def-detail"
import { RowPills, UsedBy } from "@/components/flows/flow-parts"
import { NewProfileDialog } from "@/components/flows/new-profile-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useLiveQuery } from "@/hooks/use-live"
import { KIND_LABEL, libraryRows, nameOf, type LibraryRow } from "@/lib/flows/defs-library"
import { cn } from "@/lib/utils"

const KINDS: readonly DefWriteKind[] = ["flow", "role", "profile"]

const INTRO: Record<DefWriteKind, string> = {
  flow: "Un flujo es la receta con que trabaja una corrida: sus pasos y qué pasa después de cada uno.",
  role: "Un rol es un agente con una tarea fija (implementar, revisar bugs, hacer commits): sus instrucciones, sus herramientas y su contexto.",
  profile: "Un perfil dice qué modelo usa cada agente del flujo: más potente = mejor, pero más caro.",
}

const NOTHING_YET: Record<DefWriteKind, string> = {
  flow: "Todavía no hay flujos. Los que vienen con la app aparecen aquí cuando el core arranca; si esperabas verlos, revisa en la barra lateral que el core esté conectado.",
  role: "Todavía no hay roles. Los que vienen con la app aparecen aquí cuando el core arranca; si esperabas verlos, revisa en la barra lateral que el core esté conectado.",
  profile: "Todavía no hay perfiles. Los que vienen con la app aparecen aquí cuando el core arranca; si esperabas verlos, revisa en la barra lateral que el core esté conectado.",
}

const byName = (a: LibraryRow, b: LibraryRow) => nameOf(a.def).localeCompare(nameOf(b.def), "es")

// La biblioteca (`docs/design.html#d-flows`): flujos, roles y perfiles con su origen, su versión vigente y en qué
// proyectos se usan. Los flujos internos (los que lanza el sistema) van aparte y plegados: no se eligen.
export function FlowsView({ projects }: { projects: ClankerProject[] }) {
  const appData = useAppData()
  const [tab, setTab] = useState<DefWriteKind>("flow")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [showInternal, setShowInternal] = useState(false)
  const [creatingProfile, setCreatingProfile] = useState(false)
  // Editando un flujo la vista es solo el editor: sin pestañas ni lista.
  const [editingFlow, setEditingFlow] = useState(false)

  const flows = useLiveQuery("library:flow", () => appData.defs("flow", { includeArchived: true }), { on: DEF_TRIGGERS })
  const roles = useLiveQuery("library:role", () => appData.defs("role", { includeArchived: true }), { on: DEF_TRIGGERS })
  const profiles = useLiveQuery("library:profile", () => appData.defs("profile", { includeArchived: true }), { on: DEF_TRIGGERS })
  const queries = { flow: flows, role: roles, profile: profiles }
  const reloadAll = () => {
    flows.reload()
    roles.reload()
    profiles.reload()
  }

  const query = queries[tab]
  const defs = useMemo<DefRecord[]>(() => query.data ?? [], [query.data])
  const all = useMemo(() => libraryRows(tab, defs, flows.data ?? [], projects).toSorted(byName), [tab, defs, flows.data, projects])
  const archivedCount = all.filter((r) => r.def.archivedAt !== null).length
  const rows = showArchived ? all : all.filter((r) => r.def.archivedAt === null)
  const choosable = rows.filter((r) => !r.internal)
  const internal = rows.filter((r) => r.internal)
  const current = rows.find((r) => r.def.id === selectedId) ?? choosable[0] ?? internal[0] ?? null
  const internalOpen = showInternal || (current?.internal ?? false)

  const open = (def?: DefRecord) => {
    reloadAll()
    if (def) setSelectedId(def.id)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn("flex flex-none flex-wrap items-center gap-3 border-b px-4 py-2", editingFlow && "hidden")}>
        <Tabs value={tab} onValueChange={(v) => (setTab(v as DefWriteKind), setSelectedId(null))} className="gap-0">
          <TabsList>
            {KINDS.map((kind) => (
              <TabsTrigger key={kind} value={kind}>
                {KIND_LABEL[kind].plural} <span className="text-xs tabular-nums opacity-70">{queries[kind].data?.filter((d) => d.archivedAt === null).length ?? ""}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <p className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground" title={INTRO[tab]}>
          {INTRO[tab]}
        </p>
        {tab === "profile" && profiles.data ? (
          <Button size="sm" variant="secondary" onClick={() => setCreatingProfile(true)}>
            <Plus /> Nuevo perfil
          </Button>
        ) : null}
        {archivedCount > 0 || showArchived ? (
          <div className="flex items-center gap-2">
            <Checkbox id="show-archived" checked={showArchived} onCheckedChange={(v) => setShowArchived(v === true)} />
            <Label htmlFor="show-archived" className="text-[13px] font-normal">
              Mostrar archivados ({archivedCount})
            </Label>
          </div>
        ) : null}
      </div>

      {query.error && !query.data ? (
        <Message>
          <p>No pude leer {KIND_LABEL[tab].plural.toLowerCase()}: {query.error}</p>
          <Button size="sm" variant="secondary" onClick={query.reload}>
            Reintentar
          </Button>
        </Message>
      ) : !query.data ? (
        <Message>Cargando…</Message>
      ) : defs.length === 0 ? (
        <Message>{NOTHING_YET[tab]}</Message>
      ) : (
        <div className={cn("grid min-h-0 flex-1", editingFlow ? "grid-cols-[minmax(0,1fr)]" : "grid-cols-[minmax(340px,480px)_minmax(0,1fr)]")}>
          <div className={cn("min-h-0 overflow-y-auto border-r", editingFlow && "hidden")}>
            {rows.length === 0 ? <p className="px-4 py-6 text-[13px] text-muted-foreground">No hay nada que mostrar con los archivados ocultos.</p> : null}
            <ul aria-label={KIND_LABEL[tab].plural} className="divide-y">
              {choosable.map((row) => (
                <Row key={row.def.id} row={row} kind={tab} active={row.def.id === current?.def.id} onSelect={() => setSelectedId(row.def.id)} />
              ))}
            </ul>
            {internal.length > 0 ? (
              <div className="border-t">
                <button
                  type="button"
                  aria-expanded={internalOpen}
                  onClick={() => setShowInternal(!internalOpen)}
                  className="flex w-full items-center gap-2 bg-muted/40 px-4 py-2 text-left text-[13px] font-medium hover:bg-muted/60"
                >
                  <ChevronRight className={cn("size-3.5 transition-transform", internalOpen && "rotate-90")} />
                  Internos
                  <span className="text-xs font-normal text-muted-foreground tabular-nums">{internal.length}</span>
                </button>
                {internalOpen ? (
                  <>
                    <p className="px-4 pt-2 pb-1 text-xs text-pretty text-muted-foreground">Los lanza el sistema por dentro (feedback de PR, rebase, mantenimiento). Se muestran para que los veas, pero no se eligen como flujo de un proyecto.</p>
                    <ul aria-label="Flujos internos" className="divide-y">
                      {internal.map((row) => (
                        <Row key={row.def.id} row={row} kind={tab} active={row.def.id === current?.def.id} onSelect={() => setSelectedId(row.def.id)} />
                      ))}
                    </ul>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="min-h-0 min-w-0">
            {current ? (
              <DefDetail key={current.def.id} row={current} defs={defs} onChanged={open} onFocusChange={setEditingFlow} />
            ) : (
              <p className="px-6 py-6 text-[13px] text-muted-foreground">Elige un {KIND_LABEL[tab].singular} de la lista para ver su contenido y sus versiones.</p>
            )}
          </div>
        </div>
      )}
      {creatingProfile ? <NewProfileDialog profiles={profiles.data ?? []} onCreated={(created) => (setTab("profile"), open(created))} onClose={() => setCreatingProfile(false)} /> : null}
    </div>
  )
}

function Message({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col items-start gap-3 px-6 pt-5 text-[13px] text-muted-foreground">{children}</div>
}

function Row({ row, kind, active, onSelect }: { row: LibraryRow; kind: DefWriteKind; active: boolean; onSelect: () => void }) {
  const { def } = row
  return (
    <li>
      <button
        type="button"
        aria-pressed={active}
        onClick={onSelect}
        className={cn("flex w-full flex-col gap-1 px-4 py-2.5 text-left hover:bg-accent", active && "bg-accent", def.archivedAt !== null && "opacity-70")}
      >
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-[13px] font-medium">{nameOf(def)}</span>
          <span className="flex-none text-xs text-muted-foreground tabular-nums">v{def.currentVersion}</span>
        </span>
        <span className="truncate font-mono text-xs text-muted-foreground">{def.slug}</span>
        <span className="flex flex-wrap items-center gap-1.5">
          <RowPills row={row} />
        </span>
        <span className="truncate text-xs">
          <span className="text-muted-foreground">Se usa en: </span>
          <UsedBy projects={row.projects} internal={kind === "flow" && row.internal} />
        </span>
      </button>
    </li>
  )
}
