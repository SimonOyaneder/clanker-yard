import type { ArtifactHash } from "@clanker/api"
import type { ReactNode } from "react"
import { useAppData } from "@/app-data"
import { useLiveQuery } from "@/hooks/use-live"
import { fileSize } from "@/lib/format"
import { cn } from "@/lib/utils"

/** Un estado vacío o de error: dice por qué pasa y, si hay algo que hacer, lo ofrece. */
export function EmptyNote({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 p-4">
      <p className="text-[13px] font-medium">{title}</p>
      <p className="max-w-prose text-muted-foreground">{children}</p>
      {action}
    </div>
  )
}

export function Code({ children, className, error }: { children: string; className?: string; error?: boolean }) {
  return (
    <pre className={cn("overflow-auto rounded-md bg-muted/60 p-3 font-mono text-xs whitespace-pre-wrap break-words", error && "text-red-700 dark:text-red-300", className)}>
      {children}
    </pre>
  )
}

/** Un JSON con sangría; lo que no es JSON (un log, un diff) se muestra tal cual. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

// Más que esto en pantalla no se lee, y un diff de megas congela la lista.
export const ARTIFACT_VIEW_MAX_CHARS = 200_000

/** El contenido de un artefacto guardado, pedido al abrirlo. */
export function ArtifactText({ hash, size }: { hash: ArtifactHash; size: number }) {
  const appData = useAppData()
  const artifact = useLiveQuery(`artifact:${hash}`, () => appData.artifact(hash), { live: false })
  if (artifact.error) return <EmptyNote title="No pude leer el artefacto" action={<button type="button" className="text-xs underline" onClick={artifact.reload}>Reintentar</button>}>{artifact.error}</EmptyNote>
  if (artifact.data === undefined) return <p className="text-muted-foreground">Leyendo…</p>
  const clipped = artifact.data.length > ARTIFACT_VIEW_MAX_CHARS
  return (
    <>
      <Code className="max-h-80">{prettyJson(clipped ? artifact.data.slice(0, ARTIFACT_VIEW_MAX_CHARS) : artifact.data)}</Code>
      {clipped ? <p className="pt-1 text-[11px] text-muted-foreground">Se muestran los primeros {ARTIFACT_VIEW_MAX_CHARS.toLocaleString("es-CL")} caracteres de {fileSize(size)}.</p> : null}
    </>
  )
}
