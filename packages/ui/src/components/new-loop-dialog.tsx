import { useEffect, useMemo, useState } from "react"
import type { AppConfig, LoopMode } from "@/types"
import { useAppData } from "@/app-data"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { reportLaunch } from "@/lib/launch"

const DEFAULT_PROFILE = "__default"
const DEFAULT = "__default"

const MODES: { value: LoopMode; label: string }[] = [
  { value: "run", label: "Correr" },
  { value: "dry-run", label: "Dry run (solo la cola)" },
  { value: "watch", label: "Solo vigilar PRs" },
]

// Controlado desde App: lo abren ⌘N, la paleta y el botón de la sidebar.
export function NewLoopDialog({ open, onOpenChange: setOpen }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const appData = useAppData()
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [project, setProject] = useState("")
  const [cwd, setCwd] = useState("")
  const [parallel, setParallel] = useState("1")
  const [profile, setProfile] = useState(DEFAULT_PROFILE)
  const [only, setOnly] = useState("")
  const [mode, setMode] = useState<LoopMode>("run")
  const [model, setModel] = useState(DEFAULT)
  const [effort, setEffort] = useState(DEFAULT)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    if (!open || config) return
    void appData.config().then((r) => {
      if (!r.ok) return
      setConfig(r.data)
      const preferred = r.data.repos.find((x) => x.name === "api" && x.trusted) ?? r.data.repos.find((x) => x.trusted)
      if (preferred) setCwd(preferred.path)
    })
  }, [open, config, appData])

  const command = useMemo(() => {
    const parts = ["/clanker-loop", project.trim() || "<proyecto>"]
    if (Number(parallel) > 1) parts.push("--parallel", parallel)
    if (profile !== DEFAULT_PROFILE) parts.push("--profile", profile)
    if (only.trim()) parts.push("--only", only.trim())
    if (mode === "dry-run") parts.push("--dry-run")
    if (mode === "watch") parts.push("--watch")
    const slug = (/linear\.app\/[^/]+\/project\/([\w-]+)/.exec(project.trim())?.[1] ?? project.trim()).replace(/-[0-9a-f]{12}$/, "") || "<proyecto>"
    const flags = [
      `--remote-control "clanker · ${slug}"`,
      "--dangerously-skip-permissions",
      model !== DEFAULT ? `--model ${model}` : "",
      effort !== DEFAULT ? `--effort ${effort}` : "",
    ]
      .filter(Boolean)
      .join(" ")
    return `claude --bg ${flags ? `${flags} ` : ""}"${parts.join(" ")}"`
  }, [project, parallel, profile, only, mode, model, effort])

  const submit = async () => {
    setSending(true)
    const ok = await reportLaunch(
      appData.newLoop({
        project: project.trim(),
        cwd,
        parallel: Number(parallel),
        profile: profile === DEFAULT_PROFILE ? null : profile,
        only: only.trim() || null,
        mode,
        model: model === DEFAULT ? null : model,
        effort: effort === DEFAULT ? null : effort,
      }),
      "Loop lanzado",
    )
    setSending(false)
    if (ok) {
      setOpen(false)
      setProject("")
      setOnly("")
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Nuevo loop</DialogTitle>
          <DialogDescription>
            Lanza /clanker-loop en una sesión de Claude Code en background, con Remote Control para seguirlo desde el teléfono o claude.ai. Sigue
            corriendo aunque cierres la app.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="nl-project">Proyecto de Linear</Label>
            <Input
              id="nl-project"
              placeholder="https://linear.app/acme/project/…"
              value={project}
              onChange={(e) => setProject(e.target.value)}
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>Carpeta del EM</Label>
              <Select value={cwd} onValueChange={setCwd}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Elige una carpeta" />
                </SelectTrigger>
                <SelectContent>
                  {config?.repos.map((r) => (
                    <SelectItem key={r.path} value={r.path} disabled={!r.trusted}>
                      {r.name}
                      {r.trusted ? "" : " · sin trust"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Modo</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as LoopMode)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODES.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Slots en paralelo</Label>
              <Select value={parallel} onValueChange={setParallel}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["1", "2", "3", "4", "5"].map((n) => (
                    <SelectItem key={n} value={n}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Perfil</Label>
              <Select value={profile} onValueChange={setProfile}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_PROFILE}>default{config?.defaultProfile ? ` (${config.defaultProfile})` : ""}</SelectItem>
                  {config?.profiles.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>Modelo del EM</Label>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT}>default{config?.defaultModel ? ` (${config.defaultModel})` : ""}</SelectItem>
                  {config?.models.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Effort del EM</Label>
              <Select value={effort} onValueChange={setEffort}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT}>default{config?.defaultEffort ? ` (${config.defaultEffort})` : ""}</SelectItem>
                  {config?.efforts.map((e) => (
                    <SelectItem key={e} value={e}>
                      {e}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">
            Solo para la sesión del EM. Los techleads y sus equipos usan el perfil de arriba.
          </p>

          <p className="rounded-md border bg-inset px-3 py-2.5 text-xs text-muted-foreground">
            Corre sin pedir permisos (--dangerously-skip-permissions), igual que "Correr loop" y "Reanudar". Los hooks del clanker-loop siguen bloqueando lo que
            no pase por su CLI.
          </p>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="nl-only">Solo una issue (opcional)</Label>
            <Input id="nl-only" placeholder="ENG-1234" value={only} onChange={(e) => setOnly(e.target.value.toUpperCase())} />
          </div>

          <code className="rounded-md border bg-inset px-3 py-2 font-mono text-[11.5px] break-all text-foreground/80 select-text">{command}</code>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={sending || !project.trim() || !cwd}>
              {sending ? "Lanzando…" : "Lanzar en background"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
