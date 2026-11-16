// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, expect, test, vi } from "vitest"
import { AppDataProvider } from "@/app-data"
import { useLinearLogin } from "@/hooks/use-linear-login"
import { HostProvider, type Host } from "@/host"
import { createMemoryAppData } from "@/memory-app-data"

afterEach(cleanup)

const wrapper = (linearAuth: () => Promise<string>, host: Partial<Host> = {}) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <HostProvider value={host as Host}>
        <AppDataProvider value={{ ...createMemoryAppData(Date.parse("2026-11-15T12:00:00Z")), linearAuth }}>{children}</AppDataProvider>
      </HostProvider>
    )
  }

test("si el core rechaza linearAuth (puerto ocupado), el mensaje con el paso a seguir queda en error y no se abre el navegador", async () => {
  const message = "El puerto 48721 está ocupado: ciérralo y vuelve a intentar."
  const openExternal = vi.fn()
  const { result } = renderHook(() => useLinearLogin([], () => {}), { wrapper: wrapper(() => Promise.reject(new Error(message)), { openExternal }) })

  await act(() => result.current.start())

  expect(result.current.error).toBe(message)
  expect(result.current.pending).toBeNull()
  expect(openExternal).not.toHaveBeenCalled()
})
