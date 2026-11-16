// @vitest-environment jsdom
import type { Decision } from "@clanker/api"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, test } from "vitest"
import type { OpenPr } from "@/lib/prs"
import { PrNotes, PrNotesContext } from "./pr-notes"

afterEach(cleanup)

const pr = { id: "pr_1", issueId: null } as unknown as OpenPr
const note = (n: number, title: string, subject: Decision["subject"]) => ({ id: `dec_${n}`, title, body: "", runId: `run_${n}`, subject, createdAt: 0 }) as unknown as Decision

test("el PR dice cuántas notas tiene para el review y las abre; las de otros PRs no cuentan", () => {
  const notes = [note(1, "Doppler en el worktree", { type: "pr", id: "pr_1" }), note(2, "CI rojo ajeno", { type: "pr", id: "pr_1" }), note(3, "De otro", { type: "pr", id: "pr_2" })]
  render(
    <PrNotesContext.Provider value={notes}>
      <PrNotes pr={pr} />
    </PrNotesContext.Provider>,
  )

  fireEvent.click(screen.getByRole("button", { name: "2 notas para el review" }))

  expect(screen.getByText("Doppler en el worktree")).toBeTruthy()
  expect(screen.getByText("CI rojo ajeno")).toBeTruthy()
  expect(screen.queryByText("De otro")).toBeNull()
})

test("sin notas no hay indicador", () => {
  const { container } = render(<PrNotes pr={pr} />)

  expect(container.textContent).toBe("")
})
