import type { LocalPrCommit, PrDetail } from "@clanker/api"
import { Check, Columns2, ExternalLink, FileCode2, GitCommitHorizontal, Rows2, ScrollText } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useAppData } from "@/app-data"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useLive, useLiveQuery } from "@/hooks/use-live"
import { ago } from "@/lib/format"
import { isTypingTarget } from "@/lib/keys"
import { readPref, writePref } from "@/lib/prefs"
import { type DiffFile, type DiffLine, fileFingerprint, parsePatch, splitRows } from "@/lib/prs/diff"
import { highlightLine, languageOf } from "@/lib/prs/highlight"
import { baseOf, branchOf, type OpenPr, titleOf } from "@/lib/prs/prs"
import { reviewStatus } from "@/lib/prs/pr-status"
import { cn } from "@/lib/utils"
import { CiBadge, LocalChip, MergePill, PrStateIcon, ReviewPill } from "./pr-bits"
import { usePrCommands } from "./pr-commands"
import { PR_KEYS, PrContextMenu, usePrShortcuts } from "./pr-menu"
import { PlainMarkdown } from "./plain-markdown"

/** Líneas que se dibujan de un archivo antes de pedir "Mostrar todo": un diff de miles de líneas congela la vista. */
const LINES_PER_FILE = 400

export type DiffMode = "unified" | "split"
export type PrTab = "description" | "commits" | "files"

/** Los atajos de la vista; la paleta los muestra igual. */
export const PR_VIEW_KEYS = { mode: "S", prev: "[", next: "]", all: "A" } as const

/** Lo que la paleta puede pedirle a la vista abierta. */
export interface PrControls {
  reload: () => void
  mode: DiffMode
  toggleMode: () => void
  /** `null` cuando no hay commit anterior o siguiente. */
  prevCommit: (() => void) | null
  nextCommit: (() => void) | null
  /** `null` si ya se ven todos los commits. */
  allCommits: (() => void) | null
}

const MODE_PREF = "localPr.diffMode"
const viewedPref = (id: string) => `localPr.viewed.${id}`
const viewedCommitsPref = (id: string) => `localPr.viewedCommits.${id}`

/** Un conjunto que vive en las preferencias de esta máquina. */
function usePrefSet(key: string) {
  const [set, setSet] = useState(() => new Set(readPref<string[]>(key, [])))
  useEffect(() => setSet(new Set(readPref<string[]>(key, []))), [key])
  const toggle = useCallback(
    (item: string, on: boolean) =>
      setSet((prev) => {
        const next = new Set(prev)
        if (on) next.add(item)
        else next.delete(item)
        writePref(key, [...next])
        return next
      }),
    [key],
  )
  return [set, toggle] as const
}

