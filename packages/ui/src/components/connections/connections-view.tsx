import type { Connection } from "@clanker/api"
import { useState } from "react"
import { useAppData } from "@/app-data"
import { ClaudeCard } from "@/components/connections/claude-card"
import { GitHubCard } from "@/components/connections/github-card"
import { LinearCard } from "@/components/connections/linear-card"
import { RecipeSheet } from "@/components/connections/recipe-sheet"
import { ReposTable } from "@/components/connections/repos-table"
import { Button } from "@/components/ui/button"
import type { ClaudePlan } from "@/hooks/use-claude-plan"
import type { LinearLogin } from "@/hooks/use-linear-login"
import { useLiveQuery } from "@/hooks/use-live"
import { connectionOf } from "@/lib/connections"

interface Props {
  connections: Connection[]
  plan: ClaudePlan
  linearLogin: LinearLogin
  onChanged: () => void
}

// Conexiones: las tres cuentas (GitHub, Linear, Claude) y los repos con su receta.
export function ConnectionsView({ connections, plan, linearLogin, onChanged }: Props) {
  const appData = useAppData()
  const repos = useLiveQuery("repos", () => appData.repos())
  const [recipeTest, setRecipeTest] = useState<{ repoId: string; runId: number } | null>(null)
  const testing = recipeTest ? repos.data?.find((r) => r.repo.id === recipeTest.repoId)?.repo ?? null : null

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">Conexiones</h1>
        <p className="text-[13px] text-muted-foreground">Las cuentas con que los agentes actúan y los repos donde trabajan. Los tokens viven en el llavero del core y no llegan a la interfaz.</p>
      </header>
      <div className="flex flex-col gap-3">
        <GitHubCard connection={connectionOf(connections, "github")} onChanged={onChanged} />
        <LinearCard connection={connectionOf(connections, "linear")} login={linearLogin} onChanged={onChanged} />
        <ClaudeCard connection={connectionOf(connections, "claude")} plan={plan} onChanged={onChanged} />
      </div>
      {repos.data ? (
        <ReposTable rows={repos.data} onTest={(repo) => setRecipeTest({ repoId: repo.id, runId: (recipeTest?.runId ?? 0) + 1 })} onAdded={repos.reload} />
      ) : repos.error ? (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-[13px]">
          <span>No pude leer los repos: {repos.error}</span>
          <Button size="sm" variant="outline" onClick={repos.reload}>
            Reintentar
          </Button>
        </div>
      ) : null}
      <RecipeSheet repo={testing} runId={recipeTest?.runId ?? 0} onClose={() => setRecipeTest(null)} />
    </div>
  )
}
