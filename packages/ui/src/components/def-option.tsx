import type { DefRecord } from "@clanker/api"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
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

const NONE = "__none__"

/**
 * El selector de un flujo o un perfil, por slug. Con `emptyLabel` la primera opción es "ninguno" (`null`); sin él hay
 * que elegir uno. Un slug que ya no está entre `defs` se muestra tal cual.
 */
export function DefSelect({
  id,
  value,
  defs,
  emptyLabel,
  onChange,
  size,
}: {
  id: string
  value: string | null
  defs: readonly DefRecord[]
  emptyLabel?: string
  onChange: (slug: string | null) => void
  size?: "sm" | "default"
}) {
  const selected = defs.find((d) => d.slug === value)
  return (
    <Select value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? null : v)}>
      <SelectTrigger id={id} size={size} className="w-full">
        <SelectValue>{selected ? defName(selected) : (value ?? emptyLabel ?? null)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {emptyLabel === undefined ? null : <SelectItem value={NONE}>{emptyLabel}</SelectItem>}
        {defs.map((d) => (
          <SelectItem key={d.slug} value={d.slug}>
            <DefOption def={d} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
