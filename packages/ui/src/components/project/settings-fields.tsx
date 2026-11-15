import { X } from "lucide-react"
import { useState, type ReactNode } from "react"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

/** Una sección de Ajustes: `id` es el ancla a la que lleva "Editar filtros". */
export function Section({ id, title, description, children }: { id: string; title: string; description: ReactNode; children: ReactNode }) {
  return (
    <section id={`settings-${id}`} aria-labelledby={`settings-${id}-title`} className="flex scroll-mt-4 flex-col gap-4 rounded-lg border bg-card p-4">
      <header className="flex flex-col gap-0.5">
        <h2 id={`settings-${id}-title`} className="text-sm font-semibold">
          {title}
        </h2>
        <p className="text-[13px] text-muted-foreground">{description}</p>
      </header>
      {children}
    </section>
  )
}

/** Etiqueta, ayuda y el error que impide guardar: el error se lee como alerta y queda ligado al control por `aria-describedby`. */
export function Field({ id, label, hint, error, children }: { id: string; label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

const CHIP_SEPARATORS = /[,\n]/

/** Una lista de textos cortos (labels, secciones): Enter o coma agrega, Backspace en vacío quita el último y salir del campo agrega lo escrito. */
export function ChipsInput({
  id,
  value,
  onChange,
  placeholder,
  invalid,
  describedBy,
  label,
}: {
  id: string
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  invalid?: boolean
  describedBy?: string
  /** El nombre accesible cuando no hay un `Label` que apunte al campo. */
  label?: string
}) {
  const [text, setText] = useState("")
  const commit = (raw: string) => {
    const added = raw.split(CHIP_SEPARATORS).map((t) => t.trim()).filter((t) => t && !value.includes(t))
    if (added.length) onChange([...value, ...new Set(added)])
    setText("")
  }
  return (
    <div
      className={cn(
        "flex min-h-8 flex-wrap items-center gap-1 rounded-md border bg-background px-1.5 py-1 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
        invalid && "border-destructive",
      )}
    >
      {value.map((chip) => (
        <span key={chip} className="inline-flex h-5 items-center gap-0.5 rounded bg-muted pr-0.5 pl-1.5 text-xs">
          {chip}
          <button
            type="button"
            aria-label={`Quitar ${chip}`}
            onClick={() => onChange(value.filter((c) => c !== chip))}
            className="grid size-4 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={text}
        placeholder={value.length ? undefined : placeholder}
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(e) => (CHIP_SEPARATORS.test(e.target.value) ? commit(e.target.value) : setText(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            // Enter agrega el texto y no envía el formulario ni dispara atajos de la vista.
            e.preventDefault()
            commit(text)
          } else if (e.key === "Backspace" && text === "" && value.length) onChange(value.slice(0, -1))
        }}
        onBlur={() => commit(text)}
        className="h-5 min-w-24 flex-1 bg-transparent px-1 text-[13px] outline-none placeholder:text-muted-foreground"
      />
    </div>
  )
}
