import type { TranscriptEntry } from "@clanker/api"
import { expect, test } from "vitest"
import { rowsOf } from "@/lib/transcript"

const call = (id: string): TranscriptEntry => ({ kind: "tool_call", id, tool: "Read", detail: "a.rb", input: "{}", truncated: false })
const result = (id: string, isError = false): TranscriptEntry => ({ kind: "tool_result", id, text: "ok", isError, truncated: false })

test("el resultado se une a su call por id aunque haya otras en medio", () => {
  const rows = rowsOf([call("a"), call("b"), result("b", true), result("a")])

  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatchObject({ kind: "tool", result: { isError: false } })
  expect(rows[1]).toMatchObject({ kind: "tool", result: { isError: true } })
})

test("una call sin resultado queda abierta: la herramienta todavía corre", () => {
  expect(rowsOf([call("a")])[0]).toMatchObject({ kind: "tool", result: null })
})

test("un resultado sin call se ve igual en vez de perderse", () => {
  expect(rowsOf([result("x")])).toEqual([
    { key: "0", kind: "tool", tool: "resultado", detail: null, input: "", inputTruncated: false, result: { text: "ok", isError: false, truncated: false } },
  ])
})

test("la clave de una fila no cambia al llegar eventos nuevos", () => {
  const first: TranscriptEntry[] = [{ kind: "text", text: "uno", truncated: false }, call("a")]
  const before = rowsOf(first).map((r) => r.key)
  const after = rowsOf([...first, result("a"), { kind: "text", text: "dos", truncated: false }]).map((r) => r.key)

  expect(after.slice(0, before.length)).toEqual(before)
  expect(after).toEqual(["0", "1", "3"])
})
