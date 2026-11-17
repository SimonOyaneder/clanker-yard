import type { LocalPrDetail } from "@clanker/api"
import { FileCode2, GitCommitHorizontal, ScrollText } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { useAppData } from "@/app-data"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useLiveQuery } from "@/hooks/use-live"
import { ago } from "@/lib/format"
import { type DiffFile, parsePatch } from "@/lib/prs/diff"
import type { LocalPr } from "@/lib/prs/prs"
import { cn } from "@/lib/utils"
import { isTypingTarget } from "@/lib/keys"
import { LocalChip } from "./pr-bits"
import { PlainMarkdown } from "./plain-markdown"

// Un PR local (stacks locales) no está en GitHub: esta vista muestra lo que GitHub mostraría (descripción, commits y
// diff contra su base) leído del repo por el core (`prs.localDetail`). Se relee sola cuando el PR cambia (un restack).

/** Líneas que se dibujan de un archivo antes de pedir "Mostrar todo": un diff de miles de líneas congela la vista. */
const LINES_PER_FILE = 400

/** La vista de un PR local; Esc vuelve a los stacks. */
export function LocalPrView({ pr, onBack }: { pr: LocalPr; onBack: () => void }) {
  const appData = useAppData()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || isTypingTarget(e.target, ["[role='dialog']", "[role='alertdialog']", "[role='menu']"])) return
      e.preventDefault()
      onBack()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onBack])
  const query = useLiveQuery(`local-pr:${pr.id}`, () => appData.localPrDetail(pr.id))
  const detail = query.data
  const files = useMemo(() => (detail ? parsePatch(detail.patch) : []), [detail])
  const additions = detail?.files.reduce((sum, f) => sum + (f.additions ?? 0), 0) ?? 0
  const deletions = detail?.files.reduce((sum, f) => sum + (f.deletions ?? 0), 0) ?? 0

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-2 border-b px-6 pt-5 pb-4">
        <div className="flex items-center gap-2">
          <LocalChip base={pr.local.base} />
          <h1 className="truncate text-lg font-semibold">{detail?.title ?? pr.local.title}</h1>
        </div>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[12px] text-muted-foreground">
          <span>{pr.local.base}</span>
          <span aria-hidden>←</span>
          <span className="text-foreground">{pr.local.branch}</span>
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
      </header>

      {query.error && !detail ? (
        <p className="px-6 py-5 text-sm text-destructive">{query.error}</p>
      ) : !detail ? (
        <div className="flex flex-col gap-3 px-6 py-5">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <Tabs defaultValue="description" className="min-h-0 flex-1 gap-0">
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
              <p className="text-sm text-muted-foreground">El PR no tiene descripción: se publicará con el título solo.</p>
            )}
          </TabsContent>
          <TabsContent value="commits" className="min-h-0 overflow-y-auto px-6 py-4">
            <Commits detail={detail} />
          </TabsContent>
          <TabsContent value="files" className="min-h-0 overflow-y-auto px-6 py-4">
            {detail.truncated ? (
              <p className="mb-3 text-xs text-muted-foreground">El diff es muy grande y se muestra cortado: míralo completo con git diff {pr.local.base}...{pr.local.branch}.</p>
            ) : null}
            {files.length === 0 ? <p className="text-sm text-muted-foreground">El PR no cambia ningún archivo respecto de {pr.local.base}.</p> : null}
            <div className="flex flex-col gap-4">
              {files.map((file) => (
                <FileDiff key={file.path} file={file} />
              ))}
            </div>
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}

function Commits({ detail }: { detail: LocalPrDetail }) {
  if (detail.commits.length === 0) return <p className="text-sm text-muted-foreground">No tiene commits propios sobre {detail.base}.</p>
  return (
    <ol className="flex flex-col divide-y rounded-lg border">
      {detail.commits.map((c) => (
        <li key={c.sha} className="flex flex-col gap-1 px-4 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium">{c.subject}</span>
            <span className="flex-none font-mono text-[12px] text-muted-foreground">{c.sha.slice(0, 9)}</span>
          </div>
          <span className="text-xs text-muted-foreground">
            {c.author} · {ago(c.date)}
          </span>
          {c.body ? <p className="mt-1 text-xs whitespace-pre-wrap text-muted-foreground">{c.body}</p> : null}
        </li>
      ))}
    </ol>
  )
}

const LINE_TONE: Record<string, string> = {
  add: "bg-viz-3/10",
  del: "bg-destructive/10",
  hunk: "bg-muted text-muted-foreground",
  ctx: "",
  note: "text-muted-foreground italic",
}

function FileDiff({ file }: { file: DiffFile }) {
  const [all, setAll] = useState(false)
  const lines = all ? file.lines : file.lines.slice(0, LINES_PER_FILE)
  const status = { added: "nuevo", deleted: "borrado", binary: "binario", modified: null }[file.status]
  return (
    <section className="overflow-hidden rounded-lg border">
      <header className="flex items-center gap-2 border-b bg-muted/50 px-3 py-2 font-mono text-[12px]">
        <span className="truncate">{file.path}</span>
        {status ? <span className="rounded bg-muted px-1.5 text-muted-foreground">{status}</span> : null}
        <span className="ml-auto flex-none text-viz-3">+{file.additions}</span>
        <span className="flex-none text-destructive">−{file.deletions}</span>
      </header>
      {file.status === "binary" ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">Archivo binario: no se muestra el cambio.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse font-mono text-[12px] leading-5">
            <tbody>
              {lines.map((line, i) => (
                <tr key={i} data-kind={line.kind} className={cn(LINE_TONE[line.kind])}>
                  <td className="w-12 select-none px-2 text-right text-muted-foreground/70">{line.old ?? ""}</td>
                  <td className="w-12 select-none px-2 text-right text-muted-foreground/70">{line.new ?? ""}</td>
                  <td className="w-4 select-none text-center text-muted-foreground">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}</td>
                  <td className="pr-3 whitespace-pre">{line.text}</td>
                </tr>
              ))}
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
