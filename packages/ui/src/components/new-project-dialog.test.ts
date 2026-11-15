import { expect, test } from "vitest"
import { slugOf } from "./new-project-dialog"

test("el slug sale del nombre sin tildes, en minúsculas y con guiones", () => {
  expect(slugOf("Boundaries de engines")).toBe("boundaries-de-engines")
  expect(slugOf("  Limpieza: ¡feature flags! ")).toBe("limpieza-feature-flags")
  expect(slugOf("Añejo Café")).toBe("anejo-cafe")
})
