import type { DefExported, DefRecord, DefWriteKind } from "@clanker/api"
import { ExternalLink } from "lucide-react"
import { useState } from "react"
import { useAppData } from "@/app-data"
import { ClankerDirNote } from "@/components/flows/clanker-dir-note"
import { SelectField } from "@/components/flows/select-field"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useLiveQuery } from "@/hooks/use-live"
import { useHost } from "@/host"
import { KIND_LABEL, nameOf, repoFilePath } from "@/lib/flows/defs-library"
import { messageOf } from "@/lib/utils"

interface Props {
  def: DefRecord
  kind: DefWriteKind
  onClose: () => void
}

/**
 * "Exportar al repo": elige el repo y abre un PR en draft que agrega el archivo de la def al `.clanker/` de ese repo.
 * Nada se escribe en el checkout de la persona: el core arma el PR en un worktree aparte con la cuenta de GitHub del repo.
 */
export function ExportToRepoDialog({ def, kind, onClose }: Props) {
  const appData = useAppData()
  const host = useHost()
  const repos = useLiveQuery("export-repos", () => appData.repos(), { live: false })
  const withRemote = (repos.data ?? []).filter((r) => r.repo.remote !== null)
  const [chosen, setChosen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [opened, setOpened] = useState<DefExported | null>(null)
  const repo = (withRemote.find((r) => r.repo.id === chosen) ?? withRemote[0])?.repo
  const path = repoFilePath(kind, def.slug)

  const exportIt = async () => {
    if (!repo) return
    setBusy(true)
    setError(null)
    try {
      setOpened(await appData.exportDefToRepo({ kind, id: def.id, repoId: repo.id }))
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Exportar {KIND_LABEL[kind].singular} al repo</DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-col gap-2">
              <ClankerDirNote />
              <p className="text-[13px] text-pretty">
                Abre un PR en draft con <span className="font-mono text-xs">{path}</span> ({nameOf(def)}). Cuando lo mergees, quien registre el repo recibe este {KIND_LABEL[kind].singular} como suyo.
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>
        {opened ? (
          <div role="status" className="flex flex-col gap-2 rounded-lg border p-3 text-[13px]">
            <p>
              Abrí el PR #{opened.number} en draft en {repo?.remote}. Revísalo y márcalo listo cuando quieras.
            </p>
            <Button size="sm" variant="secondary" className="self-start" onClick={() => host.openExternal(opened.url)}>
              <ExternalLink /> Ver el PR
            </Button>
          </div>
        ) : repos.data && withRemote.length === 0 ? (
          <p className="text-[13px] text-destructive">Ningún repo registrado tiene remoto de GitHub. Registra uno en Conexiones y conecta GitHub para abrir el PR.</p>
        ) : (
          <div className="flex flex-col gap-1">
            <span className="text-[13px] font-medium">Repo</span>
            <SelectField label="Repo" value={repo?.id ?? ""} options={withRemote.map((r) => ({ value: r.repo.id, label: `${r.repo.name} (${r.repo.remote})` }))} onChange={setChosen} />
          </div>
        )}
        {error ? (
          <p role="alert" className="text-[13px] text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {opened ? "Cerrar" : "Cancelar"}
          </Button>
          {opened ? null : (
            <Button onClick={() => void exportIt()} disabled={busy || !repo}>
              {busy ? "Abriendo el PR…" : "Abrir PR en draft"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
