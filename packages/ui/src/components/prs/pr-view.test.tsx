// @vitest-environment jsdom
import type { Event } from "@clanker/api"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeAll, expect, test, vi } from "vitest"
import { AppDataProvider } from "@/app-data"
import { type PrControls, PrView } from "@/components/prs/pr-view"
import { PrCommandsProvider } from "@/components/prs/pr-commands"
import { TooltipProvider } from "@/components/ui/tooltip"
import { createMemoryAppData } from "@/demo/memory-app-data"
import { type GithubPr, type LocalPr, openPrsOf } from "@/lib/prs/prs"
import { HostProvider, type Host } from "@/host"
import { LiveProvider } from "@/hooks/use-live"

const NOW = Date.parse("2026-11-17T12:00:00Z")
let emit: (event: Event) => void

vi.mock("@/hooks/use-events", () => ({
  useEvents: (onEvent: (event: Event) => void) => {
    emit = onEvent
    return false
  },
}))

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {}
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function setup(remote = false, error?: string, body?: string) {
  const data = createMemoryAppData(NOW)
  const prs = openPrsOf(await data.openPrs())
  const local = prs.find((p): p is LocalPr => p.local !== null)!
  const github = prs.find((p): p is GithubPr => p.state?.key === "ledger#421")!
  const pr = remote ? github : local
  const detail = vi.spyOn(data, "prDetail")
  if (body !== undefined) detail.mockResolvedValue({ ...(await data.prDetail(pr.id)), body })
  if (error) detail.mockRejectedValueOnce(new Error(error))
  const diff = vi.spyOn(data, "prCommitDiff")
  const host = { openExternal: vi.fn() } as unknown as Host
  const onBack = vi.fn()
  const onControls = vi.fn<(controls: PrControls | null) => void>()
  render(
    <AppDataProvider value={data}>
      <HostProvider value={host}>
        <TooltipProvider>
          <PrCommandsProvider prs={prs} projects={[]} onOpenRun={() => {}} onOpenPr={() => {}}>
            <LiveProvider>
              <PrView pr={pr} onBack={onBack} onControls={onControls} />
            </LiveProvider>
          </PrCommandsProvider>
        </TooltipProvider>
      </HostProvider>
    </AppDataProvider>,
  )
  return { local, github, pr, data, detail, diff, host, onBack, onControls }
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
  const { onBack, host } = await setup()
  fireEvent.keyDown(window, { key: "o" })
  expect(host.openExternal).not.toHaveBeenCalled()
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
    const [controls, setControls] = useState<PrControls | null>(null)
    renders++
    return (
      <>
        <span data-testid="mode">{controls?.mode ?? "-"}</span>
        <PrView pr={local} onBack={() => {}} onControls={setControls} />
      </>
    )
  }
  render(
    <AppDataProvider value={data}>
      <HostProvider value={{ openExternal: vi.fn() } as unknown as Host}>
        <TooltipProvider>
          <PrCommandsProvider prs={[local]} projects={[]} onOpenRun={() => {}} onOpenPr={() => {}}>
            <Parent />
          </PrCommandsProvider>
        </TooltipProvider>
      </HostProvider>
    </AppDataProvider>,
  )

  expect(await screen.findByRole("heading", { name: "Qué cambia" })).toBeTruthy()
  expect(screen.getByTestId("mode").textContent).toBe("unified")
  expect(renders).toBeLessThan(10)
})

test("un remoto muestra descripción, commits y diff con CI, review, merge y acceso a GitHub", async () => {
  const { github, data, diff, host } = await setup(true)
  expect(await screen.findByRole("heading", { name: "Qué cambia" })).toBeTruthy()
  expect(screen.getByLabelText("CI verde")).toBeTruthy()
  expect(screen.getByText("Aprobado")).toBeTruthy()
  expect(screen.getByText("Listo para merge")).toBeTruthy()
  expect(screen.queryByText("Local")).toBeNull()

  fireEvent.click(screen.getByRole("button", { name: "Abrir en GitHub" }))
  fireEvent.keyDown(window, { key: "o" })
  expect(vi.mocked(host.openExternal).mock.calls).toEqual([[github.state.url], [github.state.url]])
  const input = document.createElement("input")
  document.body.append(input)
  fireEvent.keyDown(input, { key: "o" })
  expect(host.openExternal).toHaveBeenCalledTimes(2)
  input.remove()

  await openTab(/Commits 2/)
  fireEvent.click(await screen.findByText("test(entries): cubrir el caso sin entradas"))
  expect(await screen.findByText("spec/models/entry_index_spec.rb")).toBeTruthy()
  expect(screen.queryByText("app/models/entry_index.rb")).toBeNull()
  const detail = await data.prDetail(github.id)
  expect(diff).toHaveBeenCalledWith({ id: github.id, sha: detail.commits[1]!.sha, head: detail.head, base: detail.baseSha })
  fireEvent.keyDown(window, { key: "a" })
  expect(await screen.findByText("app/models/entry_index.rb")).toBeTruthy()
  expect(rowWith("return if entries.none?")?.dataset.kind).toBe("add")
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Qué commits ver" }), { key: "Enter" })
  const listbox = await screen.findByRole("listbox")
  fireEvent.keyDown(listbox, { key: "o" })
  expect(host.openExternal).toHaveBeenCalledTimes(2)
  fireEvent.keyDown(listbox, { key: "Escape" })
})

