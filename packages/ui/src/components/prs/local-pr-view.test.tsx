// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { afterEach, expect, test, vi } from "vitest"
import { AppDataProvider } from "@/app-data"
import { type LocalPrControls, LocalPrView } from "@/components/prs/local-pr-view"
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

async function openTab(name: RegExp) {
  const tab = await screen.findByRole("tab", { name })
  fireEvent.mouseDown(tab)
  fireEvent.click(tab)
}

/** La fila del diff que tiene `text`: con el resaltado, el texto de una línea va partido en varios `span`. */
const rowWith = (text: string) => [...document.querySelectorAll("tr")].find((tr) => tr.textContent?.includes(text))

test("muestra la descripción con sus títulos, los commits y el diff contra la base, como GitHub", async () => {
  const { local } = await setup()

  expect(screen.getByText(local.local.base)).toBeTruthy()
  expect(await screen.findByRole("heading", { name: "Qué cambia" })).toBeTruthy()
  expect(screen.getByText("Suma un test que cubre el caso sin entradas.")).toBeTruthy()

  await openTab(/Commits 2/)
  expect(await screen.findByText("test(entries): cubrir el caso sin entradas")).toBeTruthy()

  await openTab(/Archivos 2/)
  expect(await screen.findByText("app/models/entry_index.rb")).toBeTruthy()
  expect(rowWith("return if entries.none?")?.dataset.kind).toBe("add")
  expect([...document.querySelectorAll("tr[data-kind='del']")].map((tr) => tr.textContent?.replace(/\s+/g, " ").trim())).toEqual(["13− rebuild"])
})

test("Esc vuelve a los stacks", async () => {
  const { onBack } = await setup()
  fireEvent.keyDown(window, { key: "Escape" })
  expect(onBack).toHaveBeenCalled()
})

test("abrir un commit muestra solo lo que cambió ese commit, y ] [ y A se mueven entre commits", async () => {
  await setup()
  await screen.findByRole("heading", { name: "Qué cambia" })
  await openTab(/Commits 2/)
  fireEvent.click(await screen.findByText("test(entries): cubrir el caso sin entradas"))

  expect(await screen.findByText("spec/models/entry_index_spec.rb")).toBeTruthy()
  expect(screen.queryByText("app/models/entry_index.rb")).toBeNull()

  fireEvent.keyDown(window, { key: "[" })
  expect(await screen.findByText("app/models/entry_index.rb")).toBeTruthy()
  expect(screen.queryByText("spec/models/entry_index_spec.rb")).toBeNull()

  fireEvent.keyDown(window, { key: "a" })
  expect(await screen.findByText("spec/models/entry_index_spec.rb")).toBeTruthy()
  expect(screen.getByText("app/models/entry_index.rb")).toBeTruthy()
})

test("un archivo visto se pliega, cuenta en el progreso y se recuerda al volver", async () => {
  const { local } = await setup()
  await openTab(/Archivos 2/)
  await screen.findByText("app/models/entry_index.rb")

  fireEvent.click(screen.getByRole("checkbox", { name: "Marcar app/models/entry_index.rb como visto" }))

  expect(screen.getByText("1 de 2 archivos vistos")).toBeTruthy()
  expect(rowWith("return if entries.none?")).toBeUndefined()
  cleanup()
  await setup()
  await openTab(/Archivos 2/)
  expect(await screen.findByText("1 de 2 archivos vistos")).toBeTruthy()
  localStorage.removeItem(`clanker.localPr.viewed.${local.id}`)
})

test("S cambia a lado a lado: lo borrado a la izquierda, lo agregado a la derecha y el código con el color de su lenguaje", async () => {
  await setup()
  await openTab(/Archivos 2/)
  await screen.findByText("app/models/entry_index.rb")

  fireEvent.keyDown(window, { key: "s" })

  const pair = rowWith("return if entries.none?")!
  expect(pair.dataset.kind).toBe("pair")
  expect([...pair.querySelectorAll("td[data-side]")].map((td) => [td.getAttribute("data-side"), td.getAttribute("data-kind")])).toEqual([
    ["old", "del"],
    ["new", "add"],
  ])
  expect(pair.textContent).toContain("rebuild")
  // highlight.js marca `return` como palabra clave de Ruby.
  expect(pair.querySelector(".hljs-keyword")?.textContent).toBe("return")
  fireEvent.keyDown(window, { key: "s" })
  localStorage.removeItem("clanker.localPr.diffMode")
})

test("pasarle sus controles a un padre que los guarda en su estado (como App) no rehace la vista en loop", async () => {
  const data = createMemoryAppData(NOW)
  const local = openPrsOf(await data.openPrs()).find((p): p is LocalPr => p.local !== null)!
  let renders = 0
  function Parent() {
    const [controls, setControls] = useState<LocalPrControls | null>(null)
    renders++
    return (
      <>
        <span data-testid="mode">{controls?.mode ?? "-"}</span>
        <LocalPrView pr={local} onBack={() => {}} onControls={setControls} />
      </>
    )
  }
  render(
    <AppDataProvider value={data}>
      <TooltipProvider>
        <Parent />
      </TooltipProvider>
    </AppDataProvider>,
  )

  expect(await screen.findByRole("heading", { name: "Qué cambia" })).toBeTruthy()
  expect(screen.getByTestId("mode").textContent).toBe("unified")
  expect(renders).toBeLessThan(10)
})
