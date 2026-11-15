// @vitest-environment jsdom
import type { Connection, GitHubDeviceFlow } from "@clanker/api"
import { act, cleanup, renderHook } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { AppDataProvider } from "@/app-data"
import { useGitHubDeviceFlow } from "@/hooks/use-github-device-flow"
import { HostProvider, type Host } from "@/host"
import { createMemoryAppData } from "@/memory-app-data"

const NOW = Date.parse("2026-11-15T12:00:00Z")
const flow: GitHubDeviceFlow = { userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresIn: 900 }
const connected: Connection = { provider: "github", account: "octocat", scopes: [], status: "active", auth: "app", expiresAt: NOW + 183 * 86_400_000 }

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const wrapper = (startGithubDeviceFlow: () => Promise<GitHubDeviceFlow>, host: Partial<Host> = {}) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <HostProvider value={host as Host}>
        <AppDataProvider value={{ ...createMemoryAppData(NOW), startGithubDeviceFlow }}>{children}</AppDataProvider>
      </HostProvider>
    )
  }

test("si el core rechaza el inicio (falta el client_id), el mensaje con el paso a seguir queda en error y no se abre el navegador", async () => {
  const message = 'Falta el client_id de la GitHub App. Ponlo en config.json como { "githubApp": { "clientId": "Iv..." } }.'
  const openExternal = vi.fn()
  const { result } = renderHook(() => useGitHubDeviceFlow(undefined, () => {}), { wrapper: wrapper(() => Promise.reject(new Error(message)), { openExternal }) })

  await act(() => result.current.start())

  expect(result.current.error).toBe(message)
  expect(result.current.pending).toBeNull()
  expect(openExternal).not.toHaveBeenCalled()
})

test("muestra el código y abre github.com mientras espera; al cambiar la conexión termina", async () => {
  const openExternal = vi.fn()
  const { result, rerender } = renderHook(({ connection }: { connection: Connection | undefined }) => useGitHubDeviceFlow(connection, () => {}), {
    wrapper: wrapper(() => Promise.resolve(flow), { openExternal }),
    initialProps: { connection: undefined as Connection | undefined },
  })

  await act(() => result.current.start())

  expect(result.current.pending).toEqual(flow)
  expect(openExternal).toHaveBeenCalledWith("https://github.com/login/device")

  rerender({ connection: connected })

  expect(result.current.pending).toBeNull()
  expect(result.current.error).toBeNull()
})

test("si el código vence sin que la conexión cambie, deja de esperar y lo dice", async () => {
  const { result } = renderHook(() => useGitHubDeviceFlow(undefined, () => {}), { wrapper: wrapper(() => Promise.resolve(flow), { openExternal: vi.fn() }) })
  await act(() => result.current.start())

  act(() => {
    vi.advanceTimersByTime(15 * 60_000)
  })

  expect(result.current.pending).toBeNull()
  expect(result.current.error).toMatch(/código venció/)
})