test("si no se pudo traer el remoto, dice qué hacer y permite reintentar sin perder el link a GitHub", async () => {
  const { detail, pr } = await setup(true, "No pude traer el PR: comprueba tu conexión y acceso al repo y vuelve a intentar.")
  expect(await screen.findByRole("alert")).toBeTruthy()
  expect(screen.getByText(/comprueba tu conexión y acceso/)).toBeTruthy()
  expect(screen.getByRole("button", { name: "Abrir en GitHub" })).toBeTruthy()
  expect(screen.queryByRole("tablist")).toBeNull()

  fireEvent.click(screen.getByRole("button", { name: "Reintentar" }))
  expect(await screen.findByRole("heading", { name: "Qué cambia" })).toBeTruthy()
  expect(detail.mock.calls).toEqual([[pr.id], [pr.id]])
  expect(screen.queryByRole("alert")).toBeNull()
})

test("solo relee el detalle por cambios del PR abierto o actualización explícita y conserva el diff mientras sus SHA no cambien", async () => {
  const { pr, github, detail, diff, onControls } = await setup(true)
  await openTab(/Commits 2/)
  fireEvent.click(await screen.findByText("test(entries): cubrir el caso sin entradas"))
  expect(await screen.findByText("spec/models/entry_index_spec.rb")).toBeTruthy()
  expect(detail).toHaveBeenCalledTimes(1)
  expect(diff).toHaveBeenCalledTimes(1)
  vi.useFakeTimers()

  await act(async () => {
    for (const type of ["agent.activity", "agent.usage", "pr.changed"] as const) {
      emit({ seq: 1, ts: NOW, type, origin: "core", subject: { type: "pr", id: "otro-pr" }, payload: {} })
    }
    await vi.advanceTimersByTimeAsync(120)
  })
  expect(detail).toHaveBeenCalledTimes(1)
  expect(diff).toHaveBeenCalledTimes(1)

  await act(async () => {
    emit({ seq: 2, ts: NOW, type: "pr.changed", origin: "core", subject: { type: "pr", id: pr.id }, payload: {} })
    await vi.advanceTimersByTimeAsync(120)
  })
  expect(detail).toHaveBeenCalledTimes(2)
  expect(diff).toHaveBeenCalledTimes(1)

  await act(async () => onControls.mock.lastCall![0]!.reload())
  expect(detail).toHaveBeenCalledTimes(3)
  expect(diff).toHaveBeenCalledTimes(1)

  const original = await detail.mock.results[0]!.value
  detail.mockResolvedValue({ ...original, head: "d".repeat(40), baseSha: "e".repeat(40) })
  await act(async () => {
    emit({ seq: 3, ts: NOW, type: "pr.changed", origin: "core", subject: { type: "pr", id: pr.id }, payload: {} })
    await vi.advanceTimersByTimeAsync(120)
  })
  expect(detail).toHaveBeenCalledTimes(4)
  expect(diff).toHaveBeenCalledTimes(2)
  expect(diff).toHaveBeenLastCalledWith({ id: github.id, sha: original.commits[1]!.sha, head: "d".repeat(40), base: "e".repeat(40) })
})

test("un diff de commit que falla permite reintentar sin recargar el detalle", async () => {
  const { detail, diff } = await setup(true)
  diff.mockRejectedValueOnce(new Error("No pude leer el diff: vuelve a intentar."))
  await openTab(/Commits 2/)
  fireEvent.click(await screen.findByText("test(entries): cubrir el caso sin entradas"))
  expect((await screen.findByRole("alert")).textContent).toContain("No pude leer el diff: vuelve a intentar.")

  fireEvent.click(screen.getByRole("button", { name: "Reintentar" }))

  expect(await screen.findByText("spec/models/entry_index_spec.rb")).toBeTruthy()
  expect(screen.queryByRole("alert")).toBeNull()
  expect(detail).toHaveBeenCalledTimes(1)
  expect(diff).toHaveBeenCalledTimes(2)
  expect(diff.mock.calls[1]).toEqual(diff.mock.calls[0])
})

test("un remoto sin descripción invita a agregarla en GitHub, no dice que falta publicarlo", async () => {
  await setup(true, undefined, "")
  expect(await screen.findByText("El PR no tiene descripción. Puedes agregarla en GitHub.")).toBeTruthy()
  expect(screen.queryByText(/se publicará con el título solo/)).toBeNull()
})
