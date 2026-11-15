import { RecipeTestPhase, type RecipeTestResult, type Repo } from "@clanker/api"
import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useAppData } from "@/app-data"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useLive } from "@/hooks/use-live"
import { cn } from "@/lib/utils"

/** Un trozo de la salida del comando que corre en `phase`. */
interface Chunk {
  phase: RecipeTestPhase
  text: string
}

// Corre la receta del repo y muestra su salida mientras llega (`recipe.test_output`); al terminar, un resumen por comando.
export function RecipeSheet({ repo, runId, onClose }: { repo: Repo | null; runId: number; onClose: () => void }) {
  return (
    <Sheet open={repo !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-xl">
        {repo ? <RecipeRun key={runId} repo={repo} /> : null}
      </SheetContent>
    </Sheet>
  )
}

function RecipeRun({ repo }: { repo: Repo }) {
  const appData = useAppData()
  const { subscribe } = useLive()
  const [chunks, setChunks] = useState<Chunk[]>([])
  const [result, setResult] = useState<RecipeTestResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)
  const logEnd = useRef<HTMLDivElement>(null)

  useEffect(
    () =>
      subscribe((event) => {
        const { repoId, text } = event.payload
        const phase = RecipeTestPhase.safeParse(event.payload.phase)
        if (event.type !== "recipe.test_output" || repoId !== repo.id || typeof text !== "string" || !phase.success) return
        setChunks((all) => [...all, { phase: phase.data, text }])
      }),
    [subscribe, repo.id],
  )

  // Una sola vez por apertura: el modo estricto de React monta dos veces y la segunda prueba chocaría con la primera.
  useEffect(() => {
    if (started.current) return
    started.current = true
    appData.testRecipe(repo.id).then(setResult, (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [appData, repo.id])

  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: "end" })
  }, [chunks, result, error])

  const running = !result && !error
  // Sin stream en vivo (se cayó la conexión de eventos) el log sale de lo que devolvió la prueba.
  const log = chunks.length > 0 ? chunks : (result?.steps.filter((s) => s.extract).map((s) => ({ phase: s.phase, text: `${s.extract}\n` })) ?? [])
  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2">
          {running ? <Loader2 className="size-4 animate-spin text-violet-600 dark:text-violet-400" /> : result?.ok ? <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" /> : <CircleAlert className="size-4 text-destructive" />}
          Probar receta · {repo.name}
        </SheetTitle>
        <SheetDescription>
          {running ? "Corre requires y setup en un worktree desechable; no toca tu checkout." : result?.ok ? "La receta corrió completa." : "La receta falló; abajo está el comando y su salida."}
        </SheetDescription>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4">
        <div role="log" aria-label="Salida de la receta" className="rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
          {log.length === 0 ? <span className="text-muted-foreground">{running ? "Esperando la primera línea…" : "Sin salida."}</span> : null}
          {log.map((chunk, i) => (
            <div key={i}>
              {log[i - 1]?.phase !== chunk.phase ? <div className="mt-1 text-[11px] text-muted-foreground first:mt-0">── {chunk.phase}</div> : null}
              <span className="break-all whitespace-pre-wrap">{chunk.text}</span>
            </div>
          ))}
        </div>
        {error ? (
          <p role="alert" className="text-[13px] text-destructive">
            {error}
          </p>
        ) : null}
        {result ? (
          <ul className="flex flex-col gap-1.5 text-[13px]">
            {result.steps.map((step, i) => (
              <li key={i} className="flex flex-col gap-0.5">
                <span className="flex items-center gap-2">
                  {step.ok ? <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-400" /> : <CircleAlert className="size-3.5 text-destructive" />}
                  <span className="text-muted-foreground">{step.phase}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{step.name}</span>
                  <span className={cn("font-mono text-xs", step.ok ? "text-muted-foreground" : "text-destructive")}>exit {step.exitCode}</span>
                </span>
                {!step.ok && step.extract ? <pre className="ml-5.5 overflow-x-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap">{step.extract}</pre> : null}
              </li>
            ))}
          </ul>
        ) : null}
        <div ref={logEnd} />
      </div>
    </>
  )
}
