import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, type ElectronApplication, expect, type Page, test as base } from "@playwright/test";
import { type DemoCore, startDemoCore } from "./demo-core";

const desktopDir = join(import.meta.dirname, "..");
const screensDir = join(desktopDir, "out/screens");

type Theme = "light" | "dark";

const test = base.extend<object, { app: ElectronApplication; window: Page }>({
  // La app y su core de demo viven todo el archivo: cada test sigue donde dejó la ventana el anterior.
  app: [
    async ({}, use) => {
      const home = mkdtempSync(join(tmpdir(), "clanker-e2e-"));
      let core: DemoCore | undefined;
      let app: ElectronApplication | undefined;
      try {
        core = await startDemoCore(home);
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
        rmSync(home, { recursive: true, force: true });
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
async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.emulateMedia({ colorScheme: theme });
  await expect(page.locator("html")).toHaveClass(theme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
}

async function snap(page: Page, view: string, theme: Theme): Promise<void> {
  mkdirSync(screensDir, { recursive: true });
  await page.screenshot({ path: join(screensDir, `${view}-${theme}.png`), animations: "disabled" });
}

// La fila de la corrida de "Saluda al mundo" (la de la cola no tiene el pill del flujo).
const finishedRun = (page: Page) => page.getByRole("listitem").filter({ hasText: "Saluda al mundo" }).filter({ hasText: /juguete v\d+/ });

const sidebar = (page: Page) => page.locator("[data-sidebar=sidebar]");

test.describe.configure({ mode: "serial" });

test("la app se conecta al core de demo", async ({ window: page }) => {
  await expect(page.getByText("Clanker Yard", { exact: true })).toBeVisible();
  await expect(sidebar(page).getByRole("button", { name: "Demo" })).toBeVisible();
});

test("crea un proyecto desde el diálogo", async ({ window: page }) => {
  await page.getByRole("button", { name: "Nuevo proyecto" }).click();
  const dialog = page.getByRole("dialog", { name: "Nuevo proyecto" });
  await dialog.getByLabel("Nombre").fill("Proyecto E2E");
  await expect(dialog.getByLabel("Slug")).toHaveValue("proyecto-e2e");
  await dialog.getByRole("button", { name: "Crear proyecto" }).click();

  await expect(dialog).toBeHidden();
  await expect(sidebar(page).getByRole("button", { name: "Proyecto E2E" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Proyecto E2E" })).toBeVisible();
  await expect(page.getByText("Todavía no hay corridas")).toBeVisible();
});

test("corre la plantilla de juguete hasta que la corrida queda lista", async ({ window: page }) => {
  await sidebar(page).getByRole("button", { name: "Demo" }).click();
  await expect(page.getByRole("heading", { name: "Demo" })).toBeVisible();

  await page.getByRole("listitem").filter({ hasText: "Saluda al mundo" }).getByRole("button", { name: "Correr" }).click();

  // Las corridas del runtime fake duran unos 7 s.
  await expect(finishedRun(page).getByText("lista", { exact: true })).toBeVisible({ timeout: 30_000 });
});

test("screenshots de cada vista en claro y oscuro", async ({ window: page }) => {
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);

    await sidebar(page).getByRole("button", { name: "Demo" }).click();
    await expect(page.getByRole("heading", { name: "Demo" })).toBeVisible();
    await snap(page, "proyecto", theme);

    await finishedRun(page).getByRole("button").click();
    await expect(page.getByText("Línea de tiempo")).toBeVisible();
    await expect(page.getByText("terminó el flujo")).toBeVisible();
    await snap(page, "corrida", theme);

    await sidebar(page).getByRole("button", { name: "Proyecto E2E" }).click();
    await expect(page.getByText("Todavía no hay corridas")).toBeVisible();
    await snap(page, "proyecto-vacio", theme);

    await sidebar(page).getByRole("button", { name: "Stacks de PR" }).click();
    await expect(page.getByRole("button", { name: "Stacks de PR" }).first()).toBeVisible();
    await snap(page, "prs", theme);

    await page.getByRole("button", { name: "Nuevo proyecto" }).click();
    await expect(page.getByRole("dialog", { name: "Nuevo proyecto" })).toBeVisible();
    await snap(page, "nuevo-proyecto", theme);
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Atajos de teclado" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await snap(page, "atajos", theme);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
  }
});
