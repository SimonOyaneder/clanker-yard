import type { BotFinding, LocalPrCommit, PrDetail } from "@clanker/api"
import { Columns2, ExternalLink, FileCode2, GitCommitHorizontal, MessageSquareDiff, Rows2, ScrollText } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useAppData } from "@/app-data"
import { Hint } from "@/components/common"
import { ChatPanel } from "./chat-panel"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { CHAT_KEYS, type PrChatController, usePrChat } from "@/hooks/use-pr-chat"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useLive, useLiveQuery } from "@/hooks/use-live"
import { ago } from "@/lib/format"
import { isTypingTarget } from "@/lib/keys"
import { chatFocusDone, wantsChatFocus } from "@/lib/chat-focus"
import { readPref, writePref } from "@/lib/prefs"
import { fileFingerprint, parsePatch } from "@/lib/prs/diff"
import { baseOf, branchOf, type OpenPr, titleOf } from "@/lib/prs/prs"
import { reviewStatus } from "@/lib/prs/pr-status"
import { cn } from "@/lib/utils"
import { CiBadge, LocalChip, MergePill, PrStateIcon, ReviewPill } from "./pr-bits"
import { usePrCommands } from "./pr-commands"
import { PR_KEYS, PrContextMenu, usePrShortcuts } from "./pr-menu"
import { PlainMarkdown } from "./plain-markdown"
import { type DiffCitation, type DiffMode, FileDiff } from "./file-diff"
import { ProposalTab } from "./proposal-tab"

export type { DiffMode } from "./file-diff"
export type PrTab = "description" | "commits" | "files" | "proposal"

/** Los atajos de la vista; la paleta los muestra igual. */
export const PR_VIEW_KEYS = { mode: "S", prev: "[", next: "]", all: "A" } as const

/** Lo que la paleta puede pedirle a la vista abierta. */
export interface PrControls {
  chat?: Pick<PrChatController, "open" | "toggle" | "actions">
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
  const chat = usePrChat(pr.id, appData)
  const commands = usePrCommands()
  // "Chatear sobre este PR" (C en la lista, menú contextual, paleta) abre la vista con el composer enfocado.
  const { focusComposer } = chat
  useEffect(() => {
    if (wantsChatFocus(pr.id)) focusComposer(() => chatFocusDone(pr.id))
  }, [pr.id, focusComposer])
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

  // "Ver cambios" de la propuesta abre su pestaña.
  const { diffOpen, setDiffOpen } = chat
  useEffect(() => {
    if (!diffOpen) return
    setTab("proposal")
    setDiffOpen(false)
  }, [diffOpen, setDiffOpen])
  const proposal = chat.snapshot?.proposal ?? null
  const chatId = chat.snapshot?.chat.id
  const cite = chat.cite
  const citeLines = useCallback((c: DiffCitation) => cite({ kind: "lines", ...c }), [cite])
  const citeFinding = useCallback((f: BotFinding) => cite({ kind: "thread", id: f.id, ...(f.path && { path: f.path }), ...(f.line !== undefined && { line: f.line }), author: "bot de review", text: f.text }), [cite])

