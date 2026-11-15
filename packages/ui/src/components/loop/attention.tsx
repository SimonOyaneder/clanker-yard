import { AlertCircle, ArrowUpRight, Bell, CircleAlert } from "lucide-react"
import { useState } from "react"
import type { Loop } from "@/types"
import { Button } from "@/components/ui/button"
import { useHost } from "@/host"
import { cn } from "@/lib/utils"
import { Ago, SectionTitle } from "../common"

const DAY = 24 * 60 * 60 * 1000
const URL_RE = /\s*·?\s*(https:\/\/github\.com\/\S+)/

// Separa el link al PR del texto, para mostrarlo como botón y no como URL suelta.
function splitUrl(text: string): { text: string; url: string | null } {
  const m = URL_RE.exec(text)
  return m ? { text: text.replace(URL_RE, "").trim(), url: m[1] ?? null } : { text, url: null }
}

export function Attention({ loop, onOpenIssue }: { loop: Loop; onOpenIssue: (id: string) => void }) {
  const host = useHost()
  const [showAll, setShowAll] = useState(false)
  const now = Date.now()
  const events = loop.feed.filter(
    (f) => (f.kind === "evento" || f.kind === "falló") && !f.text.startsWith("mergeado") && now - Date.parse(f.ts) < DAY,
  )
  const pending = loop.decisions.filter((d) => d.pending)
  const rest = loop.decisions.filter((d) => !d.pending)

  return (
    <section className="flex flex-col gap-2">
      <SectionTitle count={events.length + pending.length}>Necesita tu atención</SectionTitle>
      {events.length || pending.length ? (
        <ul className="max-h-[560px] overflow-y-auto rounded-lg border bg-card">
          {events.map((e) => {
            const { text, url } = splitUrl(e.text)
            const Icon = e.kind === "falló" ? AlertCircle : Bell
            return (
              <li key={`${e.ts}-${e.text}`} className="flex gap-2.5 border-t px-3 py-2.5 first:border-t-0">
                <Icon className={cn("mt-0.5 size-3.5 flex-none", e.kind === "falló" ? "text-red-600 dark:text-red-400" : "text-sky-600 dark:text-sky-400")} />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p title={text} className="line-clamp-3 text-[12.5px] break-words">
                    {text}
                  </p>
                  <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
                    <Ago iso={e.ts} />
                    {url ? (
                      <Button variant="link" size="sm" className="h-auto p-0 text-[11.5px]" onClick={() => host.openExternal(url)}>
                        Abrir PR <ArrowUpRight className="size-3" />
                      </Button>
                    ) : null}
                  </div>
                </div>
              </li>
            )
          })}
          {pending.map((d) => (
            <li key={d.text} className="flex gap-2.5 border-t px-3 py-2.5 first:border-t-0">
              <CircleAlert className="mt-0.5 size-3.5 flex-none text-amber-600 dark:text-amber-400" />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p title={d.text} className="line-clamp-3 text-[12.5px] break-words">
                  {d.text.replace(/^PENDIENTE:?\s*/, "")}
                </p>
                {d.issueId ? (
                  <button
                    type="button"
                    onClick={() => onOpenIssue(d.issueId!)}
                    className="w-fit font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                  >
                    {d.issueId}
                    {d.pr ? ` · ${d.pr}` : ""}
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed px-3 py-3 text-[12.5px] text-muted-foreground">
          Nada urgente: sin eventos del vigilante en 24 h ni decisiones pendientes.
        </p>
      )}
      {rest.length ? (
        <div className="flex flex-col gap-1.5">
          <button type="button" onClick={() => setShowAll(!showAll)} className="w-fit text-xs text-muted-foreground hover:text-foreground">
            {showAll ? "Ocultar" : "Ver"} las otras {rest.length} decisiones
          </button>
          {showAll ? (
            <ul className="max-h-[420px] overflow-y-auto rounded-lg border bg-card">
              {rest.map((d) => (
                <li key={d.text} className="border-t px-3 py-2 text-[12.5px] first:border-t-0">
                  {d.issueId ? <span className="mr-1.5 font-mono text-[11px] text-muted-foreground">{d.issueId}</span> : null}
                  {d.text}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