export function PrView({ pr, onBack, onControls }: { pr: OpenPr; onBack: () => void; onControls?: (controls: PrControls | null) => void }) {
  const appData = useAppData()
  const commands = usePrCommands()
  usePrShortcuts()
  const { select } = commands
  useEffect(() => select(pr.id), [pr.id, select])
  const query = useLiveQuery(`pr:${pr.id}`, () => appData.prDetail(pr.id), { live: false })
  const { subscribe } = useLive()
  const { reload } = query
  useEffect(() => subscribe((event) => {
    if (event.type === "pr.changed" && event.subject?.type === "pr" && event.subject.id === pr.id) reload()
  }), [subscribe, pr.id, reload])
  const detail = query.data
  const [tab, setTab] = useState<PrTab>("description")
  const [scope, setScope] = useState<string>("all")
  const [mode, setModeState] = useState<DiffMode>(() => (readPref<string>(MODE_PREF, "unified") === "split" ? "split" : "unified"))
  const setMode = useCallback((m: DiffMode) => {
    setModeState(m)
    writePref(MODE_PREF, m)
  }, [])
  const [viewedFiles, toggleFile] = usePrefSet(viewedPref(pr.id))
  const [viewedCommits, toggleCommit] = usePrefSet(viewedCommitsPref(pr.id))

  const commits = useMemo(() => detail?.commits ?? [], [detail])
  // Un commit que ya no es del PR (se restackeó y cambió su sha) vuelve a "todos".
  const current = scope === "all" ? undefined : commits.find((c) => c.sha === scope)
  const at = current ? commits.indexOf(current) : -1
  const showCommit = useCallback(
    (sha: string | "all") => {
      setScope(sha)
      setTab("files")
    },
    [],
  )
  // Desde "todos", [ va al último commit y ] al primero.
  const { prev, next, all } = useMemo(() => {
    const go = (i: number) => () => showCommit(commits[i]!.sha)
    if (commits.length === 0) return { prev: null, next: null, all: null }
    if (at === -1) return { prev: go(commits.length - 1), next: go(0), all: null }
    return { prev: at > 0 ? go(at - 1) : null, next: at < commits.length - 1 ? go(at + 1) : null, all: () => showCommit("all") }
  }, [commits, at, showCommit])
  const toggleMode = useCallback(() => setMode(mode === "split" ? "unified" : "split"), [mode, setMode])

  // Un objeto nuevo solo cuando algo cambia: el padre los guarda en su estado, y uno nuevo en cada render sería un loop.
  const controls = useMemo<PrControls>(() => ({ reload, mode, toggleMode, prevCommit: prev, nextCommit: next, allCommits: all }), [reload, mode, toggleMode, prev, next, all])
  useEffect(() => {
    onControls?.(controls)
  }, [controls, onControls])
  useEffect(() => () => onControls?.(null), [onControls])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
      if (isTypingTarget(e.target, ["[role='dialog']", "[role='alertdialog']", "[role='menu']", "[role='listbox']"])) return
      if (e.key === "Escape") onBack()
      else if (e.key.toUpperCase() === PR_VIEW_KEYS.mode) toggleMode()
      else if (e.key === PR_VIEW_KEYS.prev && prev) prev()
      else if (e.key === PR_VIEW_KEYS.next && next) next()
      else if (e.key.toUpperCase() === PR_VIEW_KEYS.all && all) all()
      else return
      e.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onBack, toggleMode, prev, next, all])

  const additions = detail?.files.reduce((sum, f) => sum + (f.additions ?? 0), 0) ?? 0
  const deletions = detail?.files.reduce((sum, f) => sum + (f.deletions ?? 0), 0) ?? 0

  return (
    <div className="flex h-full flex-col">
      <PrContextMenu pr={pr}>
        <header className="flex flex-col gap-2 border-b px-6 pt-5 pb-4">
          <div className="flex items-center gap-2">
            {pr.local ? <LocalChip base={pr.local.base} /> : <PrStateIcon pr={pr} />}
            <h1 className="truncate text-lg font-semibold">{detail?.title ?? titleOf(pr)}</h1>
            {!pr.local ? (
              <Button variant="outline" size="sm" className="ml-auto flex-none" onClick={() => commands.openGithub(pr)} title={`Abrir en GitHub (${PR_KEYS.openGithub})`}>
                <ExternalLink /> Abrir en GitHub
              </Button>
            ) : null}
          </div>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[12px] text-muted-foreground">
            <span>{detail?.base ?? baseOf(pr)}</span>
            <span aria-hidden>←</span>
            <span className="text-foreground">{detail?.branch ?? branchOf(pr)}</span>
            {detail ? (
              <>
                <span aria-hidden>·</span>
                <span>{detail.head.slice(0, 9)}</span>
                <span aria-hidden>·</span>
                <span className="text-viz-3">+{additions}</span>
                <span className="text-destructive">−{deletions}</span>
              </>
            ) : null}
          </p>
          {!pr.local ? (
            <div className="flex flex-wrap items-center gap-2">
              <CiBadge ci={pr.state.ci} />
              <ReviewPill pr={pr} review={reviewStatus(pr)} />
              <MergePill pr={pr} />
            </div>
          ) : null}
        </header>
      </PrContextMenu>

      {query.error ? (
        <div role="alert" className="flex items-center gap-3 px-6 py-5">
          <p className="text-sm text-destructive">{query.error}</p>
          <Button variant="outline" size="sm" onClick={query.reload} title="Reintentar (⌘R)">Reintentar</Button>
        </div>
      ) : null}
      {!detail && query.error ? null : !detail ? (
        <div className="flex flex-col gap-3 px-6 py-5">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <Tabs value={tab} onValueChange={(v) => setTab(v as PrTab)} className="min-h-0 flex-1 gap-0">
          <TabsList className="mx-6 mt-3">
            <TabsTrigger value="description">
              <ScrollText /> Descripción
            </TabsTrigger>
            <TabsTrigger value="commits">
              <GitCommitHorizontal /> Commits {detail.commits.length}
            </TabsTrigger>
            <TabsTrigger value="files">
              <FileCode2 /> Archivos {detail.files.length}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="description" className="min-h-0 overflow-y-auto px-6 py-4">
            {detail.body.trim() ? (
              <div className="max-w-3xl">
                <PlainMarkdown source={detail.body} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{pr.local ? "El PR no tiene descripción: se publicará con el título solo." : "El PR no tiene descripción. Puedes agregarla en GitHub."}</p>
            )}
          </TabsContent>
          <TabsContent value="commits" className="min-h-0 overflow-y-auto px-6 py-4">
            <Commits detail={detail} viewed={viewedCommits} onViewed={toggleCommit} onOpen={showCommit} />
          </TabsContent>
          <TabsContent value="files" className="flex min-h-0 flex-col">
            <Files
              detail={detail}
              commit={current}
              mode={mode}
              onMode={setMode}
              onScope={showCommit}
              viewed={viewedFiles}
              onViewed={toggleFile}
              commitViewed={current ? viewedCommits.has(current.sha) : false}
              onCommitViewed={(on) => current && toggleCommit(current.sha, on)}
            />
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}

function Commits({ detail, viewed, onViewed, onOpen }: { detail: PrDetail; viewed: Set<string>; onViewed: (sha: string, on: boolean) => void; onOpen: (sha: string) => void }) {
  if (detail.commits.length === 0) return <p className="text-sm text-muted-foreground">No tiene commits propios sobre {detail.base}.</p>
  const seen = detail.commits.filter((c) => viewed.has(c.sha)).length
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        {seen} de {detail.commits.length} commits vistos. Abre uno para revisar solo lo que cambió ese commit.
      </p>
      <ol className="flex flex-col divide-y rounded-lg border">
        {detail.commits.map((c, i) => (
          <li key={c.sha} className={cn("flex items-start gap-3 px-4 py-3", viewed.has(c.sha) && "bg-muted/40")}>
            <Checkbox className="mt-0.5" checked={viewed.has(c.sha)} onCheckedChange={(on) => onViewed(c.sha, on === true)} aria-label={`Marcar ${c.sha.slice(0, 9)} como visto`} />
            <button type="button" onClick={() => onOpen(c.sha)} className="flex min-w-0 flex-1 flex-col gap-1 text-left">
              <span className="flex items-baseline justify-between gap-3">
                <span className={cn("text-sm font-medium hover:underline", viewed.has(c.sha) && "text-muted-foreground")}>
                  <span className="mr-2 text-muted-foreground">{i + 1}.</span>
                  {c.subject}
                </span>
                <span className="flex-none font-mono text-[12px] text-muted-foreground">{c.sha.slice(0, 9)}</span>
              </span>
              <span className="text-xs text-muted-foreground">
                {c.author} · {ago(c.date)}
              </span>
              {c.body ? <span className="mt-1 text-xs whitespace-pre-wrap text-muted-foreground">{c.body}</span> : null}
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}

interface FilesProps {
  detail: PrDetail
  commit: LocalPrCommit | undefined
  mode: DiffMode
  onMode: (mode: DiffMode) => void
  onScope: (sha: string) => void
  viewed: Set<string>
  onViewed: (fingerprint: string, on: boolean) => void
  commitViewed: boolean
  onCommitViewed: (on: boolean) => void
}

function Files({ detail, commit, mode, onMode, onScope, viewed, onViewed, commitViewed, onCommitViewed }: FilesProps) {
  const appData = useAppData()
  const sha = commit?.sha
  const commitQuery = useLiveQuery(`pr-commit:${detail.id}:${detail.head}:${detail.baseSha}:${sha ?? "all"}`, () => (sha ? appData.prCommitDiff({ id: detail.id, sha, head: detail.head, base: detail.baseSha }) : Promise.resolve(null)), { live: false })
  const source = sha ? commitQuery.data : detail
  const files = useMemo(() => (source ? parsePatch(source.patch) : []), [source])
  const seen = files.filter((f) => viewed.has(fileFingerprint(f))).length
  const at = commit ? detail.commits.indexOf(commit) : -1

  return (
    <>
      {/* La barra queda fija arriba y solo la lista de archivos hace scroll: el código nunca pasa por detrás de ella. */}
      <div data-testid="local-pr-files-toolbar" className="flex flex-none flex-wrap items-center gap-2 border-b px-6 pt-4 pb-3">
        <Select value={sha ?? "all"} onValueChange={(v) => onScope(v)}>
          <SelectTrigger size="sm" className="w-[min(520px,60vw)]" aria-label="Qué commits ver">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los commits ({detail.commits.length})</SelectItem>
            {detail.commits.map((c, i) => (
              <SelectItem key={c.sha} value={c.sha}>
                <span className="font-mono text-[12px] text-muted-foreground">
                  {i + 1}. {c.sha.slice(0, 7)}
                </span>{" "}
                {c.subject}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {commit ? (
          <>
            <Button variant="ghost" size="sm" disabled={at <= 0} onClick={() => onScope(detail.commits[at - 1]!.sha)} title={`Commit anterior (${PR_VIEW_KEYS.prev})`}>
              Anterior
            </Button>
            <Button variant="ghost" size="sm" disabled={at >= detail.commits.length - 1} onClick={() => onScope(detail.commits[at + 1]!.sha)} title={`Commit siguiente (${PR_VIEW_KEYS.next})`}>
              Siguiente
            </Button>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox checked={commitViewed} onCheckedChange={(on) => onCommitViewed(on === true)} /> Commit visto
            </label>
          </>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground">
          {seen} de {files.length} archivos vistos
        </span>
        <ToggleGroup type="single" size="sm" variant="outline" value={mode} onValueChange={(v) => v && onMode(v as DiffMode)} aria-label={`Modo del diff (${PR_VIEW_KEYS.mode})`}>
          <ToggleGroupItem value="unified" aria-label="Unificado" title={`Unificado (${PR_VIEW_KEYS.mode})`}>
            <Rows2 />
          </ToggleGroupItem>
          <ToggleGroupItem value="split" aria-label="Lado a lado" title={`Lado a lado (${PR_VIEW_KEYS.mode})`}>
            <Columns2 />
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {/* En bloque, no flex: en una columna flex los archivos (con overflow-hidden) se encogerían en vez de hacer scroll. */}
      <div data-testid="local-pr-files" className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-4">
      {commit?.body ? <p className="text-xs whitespace-pre-wrap text-muted-foreground">{commit.body}</p> : null}
      {source?.truncated ? (
        <p className="text-xs text-muted-foreground">El diff es muy grande y se muestra cortado: míralo completo con git diff {detail.baseSha}...{detail.head}.</p>
      ) : null}
      {sha && commitQuery.error ? (
        <div role="alert" className="flex items-center gap-3">
          <p className="text-sm text-destructive">{commitQuery.error}</p>
          <Button variant="outline" size="sm" onClick={commitQuery.reload}>Reintentar</Button>
        </div>
      ) : null}
      {sha && !commitQuery.data && !commitQuery.error ? <Skeleton className="h-40 w-full" /> : null}
      {source && files.length === 0 ? (
        <p className="text-sm text-muted-foreground">{commit ? "Este commit no cambia ningún archivo." : `El PR no cambia ningún archivo respecto de ${detail.base}.`}</p>
      ) : null}
      {files.map((file) => {
        const print = fileFingerprint(file)
        return <FileDiff key={`${sha ?? "all"}:${file.path}`} file={file} mode={mode} viewed={viewed.has(print)} onViewed={(on) => onViewed(print, on)} />
      })}
      </div>
    </>
  )
}

const LINE_TONE: Record<DiffLine["kind"], string> = {
  add: "bg-viz-3/10",
  del: "bg-destructive/10",
  hunk: "bg-muted text-muted-foreground",
  ctx: "",
  note: "text-muted-foreground italic",
}

/** El texto de una línea con el color de su lenguaje (el HTML lo arma highlight.js, que escapa el texto). */
function Code({ line, language }: { line: DiffLine; language: string | undefined }) {
  const html = line.kind === "add" || line.kind === "del" || line.kind === "ctx" ? highlightLine(line.text, language) : undefined
  return html === undefined ? <>{line.text}</> : <span dangerouslySetInnerHTML={{ __html: html }} />
}

const sign = (line: DiffLine | undefined) => (line?.kind === "add" ? "+" : line?.kind === "del" ? "−" : "")

function FileDiff({ file, mode, viewed, onViewed }: { file: DiffFile; mode: DiffMode; viewed: boolean; onViewed: (on: boolean) => void }) {
  const [all, setAll] = useState(false)
  // Un archivo visto queda plegado, como en GitHub; se puede abrir sin desmarcarlo.
  const [open, setOpen] = useState(!viewed)
  useEffect(() => setOpen(!viewed), [viewed])
  const language = useMemo(() => languageOf(file.path), [file.path])
  const lines = all ? file.lines : file.lines.slice(0, LINES_PER_FILE)
  const rows = useMemo(() => (mode === "split" ? splitRows(lines) : []), [mode, lines])
  const status = { added: "nuevo", deleted: "borrado", binary: "binario", modified: null }[file.status]
  return (
    <section className={cn("overflow-hidden rounded-lg border", viewed && "opacity-80")} aria-label={file.path}>
      <header className="flex items-center gap-2 border-b bg-muted/50 px-3 py-2 font-mono text-[12px]">
        <button type="button" onClick={() => setOpen((o) => !o)} className="truncate text-left hover:underline" aria-expanded={open}>
          {file.path}
        </button>
        {status ? <span className="rounded bg-muted px-1.5 text-muted-foreground">{status}</span> : null}
        <span className="ml-auto flex-none text-viz-3">+{file.additions}</span>
        <span className="flex-none text-destructive">−{file.deletions}</span>
        <label className="ml-2 flex flex-none items-center gap-1.5 font-sans text-xs text-muted-foreground">
          <Checkbox checked={viewed} onCheckedChange={(on) => onViewed(on === true)} aria-label={`Marcar ${file.path} como visto`} />
          {viewed ? <Check className="size-3.5" /> : null} Visto
        </label>
      </header>
      {!open ? null : file.status === "binary" ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">Archivo binario: no se muestra el cambio.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className={cn("w-full border-collapse font-mono text-[12px] leading-5", mode === "split" && "table-fixed")}>
            {mode === "split" ? (
              // Los dos lados siempre a la mitad, en todos los archivos.
              <colgroup>
                <col className="w-12" />
                <col className="w-4" />
                <col />
                <col className="w-12" />
                <col className="w-4" />
                <col />
              </colgroup>
            ) : null}
            <tbody>
              {mode === "unified"
                ? lines.map((line, i) => (
                    <tr key={i} data-kind={line.kind} className={LINE_TONE[line.kind]}>
                      <td className="w-12 select-none px-2 text-right text-muted-foreground/70">{line.old ?? ""}</td>
                      <td className="w-12 select-none px-2 text-right text-muted-foreground/70">{line.new ?? ""}</td>
                      <td className="w-4 select-none text-center text-muted-foreground">{sign(line)}</td>
                      <td className="pr-3 whitespace-pre">
                        <Code line={line} language={language} />
                      </td>
                    </tr>
                  ))
                : rows.map((row, i) =>
                    row.kind === "full" ? (
                      <tr key={i} data-kind={row.line.kind} className={LINE_TONE[row.line.kind]}>
                        <td colSpan={6} className="px-3 whitespace-pre">
                          {row.line.text}
                        </td>
                      </tr>
                    ) : (
                      <tr key={i} data-kind="pair">
                        {([row.left, row.right] as const).map((line, side) => (
                          <SplitCell key={side} line={line} side={side === 0 ? "old" : "new"} language={language} />
                        ))}
                      </tr>
                    ),
                  )}
            </tbody>
          </table>
          {!all && file.lines.length > LINES_PER_FILE ? (
            <div className="border-t px-3 py-2">
              <Button variant="ghost" size="sm" onClick={() => setAll(true)}>
                Mostrar las {file.lines.length - LINES_PER_FILE} líneas que faltan
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}

/** Medio renglón del lado a lado: número, signo y código; sin línea de ese lado, una celda vacía. */
function SplitCell({ line, side, language }: { line: DiffLine | undefined; side: "old" | "new"; language: string | undefined }) {
  const tone = line ? LINE_TONE[line.kind] : "bg-muted/40"
  return (
    <>
      <td data-side={side} data-kind={line?.kind ?? "empty"} className={cn("select-none px-2 text-right align-top text-muted-foreground/70", tone, side === "new" && "border-l")}>
        {line ? (side === "old" ? line.old : line.new) : ""}
      </td>
      <td className={cn("select-none text-center align-top text-muted-foreground", tone)}>{sign(line)}</td>
      <td className={cn("pr-3 break-words whitespace-pre-wrap", tone)}>{line ? <Code line={line} language={language} /> : null}</td>
    </>
  )
}
