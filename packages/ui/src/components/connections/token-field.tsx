import { Loader2 } from "lucide-react"
import { type ReactNode, useId, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

interface Props {
  label: string
  placeholder: string
  /** El botón: "Probar" o "Guardar y usar". */
  action: string
  /** Si rechaza, el mensaje se muestra tal cual debajo del campo y el valor se conserva para corregirlo. */
  onSubmit: (value: string) => Promise<void>
  help?: ReactNode
}

// Un secreto que se pega (PAT, API key): nunca se muestra, se limpia al aceptarse y el rechazo dice qué cambiar.
export function TokenField({ label, placeholder, action, onSubmit, help }: Props) {
  const id = useId()
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await onSubmit(value.trim())
      setValue("")
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault()
        if (value.trim() && !busy) void submit()
      }}
    >
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <div className="flex gap-2">
        <Input
          id={id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-invalid={error !== null}
          className="h-8 font-mono text-[13px]"
        />
        <Button type="submit" size="sm" disabled={!value.trim() || busy}>
          {busy ? <Loader2 className="animate-spin" /> : null}
          {action}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {help}
    </form>
  )
}
