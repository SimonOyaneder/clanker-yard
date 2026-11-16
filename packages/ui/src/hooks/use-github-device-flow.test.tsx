// @vitest-environment jsdom
import type { Connection, Event, GitHubDeviceFlow } from "@clanker/api"
import { act, cleanup, renderHook } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { type AppData, AppDataProvider } from "@/app-data"
import { useGitHubDeviceFlow } from "@/hooks/use-github-device-flow"
import { LiveProvider } from "@/hooks/use-live"
import { HostProvider, type Host } from "@/host"
import { createMemoryAppData } from "@/demo/memory-app-data"

const NOW = Date.parse("2026-11-15T12:00:00Z")
const flow: GitHubDeviceFlow = { userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresIn: 900 }
const connected: Connection = { provider: "github", account: "octocat", scopes: [], status: "active", auth: "app", expiresAt: NOW + 183 * 86_400_000 }

let emit: (event: Event) => void

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  Object.assign(navigator, { clipboard: { writeText: vi.fn(() => Promise.resolve()) } })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

// Los eventos del core llegan por el stream de `LiveProvider`: `emit` empuja uno.
const wrapper = (startGithubDeviceFlow: () => Promise<GitHubDeviceFlow>, host: Partial<Host> = {}) => {
  let push: (event: Event) => void = () => {}
  emit = (event) => push(event)
  const events: AppData["events"] = async (_after, signal) => ({
    async *[Symbol.asyncIterator]() {
      const queue: Event[] = []
      let wake = () => {}
      push = (event) => {
        queue.push(event)
        wake()
      }
      while (!signal.aborted) {
        const next = queue.shift()
        if (next) yield next
        else
          await new Promise<void>((resolve) => {
            wake = resolve
            signal.addEventListener("abort", () => resolve(), { once: true })
          })
      }
    },
  })
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <HostProvider value={host as Host}>
        <AppDataProvider value={{ ...createMemoryAppData(NOW), startGithubDeviceFlow, events }}>
          <LiveProvider>{children}</LiveProvider>
        </AppDataProvider>
      </HostProvider>
    )
  }
}

const loginFailed = (seq: number, reason: string, message: string): Event => ({ seq, ts: NOW, type: "connection.login_failed", origin: "core", payload: { provider: "github", reason, message } })

test("si el core rechaza el inicio (falta el client_id), el mensaje con el paso a seguir queda en error y no se abre el navegador", async () => {
  const message = 'Falta el client_id de la GitHub App. Ponlo en config.json como { "githubApp": { "clientId": "Iv..." } }.'
  const openExternal = vi.fn()
  const { result } = renderHook(() => useGitHubDeviceFlow(undefined, () => {}), { wrapper: wrapper(() => Promise.reject(new Error(message)), { openExternal }) })

  await act(() => result.current.start())

  expect(result.current.failure).toEqual({ reason: "failed", message })
  expect(result.current.pending).toBeNull()
  expect(openExternal).not.toHaveBeenCalled()
})

test("muestra el código, lo copia y abre github.com mientras espera; al cambiar la conexión termina", async () => {
  const openExternal = vi.fn()
  const { result, rerender } = renderHook(({ connection }: { connection: Connection | undefined }) => useGitHubDeviceFlow(connection, () => {}), {
    wrapper: wrapper(() => Promise.resolve(flow), { openExternal }),
    initialProps: { connection: undefined as Connection | undefined },
  })

  await act(() => result.current.start())

  expect(result.current.pending).toEqual({ ...flow, expiresAt: NOW + 900_000 })
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith("WDJB-MJHT")
  expect(openExternal).toHaveBeenCalledWith("https://github.com/login/device")

  rerender({ connection: connected })

  expect(result.current.pending).toBeNull()
  expect(result.current.failure).toBeNull()
})

test.each([
  ["denied", "Cancelaste la conexión en GitHub. Vuelve a intentarlo desde Clanker Yard."],
  ["expired", "El código de GitHub venció sin que lo aprobaras: vuelve a intentarlo."],
])("cuando el core avisa que GitHub lo rechazó (%s) deja de esperar de inmediato, sin llegar al plazo del código", async (reason, message) => {
  const { result } = renderHook(() => useGitHubDeviceFlow(undefined, () => {}), { wrapper: wrapper(() => Promise.resolve(flow), { openExternal: vi.fn() }) })
  await act(() => result.current.start())

  await act(async () => {
    emit(loginFailed(1, reason, message))
    await vi.advanceTimersByTimeAsync(0)
  })

  expect(result.current.pending).toBeNull()
  expect(result.current.failure).toEqual({ reason, message })
})

test("un fallo que llega sin un código esperando (de otro flujo, ya cancelado) no se muestra", async () => {
  const { result } = renderHook(() => useGitHubDeviceFlow(undefined, () => {}), { wrapper: wrapper(() => Promise.resolve(flow), { openExternal: vi.fn() }) })

  await act(async () => {
    emit(loginFailed(1, "denied", "Cancelaste"))
    await vi.advanceTimersByTimeAsync(0)
  })

  expect(result.current.failure).toBeNull()
})

test("si el código vence sin que la conexión cambie, deja de esperar y lo dice", async () => {
  const { result } = renderHook(() => useGitHubDeviceFlow(undefined, () => {}), { wrapper: wrapper(() => Promise.resolve(flow), { openExternal: vi.fn() }) })
  await act(() => result.current.start())

  act(() => {
    vi.advanceTimersByTime(15 * 60_000)
  })

  expect(result.current.pending).toBeNull()
  expect(result.current.failure).toMatchObject({ reason: "expired", message: expect.stringMatching(/código venció/) })
})
