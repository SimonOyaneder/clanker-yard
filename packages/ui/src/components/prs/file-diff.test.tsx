// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import { parsePatch } from "@/lib/prs/diff"
import { FileDiff } from "./file-diff"

afterEach(cleanup)

const PATCH = [
  "diff --git a/src/index.ts b/src/index.ts",
  "--- a/src/index.ts",
  "+++ b/src/index.ts",
  "@@ -1,3 +1,4 @@",
  " export const a = 1",
  "-export const b = 2",
  "+export const b = 3",
  "+export const c = 4",
  " export const d = 5",
  "",
].join("\n")

function setup() {
  const onCite = vi.fn()
  render(<FileDiff file={parsePatch(PATCH)[0]!} mode="unified" viewed={false} onViewed={() => {}} onCite={onCite} />)
  const rows = screen.getAllByRole("row")
  return { onCite, rows }
}

test("clic en un número marca la línea, Mayús+clic extiende y ⌥K cita el rango con su ruta y sus líneas", () => {
  const { onCite, rows } = setup()
  // La fila 0 es el hunk; después: a, -b, +b, +c, d.
  fireEvent.click((rows[3] as HTMLTableRowElement).cells[1]!)
  fireEvent.click((rows[4] as HTMLTableRowElement).cells[1]!, { shiftKey: true })
  expect(rows.filter((row) => row.dataset.marked).length).toBe(2)

  fireEvent.keyDown(window, { code: "KeyK", altKey: true })

  expect(onCite).toHaveBeenCalledWith({ path: "src/index.ts", start: 2, end: 3, text: "+export const b = 3\n+export const c = 4" })
  expect(rows.filter((row) => row.dataset.marked).length).toBe(0)
})

test("sin marca, ⌥K no cita nada; el menú contextual cita la línea sobre la que se abrió", async () => {
  const { onCite, rows } = setup()
  fireEvent.keyDown(window, { code: "KeyK", altKey: true })
  expect(onCite).not.toHaveBeenCalled()

  rows[2]!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))
  fireEvent.click(await screen.findByRole("menuitem", { name: /Preguntar al clanker/ }))

  expect(onCite).toHaveBeenCalledWith({ path: "src/index.ts", start: 2, end: 2, text: "−export const b = 2" })
})

test("sin onCite el diff no ofrece citar", () => {
  render(<FileDiff file={parsePatch(PATCH)[0]!} mode="unified" viewed={false} onViewed={() => {}} />)
  fireEvent.click((screen.getAllByRole("row")[3] as HTMLTableRowElement).cells[1]!)
  expect(screen.getAllByRole("row").filter((row) => row.dataset.marked)).toEqual([])
})
