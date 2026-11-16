// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import { SetupProgress } from "@/components/setup-checklist"
import { setupSteps } from "@/lib/setup"

afterEach(cleanup)

test("el pie dice cuántos pasos van, abre la lista y cada paso lleva a hacerlo", async () => {
  const onStep = vi.fn()
  render(<SetupProgress steps={setupSteps({ connections: [{ provider: "github" }], repos: 1, projects: 0 })} onStep={onStep} />)

  fireEvent.click(screen.getByRole("button", { name: /Configuración\s*2\/5/ }))
  const items = (await screen.findByRole("list", { name: "Configuración" })).querySelectorAll("li")
  expect(items).toHaveLength(5)
  fireEvent.click(screen.getByRole("button", { name: /Conectar Linear/ }))
  expect(onStep).toHaveBeenCalledWith("linear")
})

test("con todo configurado desaparece", () => {
  const { container } = render(<SetupProgress steps={setupSteps({ connections: [{ provider: "github" }, { provider: "linear" }, { provider: "claude" }], repos: 1, projects: 1 })} onStep={vi.fn()} />)
  expect(container.innerHTML).toBe("")
})
