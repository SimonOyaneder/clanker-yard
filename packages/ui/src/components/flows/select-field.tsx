import { cn } from "@/lib/utils"

interface Props {
  label: string
  value: string
  options: readonly { value: string; label: string }[]
  onChange: (value: string) => void
}

/**
 * Un selector nativo con el estilo de los inputs. Si el valor actual no está entre las opciones (un modelo que el core
 * ya no lista), se muestra igual y se conserva: elegir otro es lo único que lo cambia.
 */
export function SelectField({ label, value, options, onChange }: Props) {
  const known = options.some((o) => o.value === value)
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn("h-8 w-full rounded-md border border-input bg-transparent px-2 text-[13px] shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30 dark:[&>option]:bg-background")}
    >
      {known ? null : <option value={value}>{value}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}
