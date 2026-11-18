import type { CachedPr, ChatMessage, ChatProposal, PrChat } from "@clanker/api"

const prId = (n: number) => `pr_${String(n).padStart(26, "0")}`

export const CHAT_SCENARIOS = [
  { id: "empty", label: "Chat vacío", prId: prId(11) },
  { id: "streaming", label: "Respuesta en curso", prId: prId(2) },
  { id: "explanation", label: "Explicación sin cambios", prId: prId(3) },
  { id: "draft", label: "Propuesta lista", prId: prId(4) },
  { id: "applying", label: "Aplicando propuesta", prId: prId(5) },
  { id: "applied", label: "Aplicada con restack y conflicto", prId: prId(1) },
  { id: "stale", label: "Propuesta desactualizada", prId: prId(6) },
  { id: "expired", label: "Login vencido", prId: prId(7) },
  { id: "unowned", label: "Propuesta en PR externo", prId: prId(13) },
] as const

export interface SeedPrChat {
  chat: PrChat
  messages: ChatMessage[]
  proposal: ChatProposal | null
  patch: string
  runtimeError: string | null
}

export function seedPrChats(prs: CachedPr[], now: number): SeedPrChat[] {
  return prs.map((pr, index) => {
    const scenario = CHAT_SCENARIOS.find((item) => item.prId === pr.id)?.id ?? "empty"
    const blocked = scenario === "expired" ? "La sesión de Claude venció. Vuelve a conectar Claude en Conexiones y reintenta." : !pr.owned ? "Este PR no lo abrió Clanker Yard. Puedes conversar y revisar propuestas, pero no aplicarlas." : undefined
    const chat: PrChat = {
      id: `chat_${String(index + 1).padStart(26, "0")}`,
      prId: pr.id,
      status: "active",
      runtime: scenario === "expired" ? "claude-sdk" : "opencode",
      model: scenario === "expired" ? "sonnet" : "openai/gpt-6.1-terra",
      effort: "high",
      busy: scenario === "streaming",
      costMicros: scenario === "empty" ? 0 : 24_000,
      canApply: !blocked,
      ...(blocked ? { applyReason: blocked } : {}),
    }
    const messages: ChatMessage[] = scenario === "empty" ? [] : [
      { id: `${chat.id}-user-1`, role: "user", text: scenario === "explanation" ? "Explícame qué cambia este PR, sin modificar archivos." : "Agrega una validación para evitar procesar entradas vacías y cubre el caso con un test.", at: now - 120_000 },
      { id: `${chat.id}-assistant-1`, role: "assistant", text: scenario === "streaming" ? "Estoy revisando el diff" : scenario === "explanation" ? "Este PR incorpora reglas de boundaries para engines nuevas. El diff agrega la validación y su test; no he modificado archivos ni creado una propuesta." : "Preparé una validación y su test. Revisa la propuesta antes de aplicarla al PR.", at: now - 60_000 },
    ]
    const hasProposal = !["empty", "streaming", "explanation"].includes(scenario)
    const proposal: ChatProposal | null = hasProposal ? {
      rev: 1,
      baseSha: scenario === "stale" ? "0".repeat(40) : pr.state?.headSha ?? "9f2c4e1ab7d03c55e18f0b6a2d4c7e9f01b3a5c8",
      summary: "Evitar procesar entradas vacías y cubrir el caso con un test.",
      items: [
        { id: "guard", change: "No reconstruir el índice cuando no hay entradas.", path: "app/models/entry_index.rb" },
        { id: "regression", change: "Cubrir el índice sin entradas.", path: "spec/models/entry_index_spec.rb" },
      ],
      files: [
        { path: "app/models/entry_index.rb", additions: 1, deletions: 0 },
        { path: "spec/models/entry_index_spec.rb", additions: 3, deletions: 0 },
      ],
      status: scenario === "applying" ? "applying" : scenario === "applied" ? "applied" : scenario === "stale" ? "stale" : "draft",
      ...(["applying", "applied"].includes(scenario) ? { runId: `run_${String(800 + index).padStart(26, "0")}` as const } : {}),
      ...(scenario === "applied" ? {
        result: {
          sha: "c".repeat(40),
          children: [
            { prId: prId(2), status: "restacked" as const, head: "d".repeat(40) },
            { prId: prId(4), status: "conflict" as const, files: ["app/models/entry_index.rb"], failures: "El hijo modifica la misma validación. Su branch se conservó sin cambios." },
          ],
        },
      } : {}),
    } : null
    if (proposal) messages[1] = { ...messages[1]!, proposalRev: proposal.rev }
    if (scenario === "applying") messages.push({ id: `${chat.id}-system-1`, role: "system", text: "Aplicando la propuesta. La corrida verificará los cambios antes de actualizar el PR.", at: now - 15_000 })
    if (scenario === "applied") messages.push({ id: `${chat.id}-system-1`, role: "system", text: "Propuesta aplicada. Un hijo se restackeó y otro quedó con conflicto; su branch no cambió.", at: now - 15_000 })
    if (scenario === "stale") messages.push({ id: `${chat.id}-system-1`, role: "system", text: "El PR cambió desde que se creó esta propuesta. Pide una nueva antes de aplicar.", at: now - 15_000 })
    if (scenario === "expired") messages.push({ id: `${chat.id}-system-1`, role: "system", text: blocked!, at: now - 15_000 })
    return {
      chat,
      messages,
      proposal,
      runtimeError: scenario === "expired" ? blocked! : null,
      patch: [
        "diff --git a/app/models/entry_index.rb b/app/models/entry_index.rb",
        "--- a/app/models/entry_index.rb",
        "+++ b/app/models/entry_index.rb",
        "@@ -12,3 +12,4 @@",
        "   def refresh",
        "+    return if entries.none?",
        "     rebuild(concurrently: true)",
        "   end",
        "diff --git a/spec/models/entry_index_spec.rb b/spec/models/entry_index_spec.rb",
        "--- a/spec/models/entry_index_spec.rb",
        "+++ b/spec/models/entry_index_spec.rb",
        "@@ -1,3 +1,6 @@",
        " describe EntryIndex do",
        "   it { expect(described_class.new.refresh).to be_nil }",
        "+  it \"does not rebuild an empty index\" do",
        "+    expect(described_class.new).not_to receive(:rebuild)",
        "+  end",
        " end",
        "",
      ].join("\n"),
    }
  })
}
