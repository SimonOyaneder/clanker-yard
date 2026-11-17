// @vitest-environment jsdom
import type { AgentSessionId, TranscriptEntry, TranscriptPage } from "@clanker/api"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, expect, test, vi } from "vitest"
import { AppDataProvider, type AppData } from "@/app-data"
import { StepTranscript } from "@/components/run/step-transcript"
import { createMemoryAppData } from "@/demo/memory-app-data"

const SESSION = "ses_00000000000000000000000001" as AgentSessionId
const PAGE = 60

// jsdom no mide el DOM: la lista virtualizada lee el alto de su contenedor de `clientHeight` y el de cada fila de `offsetHeight`.
const ROW = 30
function viewport(height: number) {
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, value: height })
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 600 })
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: ROW })
}
beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})
afterEach(cleanup)

const text = (n: number): TranscriptEntry => ({ kind: "text", text: `mensaje ${n}`, truncated: false })

/** Un transcript de `total` mensajes servido de a `PAGE`, con la misma forma de paginar del core. */
function transcriptOf(total: number): { appData: AppData; calls: number[] } {
  const calls: number[] = []
  const appData: AppData = {
    ...createMemoryAppData(),
    transcript: async (_session, cursor): Promise<TranscriptPage> => {
      calls.push(cursor)
      const next = Math.min(cursor + PAGE, total)
      return { entries: Array.from({ length: next - cursor }, (_, i) => text(cursor + i)), next, hasMore: next < total }
    },
  }
  return { appData, calls }
}

const mount = (appData: AppData, live = false) =>
  render(
    <AppDataProvider value={appData}>
      <StepTranscript sessionId={SESSION} live={live} />
    </AppDataProvider>,
  )

test("pide la página siguiente solo al acercarse al final", async () => {
  viewport(100)
  const { appData, calls } = transcriptOf(300)

  const { container } = mount(appData)

  expect(await screen.findByText("mensaje 0")).toBeTruthy()
  // Un viewport de ~3 filas está lejos del final de la primera página: no pide más.
  expect(calls).toEqual([0])
  expect(screen.queryByText("mensaje 60")).toBeNull()

  // Al bajar hasta el final llegan las siguientes páginas, siempre desde donde terminó la anterior.
  const scroller = container.querySelector('[aria-label="Transcript del agente"]')!
  Object.defineProperty(scroller, "scrollTop", { configurable: true, value: 10_000, writable: true })
  fireEvent.scroll(scroller)
  await waitFor(() => expect(calls.slice(0, 3)).toEqual([0, 60, 120]))
})

test("con espacio de sobra lee todo el transcript, página tras página, y se detiene al terminar", async () => {
  viewport(5000)
  const { appData, calls } = transcriptOf(130)

  mount(appData)

  expect(await screen.findByText("mensaje 129")).toBeTruthy()
  expect(calls).toEqual([0, 60, 120])
})

test("una sesión sin transcript dice por qué y deja volver a leer", async () => {
  viewport(600)
  const { appData, calls } = transcriptOf(0)

  mount(appData)

  expect(await screen.findByText("Esta sesión todavía no tiene transcript")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Volver a leer" }))
  await waitFor(() => expect(calls).toEqual([0, 0]))
})

test("un error del core se muestra tal cual y deja reintentar", async () => {
  viewport(600)
  const transcript = vi.fn().mockRejectedValueOnce(new Error("No existe la sesión")).mockResolvedValue({ entries: [text(0)], next: 1, hasMore: false })

  mount({ ...createMemoryAppData(), transcript })

  expect(await screen.findByText("No existe la sesión")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Reintentar" }))
  expect(await screen.findByText("mensaje 0")).toBeTruthy()
})

test("las tool calls van plegadas y se abren con su entrada y su resultado", async () => {
  viewport(600)
  const entries: TranscriptEntry[] = [
    { kind: "tool_call", id: "t1", tool: "Read", detail: "a.rb", input: '{ "file_path": "a.rb" }', truncated: false },
    { kind: "tool_result", id: "t1", text: "puts 1", isError: false, truncated: false },
  ]
  mount({ ...createMemoryAppData(), transcript: async () => ({ entries, next: 2, hasMore: false }) })

  const call = await screen.findByRole("button", { name: /Read/ })
  expect(screen.queryByText("puts 1")).toBeNull()

  fireEvent.click(call)

  expect(await screen.findByText("puts 1")).toBeTruthy()
  expect(screen.getByText('{ "file_path": "a.rb" }')).toBeTruthy()
})
