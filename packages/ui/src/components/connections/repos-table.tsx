import type { Repo } from "@clanker/api"
import { Copy, FlaskConical, FolderGit2, Loader2, Plus } from "lucide-react"
import { type FormEvent, useState } from "react"
import { toast } from "sonner"
import { useAppData, type RepoRow } from "@/app-data"
import { Ago, Hint, Pill, SectionTitle } from "@/components/common"
import { Button } from "@/components/ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useHost } from "@/host"
import { copy } from "@/lib/clipboard"
import { tone } from "@/lib/format"

const RECIPE = {
  found: { label: "encontrada", tone: tone.green, hint: "El repo tiene .clanker/recipe.json y es válida." },
  missing: { label: "falta", tone: tone.neutral, hint: "El repo no tiene .clanker/recipe.json: las corridas no saben prepararlo ni qué checks correr." },
} as const

interface Props {
  rows: RepoRow[]
  onTest: (repo: Repo) => void
  onAdded: () => void
}

// Los repos registrados con su receta (`.clanker/recipe.json`) y cómo salió su última prueba.
export function ReposTable({ rows, onTest, onAdded }: Props) {
  const host = useHost()
  const [adding, setAdding] = useState(false)

  return (
    <section aria-label="Repos" className="flex flex-col gap-2">
      <SectionTitle
        count={rows.length}
        aside={
          <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
            <Plus /> Agregar repo
          </Button>
        }
      >
        Repos y recetas
      </SectionTitle>
      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-8 text-center">
          <FolderGit2 className="size-5 text-muted-foreground" />
          <p className="max-w-sm text-[13px] text-muted-foreground">Todavía no hay repos registrados. Las corridas trabajan sobre un repo: agrega el checkout y el core lee su receta.</p>
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus /> Agregar repo
          </Button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table className="text-[13px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8 pl-4">Repo</TableHead>
                <TableHead className="h-8">Receta</TableHead>
                <TableHead className="h-8">Última prueba</TableHead>
                <TableHead className="h-8 pr-4 text-right">
                  <span className="sr-only">Acciones</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <ContextMenu key={row.repo.id}>
                  <ContextMenuTrigger asChild>
                    <TableRow className="h-12">
                      <TableCell className="pl-4">
                        <div className="flex min-w-0 flex-col">
                          <span className="font-medium">{row.repo.name}</span>
                          <span className="max-w-[420px] truncate font-mono text-[11.5px] text-muted-foreground" title={row.repo.path}>
                            {row.repo.path}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        {row.recipe.status === "invalid" ? (
                          <Pill className={tone.red} hint={`La receta no es válida: ${row.recipe.message}`}>
                            inválida
                          </Pill>
                        ) : (
                          <Pill className={RECIPE[row.recipe.status].tone} hint={RECIPE[row.recipe.status].hint}>
                            {RECIPE[row.recipe.status].label}
                          </Pill>
                        )}
                      </TableCell>
                      <TableCell>
                        {row.lastTest ? (
                          <span className="flex items-center gap-2">
                            <Pill className={row.lastTest.ok ? tone.green : tone.red} hint={row.lastTest.ok ? "La receta corrió completa." : "Un comando de la receta falló."}>
                              {row.lastTest.ok ? "ok" : "falló"}
                            </Pill>
                            <Ago at={row.lastTest.at} className="text-xs text-muted-foreground" />
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">sin pruebas</span>
                        )}
                      </TableCell>
                      <TableCell className="pr-4 text-right">
                        <Hint label={row.recipe.status === "found" ? "Corre la receta en un worktree desechable" : "Sin una receta válida no hay nada que probar"} side="left">
                          <span className="inline-flex">
                            <Button size="xs" variant="outline" disabled={row.recipe.status !== "found"} onClick={() => onTest(row.repo)}>
                              <FlaskConical /> Probar receta
                            </Button>
                          </span>
                        </Hint>
                      </TableCell>
                    </TableRow>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-52">
                    <ContextMenuItem disabled={row.recipe.status !== "found"} onSelect={() => onTest(row.repo)}>
                      <FlaskConical /> Probar receta
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => host.openInEditor(row.repo.path)}>
                      <FolderGit2 /> Abrir en el editor
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => copy(row.repo.path, "la ruta del repo")}>
                      <Copy /> Copiar ruta
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <AddRepoDialog open={adding} onOpenChange={setAdding} onAdded={onAdded} />
    </section>
  )
}

function AddRepoDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (open: boolean) => void; onAdded: () => void }) {
  const appData = useAppData()
  const [path, setPath] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const repo = await appData.addRepo(path.trim())
      setPath("")
      onOpenChange(false)
      onAdded()
      toast.success(`Registré ${repo.name}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Agregar repo</DialogTitle>
            <DialogDescription>La ruta absoluta de la raíz de un checkout de git. El nombre, la branch por defecto y el remoto de GitHub salen de él.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="repo-path">Ruta del repo</Label>
            <Input id="repo-path" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/tu-usuario/código/mi-repo" spellCheck={false} className="font-mono" aria-invalid={error !== null} />
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={!path.trim() || busy}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              Agregar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
