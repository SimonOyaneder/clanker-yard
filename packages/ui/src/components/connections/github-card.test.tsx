// @vitest-environment jsdom
import type { Connection } from "@clanker/api"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import { AppDataProvider } from "@/app-data"
import { GitHubCard } from "@/components/connections/github-card"
import { TooltipProvider } from "@/components/ui/tooltip"
import { HostProvider, type Host } from "@/host"
import { createMemoryAppData } from "@/memory-app-data"

const NOW = Date.parse("2026-11-15T12:00:00Z")

afterEach(cleanup)

const pat: Connection = { provider: "github", account: "octocat", scopes: ["repo"], status: "active", expiresSoon: false, auth: "pat" }

function setup(connection: Connection | undefined, githubApp: boolean) {
  const data = createMemoryAppData(NOW)
  const info = data.coreInfo
  data.coreInfo = async () => ({ ...(await info()), githubApp })
  const openExternal = vi.fn()
  render(
    <AppDataProvider value={data}>
      <HostProvider value={{ openExternal } as unknown as Host}>
        <TooltipProvider>
          <GitHubCard connection={connection} onChanged={vi.fn()} />
        </TooltipProvider>
      </HostProvider>
    </AppDataProvider>,
  )
  return { openExternal }
}

test("sin la GitHub App configurada, el camino es el token: el botón principal abre el formulario y la App no se ofrece", async () => {
  const { openExternal } = setup(undefined, false)

  const create = await screen.findByRole("button", { name: "Crear token en GitHub" })
  await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(create)
  expect(openExternal).toHaveBeenCalledWith(expect.stringContaining("scopes=repo"))
  expect(screen.getByLabelText("Personal access token (classic)")).toBeTruthy()
  expect(screen.queryByRole("button", { name: /GitHub App/ })).toBeNull()
})

test("con un token pegado y sin la App, solo se reconecta con otro token", async () => {
  setup(pat, false)

  expect(await screen.findByRole("button", { name: "Reconectar" })).toBeTruthy()
  expect(screen.queryByRole("button", { name: /GitHub App/ })).toBeNull()
})

test("con la GitHub App configurada se ofrece conectarla o cambiarse a ella", async () => {
  setup(undefined, true)
  expect(await screen.findByRole("button", { name: "Conectar con la GitHub App" })).toBeTruthy()
  cleanup()

  setup(pat, true)
  expect(await screen.findByRole("button", { name: "Cambiar a la GitHub App" })).toBeTruthy()
})
