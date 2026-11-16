// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import { AppDataProvider } from "@/app-data"
import { ReposTable } from "@/components/connections/repos-table"
import { TooltipProvider } from "@/components/ui/tooltip"
import { HostProvider, type Host } from "@/host"
import { createMemoryAppData } from "@/demo/memory-app-data"

afterEach(cleanup)

function setup(pickDirectory?: Host["pickDirectory"]) {
  const data = createMemoryAppData(Date.parse("2026-11-15T12:00:00Z"))
  const addRepo = vi.spyOn(data, "addRepo")
  const onAdded = vi.fn()
  const host = { openExternal: vi.fn(), openInEditor: vi.fn(), pickDirectory } as unknown as Host
  render(
    <AppDataProvider value={data}>
      <HostProvider value={host}>
        <TooltipProvider>
          <ReposTable rows={[]} onTest={() => {}} onAdded={onAdded} />
        </TooltipProvider>
      </HostProvider>
    </AppDataProvider>,
  )
  return { addRepo, onAdded }
}

const addButton = () => screen.getAllByRole("button", { name: /Agregar repo/ })[0]!

test("con selector nativo Agregar repo lo abre y registra la carpeta elegida sin diálogo", async () => {
  const pickDirectory = vi.fn().mockResolvedValue("/Users/ana/code/api")
  const { addRepo, onAdded } = setup(pickDirectory)

  fireEvent.click(addButton())

  await waitFor(() => expect(addRepo).toHaveBeenCalledWith("/Users/ana/code/api"))
  await waitFor(() => expect(onAdded).toHaveBeenCalled())
  expect(screen.queryByRole("dialog")).toBeNull()
})

test("cancelar el selector no registra nada", async () => {
  const pickDirectory = vi.fn().mockResolvedValue(null)
  const { addRepo } = setup(pickDirectory)

  fireEvent.click(addButton())

  await waitFor(() => expect(pickDirectory).toHaveBeenCalled())
  expect(addRepo).not.toHaveBeenCalled()
  expect(screen.queryByRole("dialog")).toBeNull()
})

test("si el registro falla muestra el error y deja elegir otra carpeta", async () => {
  const pickDirectory = vi.fn().mockResolvedValueOnce("/Users/ana/code/api").mockResolvedValueOnce("/Users/ana/code/web")
  const { addRepo } = setup(pickDirectory)
  addRepo.mockRejectedValueOnce(new Error("No es un checkout de git."))

  fireEvent.click(addButton())

  expect((await screen.findByRole("alert")).textContent).toContain("No es un checkout de git.")
  fireEvent.click(screen.getByRole("button", { name: /Elegir otra carpeta/ }))
  await waitFor(() => expect(addRepo).toHaveBeenLastCalledWith("/Users/ana/code/web"))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
})

test("sin selector el diálogo pide la ruta y un owner/repo de GitHub explica que se pide la carpeta local", async () => {
  const { addRepo } = setup()
  addRepo.mockRejectedValueOnce(new Error("No existe la carpeta /acme/api."))

  fireEvent.click(addButton())
  expect(screen.queryByRole("button", { name: /Elegir/ })).toBeNull()
  fireEvent.change(screen.getByLabelText("Ruta del repo"), { target: { value: "/acme/api" } })
  fireEvent.click(screen.getByRole("button", { name: "Agregar" }))

  const alert = await screen.findByRole("alert")
  expect(alert.textContent).toContain("carpeta local")
  expect(alert.textContent).toContain("/acme/api")
})

test("con selector, Escribir la ruta abre el diálogo de texto", () => {
  setup(vi.fn())

  fireEvent.click(screen.getByRole("button", { name: "Escribir la ruta" }))

  expect(screen.getByLabelText("Ruta del repo")).toBeTruthy()
  expect(screen.getByRole("button", { name: /Elegir otra carpeta/ })).toBeTruthy()
})
