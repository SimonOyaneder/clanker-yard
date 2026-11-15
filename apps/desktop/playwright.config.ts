import { defineConfig } from "@playwright/test";

// El E2E arranca la app construida (`out/`) contra un core de demo; `npm run e2e` lo prepara todo.
// Los archivos se llaman `*.e2e.ts` para que Vitest (que corre `*.spec.ts`) no los tome.
export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  outputDir: "out/e2e-results",
  // Una sola app Electron compartida y en orden: cada test sigue donde dejó la ventana el anterior.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
});
