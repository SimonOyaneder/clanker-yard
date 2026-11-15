import type { AgentSessionId, ArtifactHash, FlowDef, Step, StepDetail, StepSession, TranscriptEntry, TranscriptPage } from "@clanker/api"

// El detalle de un paso para `createMemoryAppData`: sesiones, artefactos, comandos y un transcript largo
// (para ver el scroll virtualizado). Todo es de ejemplo y sale del tipo del nodo, no de su nombre.

const hash = (n: number) => n.toString(16).padStart(64, "0") as ArtifactHash
const sessionId = (stepN: number, attempt: number) => `ses_${String(stepN * 10 + attempt).padStart(26, "0")}` as AgentSessionId

const PAGE = 40

function transcriptOf(role: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [{ kind: "prompt", text: `Eres ${role}. Revisa el cambio de la rama y entrega tu reporte.`, truncated: false }]
  const files = ["app/models/commission.rb", "app/services/scope.rb", "spec/models/commission_spec.rb", "app/controllers/tickets_controller.rb"]
  for (let i = 0; i < 24; i++) {
    const file = files[i % files.length]!
    entries.push({ kind: "text", text: i % 3 === 0 ? `Reviso ${file}: el scope por organización no cubre el caso sin modelo.` : `Sigo con ${file}.`, truncated: false })
    const id = `toolu_${i}`
    entries.push({ kind: "tool_call", id, tool: i % 2 ? "Grep" : "Read", detail: i % 2 ? "find_commission" : file, input: JSON.stringify(i % 2 ? { pattern: "find_commission" } : { file_path: file }, null, 2), truncated: false })
    entries.push({ kind: "tool_result", id, text: i % 2 ? `${file}:12: def find_commission(id)` : `class Commission < ApplicationRecord\n  belongs_to :organization\nend`, isError: false, truncated: false })
  }
  entries.push({ kind: "result", subtype: "success", isError: false, turns: 25, costUsd: 0.31, text: "Reporte entregado." })
  return entries
}

export function transcriptPage(entries: TranscriptEntry[], cursor: number): TranscriptPage {
  const next = Math.min(cursor + PAGE, entries.length)
  return { entries: entries.slice(cursor, next), next, hasMore: next < entries.length }
}

export interface StepSeed {
  detail: StepDetail
  /** Por hash, el texto de cada artefacto. */
  artifacts: Map<ArtifactHash, string>
  /** Por id de sesión. */
  transcripts: Map<string, TranscriptEntry[]>
}

export function seedStep(step: Step, stepN: number, def: FlowDef["nodes"][string] | undefined, startedAt: number): StepSeed {
  const artifacts = new Map<ArtifactHash, string>()
  const stored = (name: string, kind: StepDetail["artifacts"][number]["kind"], content: string, n: number): StepDetail["artifacts"][number] => {
    const h = hash(stepN * 100 + n)
    artifacts.set(h, content)
    return { hash: h, name, kind, mime: content.startsWith("{") ? "application/json" : "text/plain", size: content.length }
  }
  const detail: StepDetail = { id: step.id, sessions: [], artifacts: [], commands: [] }
  const transcripts = new Map<string, TranscriptEntry[]>()
  if (step.status === "pending") return { detail, artifacts, transcripts }

  detail.artifacts.push(stored("input", "brief", JSON.stringify({ issue: { key: "ENG-9178" }, base: "main" }, null, 2), 1))
  if (step.outcome) detail.artifacts.push(stored("output", "report", JSON.stringify({ findings: [{ severity: "yellow", path: "app/models/commission.rb", claim: "falta el scope por organización" }] }, null, 2), 2))

  if (def?.type === "agent") {
    const attempts = Math.max(1, step.attempt)
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const last = attempt === attempts
      const id = sessionId(stepN, attempt)
      transcripts.set(id, transcriptOf(def.role))
      detail.sessions.push({
        id,
        runtime: "claude-sdk",
        sessionRef: `00000000-0000-4000-8000-${String(stepN * 10 + attempt).padStart(12, "0")}`,
        role: def.role,
        model: "sonnet",
        effort: "high",
        status: !last ? "error" : step.status === "done" ? "success" : step.status === "failed" ? "error_max_budget_usd" : "running",
        error: !last ? "La app se cerró con la sesión en curso" : step.error,
        turns: 25,
        usage: { input: 42_000, output: 6_100, cacheRead: 380_000, cacheWrite: 21_000 },
        costMicros: step.costMicros,
        startedAt: startedAt + attempt * 1000,
        endedAt: last && step.endedAt === null ? null : (step.endedAt ?? startedAt) + attempt * 1000,
        report: last && step.outcome ? { outcome: step.outcome, summary: "Un hallazgo 🟡: el scope por organización no cubre el caso sin modelo.", decisions: [{ title: "Scope por organización", body: "Conviene definirlo en el modelo y no en el controller." }], payload: JSON.parse(artifacts.get(hash(stepN * 100 + 2)) ?? "{}") } : null,
      } satisfies StepSession)
    }
  }
  if (def?.type === "action") {
    const red = step.status === "failed"
    const summary = red ? "Tests  1 failed | 41 passed (42)" : "Tests  42 passed (42)"
    detail.commands.push(
      { command: "npm run typecheck", output: "> tsc --noEmit", truncated: false, exitCode: 0, killedBy: null },
      { command: "npm test", output: `${red ? " FAIL  src/scope.test.ts > cubre el caso sin modelo\nAssertionError: expected 1 to be 2\n\n" : ""} ${summary}`, truncated: false, exitCode: red ? 1 : 0, killedBy: null },
    )
    detail.artifacts.push(stored("check:tests", "log_excerpt", summary, 3))
  }
  return { detail, artifacts, transcripts }
}
