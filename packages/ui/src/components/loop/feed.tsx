import type { FeedItem } from "@/types"
import { absolute, clock, feedHint, feedTone } from "@/lib/format"
import { Pill, SectionTitle } from "../common"

export function Feed({ feed }: { feed: FeedItem[] }) {
  return (
    <section className="flex flex-col gap-2">
      <SectionTitle aside="lo que el EM escribe en su terminal">Actividad</SectionTitle>
      {feed.length ? (
        <ol className="max-h-[560px] overflow-y-auto rounded-lg border bg-card">
          {feed.map((f) => (
            <li key={`${f.ts}-${f.text}`} className="grid grid-cols-[44px_64px_minmax(0,1fr)] items-baseline gap-2 border-t px-3 py-2 first:border-t-0">
              <time dateTime={f.ts} title={absolute(f.ts)} className="font-mono text-[11px] text-muted-foreground">
                {clock(f.ts)}
              </time>
              <Pill className={`justify-self-start ${feedTone[f.kind]}`} hint={feedHint[f.kind]}>
                {f.kind}
              </Pill>
              <span title={f.text} className="line-clamp-2 text-[12.5px] break-words">
                {f.text}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="rounded-lg border border-dashed px-3 py-3 text-[12.5px] text-muted-foreground">Sin actividad registrada.</p>
      )}
    </section>
  )
}
