import type { DefRecord, Lanes, PackInfo, Repo } from "@clanker/api"
import { Copy, Ellipsis, FolderOpen, TriangleAlert } from "lucide-react"
import { type FormEvent, useState } from "react"
import { toast } from "sonner"
import { useAppData } from "@/app-data"
import { DefSelect } from "@/components/def-option"
import { Hint, Pill } from "@/components/common"
import { LaneStepper } from "@/components/project/lanes-control"
import { Field, Section } from "@/components/settings/settings-fields"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { useHost } from "@/host"
import { type DefaultsDraft, orgsWithoutPack } from "@/lib/app-settings"
import { copy } from "@/lib/clipboard"
import { defaultFlowSlug, defaultProfileSlug, defName, selectableFlows } from "@/lib/defs"
import { tone } from "@/lib/format"
import type { FieldProblems } from "@/lib/project-settings"
import { messageOf } from "@/lib/utils"

// Radix Select no admite un valor vacío en un ítem: "sin valor" se representa con un valor propio.

// ───────────────────────── Carriles

export function LanesSection({ lanes }: { lanes: Lanes }) {
  return (
    <Section
      id="lanes"
      title="Carriles"
      description="Cuántas corridas puede hacer la app a la vez en esta máquina: las de trabajo sobre issues (dev) y las de mantenimiento, como rebasear un PR. Rige al instante y nunca corta lo que ya corre."
    >
      <div className="flex max-w-md flex-col gap-4">
        {(["dev", "maintenance"] as const).map((lane) => (
          <LaneStepper key={lane} lane={lane} usage={lanes[lane]} />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">Cada proyecto además tiene su propio tope de corridas a la vez, que se cambia en sus Ajustes.</p>
    </Section>
  )
}

// ───────────────────────── Packs

const ORIGIN = {
  factory: { label: "Incluido", tone: tone.neutral, hint: "Viene con la app. Para actualizarlo, instala una versión más nueva desde una carpeta." },
  installed: { label: "Instalado", tone: tone.sky, hint: "Lo instalaste desde una carpeta. Se puede actualizar o quitar." },
} as const satisfies Record<PackInfo["origin"], { label: string; tone: string; hint: string }>

function scopeOf(pack: PackInfo): string[] {
  const { githubOrgs = [], trackerWorkspaces = [], projects = [] } = pack.activate
  return [
    ...githubOrgs.map((org) => `GitHub: ${org}`),
    ...trackerWorkspaces.map((workspace) => `Tracker: ${workspace}`),
    ...(projects.length ? [`${projects.length} ${projects.length === 1 ? "proyecto" : "proyectos"}`] : []),
  ]
}

export function PacksSection({ packs, repos, onChanged }: { packs: PackInfo[]; repos: Repo[]; onChanged: () => void }) {
  const appData = useAppData()
  const host = useHost()
  const [busy, setBusy] = useState(false)
  // Lo que falló al instalar: el mensaje del core dice qué archivo y qué campo del pack arreglar.
  const [error, setError] = useState<string | null>(null)
  const [typing, setTyping] = useState(!host.pickDirectory)
  const [path, setPath] = useState("")
  const [removing, setRemoving] = useState<PackInfo | null>(null)
  const uncovered = orgsWithoutPack(repos, packs)

  const install = async (folder: string) => {
    setBusy(true)
    setError(null)
    try {
      const pack = await appData.installPack(folder.trim())
      toast.success(`${pack.id} v${pack.version} instalado: rige desde ya`)
      setPath("")
      onChanged()
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }
  const pick = async () => {
    const folder = await host.pickDirectory?.()
    if (folder) await install(folder)
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (path.trim()) void install(path)
  }
  const remove = async (pack: PackInfo) => {
    try {
      await appData.removePack(pack.id)
      toast(`${pack.id} quitado`)
      onChanged()
    } catch (e) {
      toast.error(messageOf(e))
    }
  }

  return (
    <Section
      id="packs"
      title="Packs"
      description="Un pack son las reglas y convenciones de tu organización: bot de review, CI, estilo de PRs. Rige solo en los repos y workspaces que cubre; el resto usa reglas neutras."
    >
      {packs.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-4 text-[13px] text-muted-foreground">No hay packs instalados: todos los repos usan reglas neutras.</p>
      ) : (
        <ul className="overflow-hidden rounded-lg border">
          {packs.map((pack) => (
            <li key={pack.id} className="flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{pack.id}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">v{pack.version}</span>
                  <Pill className={ORIGIN[pack.origin].tone} hint={ORIGIN[pack.origin].hint}>
                    {ORIGIN[pack.origin].label}
                  </Pill>
                </div>
                <div className="flex flex-wrap gap-1">
                  {scopeOf(pack).map((chip) => (
                    <span key={chip} className="inline-flex h-5 items-center rounded bg-muted px-1.5 text-xs">
                      {chip}
                    </span>
                  ))}
                </div>
              </div>
              <DropdownMenu>
                <Hint label={`Acciones de ${pack.id}`}>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon-sm" variant="ghost" aria-label={`Acciones de ${pack.id}`}>
                      <Ellipsis />
                    </Button>
                  </DropdownMenuTrigger>
                </Hint>
                <DropdownMenuContent align="end" className="w-60">
                  {host.pickDirectory ? (
                    <DropdownMenuItem onSelect={() => void pick()}>
                      <FolderOpen /> Actualizar desde una carpeta
                    </DropdownMenuItem>
                  ) : null}
                  {pack.origin === "installed" ? (
                    <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(pack)}>
                      Quitar
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
      )}

      {uncovered.map(({ org, repos: names }) => (
        <p key={org} role="status" className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-900 dark:text-amber-200">
          <TriangleAlert className="mt-0.5 size-4 flex-none" />
          <span>
            {names.length === 1 ? "El repo" : "Los repos"} {names.join(", ")} de la org <strong className="font-medium">{org}</strong> no {names.length === 1 ? "tiene" : "tienen"} un pack: sin bot de review ni reglas de CI propias. Si tu organización tiene uno, instálalo desde una carpeta.
          </span>
        </p>
      ))}

      <div className="flex flex-col gap-2">
        {typing ? (
          <form onSubmit={submit} className="flex items-center gap-2">
            <Input aria-label="Carpeta del pack" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/ruta/a/la/carpeta/del/pack" className="h-8 flex-1 font-mono text-[13px]" />
            <Button type="submit" size="sm" disabled={busy || !path.trim()}>
              Instalar
            </Button>
            {host.pickDirectory ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => setTyping(false)}>
                Elegir carpeta
              </Button>
            ) : null}
          </form>
        ) : (
          <div className="flex items-center gap-3">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void pick()}>
              <FolderOpen /> Instalar desde una carpeta
            </Button>
            <Button size="xs" variant="link" onClick={() => setTyping(true)}>
              Escribir la ruta
            </Button>
          </div>
        )}
        <p className="text-xs text-muted-foreground">La carpeta tiene un archivo `pack.json`. Instalar una versión más nueva de un pack lo actualiza; el mismo pack con la misma versión no cambia nada.</p>
        {error ? (
          <p role="alert" className="text-xs whitespace-pre-wrap text-destructive">
            {error}
          </p>
        ) : null}
      </div>

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Quitar el pack {removing?.id}</AlertDialogTitle>
            <AlertDialogDescription>
              Se borra su carpeta instalada y sus flujos y roles dejan de estar disponibles. Si la app trae un pack con ese nombre, vuelve a regir ese. Las corridas en curso siguen con lo que ya tenían.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Volver</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => removing && void remove(removing)}>
              Quitar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  )
}

// ───────────────────────── Proyectos nuevos

interface DefaultsProps {
  draft: DefaultsDraft
  update: (change: Partial<DefaultsDraft>) => void
  problems: FieldProblems
  flows: DefRecord[]
  profiles: DefRecord[]
}

const describedBy = (id: string, error: string | undefined) => [`${id}-hint`, error ? `${id}-error` : null].filter(Boolean).join(" ")

export function DefaultsSection({ draft, update, problems, flows, profiles }: DefaultsProps) {
  const choosable = selectableFlows(flows, draft.defaultFlowId)
  // Sin default, Nuevo proyecto preselecciona el flujo y el perfil de siempre: el vacío se llama por lo que hace.
  const autoFlow = flows.find((f) => f.slug === defaultFlowSlug(choosable))
  const noFlow = autoFlow ? `Automático (${defName(autoFlow)})` : "Sin flujo"
  const autoProfile = defaultProfileSlug(profiles)
  const noProfile = autoProfile ? `Automático (${autoProfile})` : "Sin perfil"
  return (
    <Section
      id="defaults"
      title="Proyectos nuevos"
      description="Con qué arranca un proyecto nuevo si no eliges otra cosa al crearlo. No cambia los proyectos que ya existen."
    >
      <div className="grid gap-4 @xl:grid-cols-2">
        <Field id="new-default-flow" label="Flujo" hint="Los pasos que sigue cada issue: por ejemplo, planear, programar y abrir el PR.">
          <DefSelect id="new-default-flow" size="sm" value={draft.defaultFlowId} defs={choosable} emptyLabel={noFlow} onChange={(slug) => update({ defaultFlowId: slug })} />
        </Field>
        <Field id="new-default-profile" label="Perfil" hint="Qué modelo usan los agentes y cuánto razonan.">
          <DefSelect id="new-default-profile" size="sm" value={draft.defaultProfileId} defs={profiles} emptyLabel={noProfile} onChange={(slug) => update({ defaultProfileId: slug })} />
        </Field>
        <Field id="new-default-parallel" label="Corridas a la vez" hint="Cuántas issues del proyecto se trabajan al mismo tiempo." error={problems.parallel}>
          <Input
            id="new-default-parallel"
            value={draft.parallel}
            onChange={(e) => update({ parallel: e.target.value })}
            inputMode="numeric"
            aria-invalid={!!problems.parallel}
            aria-describedby={describedBy("new-default-parallel", problems.parallel)}
            className="h-8 w-full text-[13px]"
          />
        </Field>
        <Field id="new-default-cost" label="Tope de gasto por corrida (USD)" hint="Vacío es sin tope. Una corrida que lo pasa se detiene y te pide decidir." error={problems.maxCostUsd}>
          <Input
            id="new-default-cost"
            value={draft.maxCostUsd}
            onChange={(e) => update({ maxCostUsd: e.target.value })}
            inputMode="decimal"
            placeholder="Sin tope"
            aria-invalid={!!problems.maxCostUsd}
            aria-describedby={describedBy("new-default-cost", problems.maxCostUsd)}
            className="h-8 w-full text-[13px]"
          />
        </Field>
      </div>
    </Section>
  )
}

// ───────────────────────── Avanzado

function ReadOnly({ label, value, what, help }: { label: string; value: string; what: string; help: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-xs" title={value}>
          {value}
        </code>
        <Hint label={`Copiar ${what}`}>
          <Button size="icon-sm" variant="ghost" aria-label={`Copiar ${what}`} onClick={() => copy(value, what)}>
            <Copy />
          </Button>
        </Hint>
      </div>
      <p className="text-xs text-muted-foreground">{help}</p>
    </div>
  )
}

export function AdvancedSection({ info }: { info: { dataDir: string; linearClientId: string } }) {
  return (
    <Section id="advanced" title="Avanzado" description="Datos del core que no se editan desde acá: dónde guarda lo suyo y con qué app de Linear se conecta.">
      <div className="flex flex-col gap-4">
        <ReadOnly
          label="Carpeta de datos"
          value={info.dataDir}
          what="la carpeta de datos"
          help="Ahí viven la base, los packs instalados y config.json. La fija el sistema (o CLANKER_HOME al lanzar el core a mano); para usar otra, cierra la app y lánzala con esa variable."
        />
        <ReadOnly
          label="client_id de Linear"
          value={info.linearClientId}
          what="el client_id de Linear"
          help='Identifica a la app ante Linear al conectar tu cuenta; no es un secreto. Para usar otro, ponlo en config.json de la carpeta de datos ({ "linear": { "clientId": "..." } }) o en la variable CLANKER_LINEAR_CLIENT_ID, y reinicia la app.'
        />
      </div>
    </Section>
  )
}
