// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import { AppDataProvider } from "@/app-data"
import { LocalPrView } from "@/components/prs/local-pr-view"
import { TooltipProvider } from "@/components/ui/tooltip"
import { createMemoryAppData } from "@/demo/memory-app-data"
import { type LocalPr, openPrsOf } from "@/lib/prs/prs"

const NOW = Date.parse("2026-11-17T12:00:00Z")

afterEach(cleanup)

async function setup() {
  const data = createMemoryAppData(NOW)
  const local = openPrsOf(await data.openPrs()).find((p): p is LocalPr => p.local !== null)!
  const onBack = vi.fn()
  render(
    <AppDataProvider value={data}>
      <TooltipProvider>
        <LocalPrView pr={local} onBack={onBack} />
      </TooltipProvider>
    </AppDataProvider>,
  )
  return { local, onBack }
}

const openTab = (name: RegExp) => {
  const tab = screen.getByRole("tab", { name })
  fireEvent.mouseDown(tab)
  fireEvent.click(tab)
}

test("muestra la descripción con sus títulos, los commits y el diff contra la base, como GitHub", async () => {
  const { local } = await setup()

  expect(screen.getByText(local.local.base)).toBeTruthy()
  expect(await screen.findByRole("heading", { name: "Qué cambia" })).toBeTruthy()
  expect(screen.getByText("Suma un test que cubre el caso sin entradas.")).toBeTruthy()

  openTab(/Commits 2/)
  expect(await screen.findByText("test(entries): cubrir el caso sin entradas")).toBeTruthy()

  openTab(/Archivos 2/)
  expect(await screen.findByText("app/models/entry_index.rb")).toBeTruthy()
  expect(screen.getByText("return if entries.none?").closest("tr")?.dataset.kind).toBe("add")
  expect(screen.getByText("rebuild").closest("tr")?.dataset.kind).toBe("del")
})

test("Esc vuelve a los stacks", async () => {
  const { onBack } = await setup()
  fireEvent.keyDown(window, { key: "Escape" })
  expect(onBack).toHaveBeenCalled()
})
