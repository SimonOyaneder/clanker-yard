import type { TrackerId, TrackerProject } from "@clanker/api"
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react"
import { useState } from "react"
import { useAppData } from "@/app-data"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Skeleton } from "@/components/ui/skeleton"
import { useLiveQuery } from "@/hooks/use-live"

/** Los trackers cuyos proyectos el core sabe listar; el resto pide el id a mano. */
export function listsProjects(tracker: TrackerId): boolean {
  return tracker === "linear"
}

interface Props {
  id: string
  tracker: TrackerId
  /** El `ref.id` del proyecto elegido, o "" si no hay. */
  value: string
  /** El proyecto elegido y la cuenta (workspace) a la que pertenece. */
  onChange: (id: string, account: string) => void
  onOpenConnections: () => void
}

// Selector con búsqueda de los proyectos del tracker (`trackers.projects`): los de la persona primero.
export function TrackerProjectPicker({ id, tracker, value, onChange, onOpenConnections }: Props) {
  const appData = useAppData()
  const [open, setOpen] = useState(false)
  const query = useLiveQuery(`tracker-projects:${tracker}`, () => appData.trackerProjects(tracker), { live: false })

  if (query.error) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 rounded-md border border-destructive/40 p-3 text-[13px]">
        <p className="text-destructive">{query.error}</p>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onOpenConnections}>
            Ir a Conexiones
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={query.reload}>
            Reintentar
          </Button>
        </div>
      </div>
    )
  }
  if (!query.data) return <Skeleton aria-label="Cargando proyectos" className="h-9 w-full" />

  const projects = query.data
  if (projects.length === 0) {
    return <p className="rounded-md border p-3 text-[13px] text-muted-foreground">Esta cuenta no tiene proyectos todavía: crea uno en el tracker y vuelve a abrir este diálogo.</p>
  }
  const selected = projects.find((p) => p.ref.id === value)
  const unknown = value !== "" && !selected
  const mine = projects.filter((p) => p.mine)
  const others = projects.filter((p) => !p.mine)
  const manyAccounts = new Set(projects.map((p) => p.account)).size > 1
  const pick = (project: TrackerProject) => {
    onChange(project.ref.id, project.account)
    setOpen(false)
  }
  const item = (project: TrackerProject) => (
    <CommandItem key={`${project.account}:${project.ref.id}`} value={`${project.name} ${project.account} ${project.ref.id}`} onSelect={() => pick(project)}>
      <span className="truncate">{project.name}</span>
      {manyAccounts ? <span className="ml-auto truncate text-xs text-muted-foreground">{project.account}</span> : null}
      <CheckIcon className={project.ref.id === value ? "opacity-100" : "opacity-0"} />
    </CommandItem>
  )

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button id={id} type="button" variant="outline" role="combobox" aria-expanded={open} className="w-full justify-between font-normal">
            <span className="truncate">{selected ? selected.name : "Elige un proyecto"}</span>
            <ChevronsUpDownIcon className="opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-(--radix-popover-trigger-width) p-0">
          <Command>
            <CommandInput placeholder="Buscar proyecto" />
            <CommandList>
              <CommandEmpty>Ningún proyecto coincide.</CommandEmpty>
              {mine.length > 0 ? <CommandGroup heading="Míos">{mine.map(item)}</CommandGroup> : null}
              {others.length > 0 ? <CommandGroup heading={mine.length > 0 ? "Todos" : undefined}>{others.map(item)}</CommandGroup> : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {unknown ? <p className="text-xs text-muted-foreground">El proyecto guardado ({value}) no está en la lista de las cuentas conectadas: elige uno.</p> : null}
    </>
  )
}
