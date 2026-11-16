import type { DefRecord } from "@clanker/api"
import { defName, defSummary } from "@/lib/defs"

// Lo que ofrece cada opción de un selector de flujos o perfiles: qué es, y en mono el slug que usan la CLI y el MCP.
export function DefOption({ def }: { def: DefRecord }) {
  const summary = defSummary(def)
  return (
    <span className="flex flex-col">
      <span>{defName(def)}</span>
      {summary ? <span className="text-xs text-muted-foreground">{summary}</span> : null}
      {defName(def) !== def.slug ? <span className="font-mono text-xs text-muted-foreground">{def.slug}</span> : null}
    </span>
  )
}
