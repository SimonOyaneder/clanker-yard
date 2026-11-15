import { createContext, useContext } from "react"
import type { AppConfig, IssueDetail, Launched, LoopSummary, NewLoopInput, PRsResult, Result, Snapshot } from "@/types"

// De dónde saca datos la UI y a quién le pide acciones. La implementación real habla con la API
// del core; `createMemoryAppData` sirve datos de ejemplo para desarrollar sin core.
export interface AppData {
  snapshot(): Promise<Result<Snapshot>>
  issue(slug: string, issueId: string): Promise<Result<IssueDetail>>
  summary(slug: string): Promise<Result<LoopSummary>>
  config(): Promise<Result<AppConfig>>
  prs(force: boolean): Promise<Result<PRsResult>>
  setArchived(slug: string, archived: boolean): Promise<Result<null>>
  newLoop(input: NewLoopInput): Promise<Result<Launched>>
  runLoop(slug: string, mode: "run" | "watch"): Promise<Result<Launched>>
  resume(slug: string, sessionId: string): Promise<Result<Launched>>
  stop(agentId: string): Promise<Result<null>>
}

const AppDataContext = createContext<AppData | null>(null)
export const AppDataProvider = AppDataContext.Provider

export function useAppData(): AppData {
  const data = useContext(AppDataContext)
  if (!data) throw new Error("useAppData fuera de AppDataProvider")
  return data
}