  // Un objeto nuevo solo cuando algo cambia: el padre los guarda en su estado, y uno nuevo en cada render sería un loop.
  const { supported: chatSupported, open: chatOpen, toggle: toggleChat, actions: chatActions } = chat
  const controls = useMemo<PrControls>(() => ({
    reload, mode, toggleMode, prevCommit: prev, nextCommit: next, allCommits: all,
    ...(chatSupported ? { chat: { open: chatOpen, toggle: toggleChat, actions: chatActions } } : {}),
  }), [reload, mode, toggleMode, prev, next, all, chatSupported, chatOpen, toggleChat, chatActions])
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
      else if (tab === "proposal" && (e.key === PR_VIEW_KEYS.prev || e.key === PR_VIEW_KEYS.next)) return
      else if (e.key === PR_VIEW_KEYS.prev && prev) prev()
      else if (e.key === PR_VIEW_KEYS.next && next) next()
      else if (e.key.toUpperCase() === PR_VIEW_KEYS.all && all) all()
      else return
      e.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onBack, toggleMode, prev, next, all, tab])

  const additions = detail?.files.reduce((sum, f) => sum + (f.additions ?? 0), 0) ?? 0
  const deletions = detail?.files.reduce((sum, f) => sum + (f.deletions ?? 0), 0) ?? 0

  return (
    <ResizablePanelGroup orientation="horizontal" onLayoutChanged={(layout) => {
      if (layout.chat !== undefined) writePref("prChatSize", Math.round(layout.chat))
    }}>
      <ResizablePanel id="pr" minSize="35%">
    <div className="flex h-full flex-col">
      <PrContextMenu pr={pr}>
        <header className="flex flex-col gap-2 border-b px-6 pt-5 pb-4">
          <div className="flex items-center gap-2">
            {pr.local ? <LocalChip base={pr.local.base} /> : <PrStateIcon pr={pr} />}
            <h1 className="truncate text-lg font-semibold">{detail?.title ?? titleOf(pr)}</h1>
            <div className="ml-auto flex flex-none items-center gap-2">
              {chatSupported ? (
                <Hint label={chatOpen ? "Plegar chat" : "Abrir chat"} keys={CHAT_KEYS.toggle}>
                  <Button size="sm" variant="outline" aria-expanded={chatOpen} onClick={toggleChat}>{chatOpen ? "Plegar chat" : "Abrir chat"}</Button>
                </Hint>
              ) : null}
              {!pr.local ? (
                <Button variant="outline" size="sm" onClick={() => commands.openGithub(pr)} title={`Abrir en GitHub (${PR_KEYS.openGithub})`}>
                  <ExternalLink /> Abrir en GitHub
                </Button>
              ) : null}
            </div>
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
            {proposal && chatId ? (
              <TabsTrigger value="proposal">
                <MessageSquareDiff /> Propuesta {proposal.rev}
              </TabsTrigger>
            ) : null}
          </TabsList>
          <TabsContent value="description" className="min-h-0 overflow-y-auto px-6 py-4">
            {!pr.local && pr.state.bot.state === "findings" && pr.state.bot.findings.length > 0 && chatSupported ? (
              <BotFindings findings={pr.state.bot.findings} onAsk={citeFinding} />
            ) : null}
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
              onCite={chatSupported ? citeLines : undefined}
            />
          </TabsContent>
          {proposal && chatId ? (
            <TabsContent value="proposal" className="flex min-h-0 flex-col">
              <ProposalTab chatId={chatId} proposal={proposal} mode={mode} onMode={setMode} />
            </TabsContent>
          ) : null}
        </Tabs>
      )}
    </div>
      </ResizablePanel>
      {chatSupported && chatOpen ? (
        <>
          <ResizableHandle withHandle />
          <ResizablePanel id="chat" defaultSize={`${readPref("prChatSize", 40)}%`} minSize="30%" maxSize="65%">
            <ChatPanel controller={chat} pr={pr} prChildren={commands.childrenOf(pr.id)} onOpenRun={commands.openRunById} />
          </ResizablePanel>
        </>
      ) : null}
    </ResizablePanelGroup>
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
  onCite?: (citation: DiffCitation) => void
}

function Files({ detail, commit, mode, onMode, onScope, viewed, onViewed, commitViewed, onCommitViewed, onCite }: FilesProps) {
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
        return <FileDiff key={`${sha ?? "all"}:${file.path}`} file={file} mode={mode} viewed={viewed.has(print)} onViewed={(on) => onViewed(print, on)} onCite={onCite} />
      })}
      </div>
    </>
  )
}

/** Los hallazgos abiertos del bot de review: cada uno se le puede pedir al chat, citado con su texto y su id. */
function BotFindings({ findings, onAsk }: { findings: readonly BotFinding[]; onAsk: (finding: BotFinding) => void }) {
  return (
    <section aria-label="Hallazgos del bot" className="mb-4 max-w-3xl space-y-2 rounded-lg border p-3">
      <h3 className="text-sm font-medium">Hallazgos abiertos del bot de review</h3>
      <ul className="space-y-2">
        {findings.map((finding) => (
          <li key={finding.id} className="flex items-start gap-3 text-sm">
            <div className="min-w-0 flex-1">
              {finding.path ? <code className="font-mono text-xs text-muted-foreground">{finding.path}{finding.line ? `:${finding.line}` : ""}</code> : null}
              <p className="whitespace-pre-wrap">{finding.text}</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => onAsk(finding)}>Pedírselo al clanker</Button>
          </li>
        ))}
      </ul>
    </section>
  )
}
