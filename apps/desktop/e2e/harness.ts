import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, type ElectronApplication, expect, type Page, test as base } from "@playwright/test";
import { type DemoCore, type DemoScenario, startDemoCore } from "./demo-core";

const desktopDir = join(import.meta.dirname, "..");
const screensDir = join(desktopDir, "out/screens");

export type Theme = "light" | "dark";

// Cada archivo elige el escenario del core de demo con `test.use({ scenario })`: un escenario distinto es otro worker, con su propia app.
export const test = base.extend<object, { scenario: DemoScenario; home: string; app: ElectronApplication; window: Page }>({
  scenario: ["default", { option: true, scope: "worker" }],
  home: [
    async ({}, use) => {
      const home = mkdtempSync(join(tmpdir(), "clanker-e2e-"));
      try {
        await use(home);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    { scope: "worker" },
  ],
  // La app y su core de demo viven todo el archivo: cada test sigue donde dejó la ventana el anterior.
  app: [
    async ({ home, scenario }, use) => {
      let core: DemoCore | undefined;
      let app: ElectronApplication | undefined;
      try {
        core = await startDemoCore(home, scenario);
        const env = { ...process.env, CLANKER_HOME: home, CORE_RUNTIME: "fake" } as Record<string, string>;
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({
          cwd: desktopDir,
          args: [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
          env,
        });
        await use(app);
      } finally {
        await app?.close();
        await core?.stop();
      }
    },
    { scope: "worker" },
  ],
  window: [
    async ({ app }, use) => {
      const page = await app.firstWindow();
      // Tamaño fijo: los screenshots no dependen de la pantalla del runner.
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
      await use(page);
    },
    { scope: "worker" },
  ],
});

// Playwright fija `prefers-color-scheme` en la ventana, así que el tema se cambia con `emulateMedia`; `nativeTheme` no lo mueve.
export async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.emulateMedia({ colorScheme: theme });
  await expect(page.locator("html")).toHaveClass(theme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
}

export async function snap(page: Page, view: string, theme: Theme): Promise<void> {
  mkdirSync(screensDir, { recursive: true });
  await page.screenshot({ path: join(screensDir, `${view}-${theme}.png`), animations: "disabled" });
}

export { expect };
