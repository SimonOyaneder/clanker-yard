import type { TranscriptEntry } from "@clanker/api"

export type ToolResult = { text: string; isError: boolean; truncated: boolean }

/** Lo que el transcript muestra: una línea por mensaje, y cada tool call con su resultado ya unido. */
export type TranscriptRow =
  | { key: string; kind: "prompt" | "text" | "thinking"; text: string; truncated: boolean }
  | { key: string; kind: "tool"; tool: string; detail: string | null; input: string; inputTruncated: boolean; result: ToolResult | null }
  | { key: string; kind: "compaction"; trigger: string }
  | { key: string; kind: "result"; subtype: string; isError: boolean; turns: number | null; costUsd: number | null; text: string | null }

/**
 * Los eventos del transcript como filas. El resultado de una herramienta llega en un mensaje aparte, después
 * de su call: se une a ella por id, y mientras no llegue la fila queda sin resultado (la herramienta corre).
 * La clave de una fila es la posición de su primer evento: no cambia cuando llegan eventos nuevos al final.
 */
export function rowsOf(entries: readonly TranscriptEntry[]): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  const calls = new Map<string, Extract<TranscriptRow, { kind: "tool" }>>()
  entries.forEach((entry, index) => {
    const key = String(index)
    switch (entry.kind) {
      case "prompt":
      case "text":
      case "thinking":
        rows.push({ key, kind: entry.kind, text: entry.text, truncated: entry.truncated })
        break
      case "tool_call": {
        const row = { key, kind: "tool" as const, tool: entry.tool, detail: entry.detail, input: entry.input, inputTruncated: entry.truncated, result: null }
        calls.set(entry.id, row)
        rows.push(row)
        break
      }
      case "tool_result": {
        const result = { text: entry.text, isError: entry.isError, truncated: entry.truncated }
        const call = calls.get(entry.id)
        if (call) call.result = result
        // Un resultado cuya call no está en el transcript no se descarta: se ve como una herramienta sin nombre.
        else rows.push({ key, kind: "tool", tool: "resultado", detail: null, input: "", inputTruncated: false, result })
        break
      }
      case "compaction":
        rows.push({ key, kind: "compaction", trigger: entry.trigger })
        break
      case "result":
        rows.push({ key, kind: "result", subtype: entry.subtype, isError: entry.isError, turns: entry.turns, costUsd: entry.costUsd, text: entry.text })
        break
    }
  })
  return rows
}
