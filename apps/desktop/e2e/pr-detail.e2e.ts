import type { ElectronApplication, Page } from "@playwright/test";
import { expect, setTheme, snap, test } from "./harness";

test.use({ scenario: "prs" });
test.describe.configure({ mode: "serial" });

const TITLE = "Lint de imports entre engines";
const COMMIT = "feat: lint de imports entre engines";
const FILE = "lint.txt";
const URL = "https://github.com/octocat/demo/pull/1";
const card = (page: Page) => page.getByRole("group", { name: `#1 ${TITLE}`, exact: true });
const heading = (page: Page) => page.getByRole("heading", { level: 1, name: TITLE, exact: true });
const openedUrls = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as { remotePrOpenedUrls?: string[] }).remotePrOpenedUrls ?? []);

async function snapBoth(page: Page, view: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await snap(page, view, theme);
  }
}

async function openStacks(page: Page): Promise<void> {
  await page.locator("[data-sidebar=sidebar]").getByRole("button", { name: /Stacks de PR/ }).click();
  await expect(page.getByRole("heading", { name: "Stacks de PR", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Grafo", exact: true }).click();
  await expect(card(page)).toBeVisible({ timeout: 30_000 });
}

async function openRemotePr(page: Page): Promise<void> {
  await openStacks(page);
  await card(page).focus();
  await card(page).press("Enter");
  await expect(heading(page)).toBeVisible();
}

test.beforeAll(async ({ app }) => {
  await app.evaluate(({ ipcMain }) => {
    const state = globalThis as { remotePrOpenedUrls?: string[] };
    state.remotePrOpenedUrls = [];
    ipcMain.on("host:open-external", (_event, url: string) => state.remotePrOpenedUrls!.push(url));
  });
});

test("Enter abre el remoto dentro de la app con su descripción y número en el breadcrumb; Esc vuelve", async ({ app, window: page }) => {
  await openRemotePr(page);

  await expect(page.getByRole("navigation", { name: "Ubicación" })).toContainText("demo#1");
  await expect(page.getByRole("heading", { name: "Qué cambia", exact: true })).toBeVisible();
  await expect(page.getByText("Agrega 40 casos de imports entre engines", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Cómo revisarlo", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Commits 1", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Archivos 1", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Abrir en GitHub", exact: true })).toBeVisible();
  await snapBoth(page, "pr-remoto-descripcion");
  expect(await openedUrls(app)).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Stacks de PR", exact: true })).toBeVisible();
  await expect(heading(page)).toHaveCount(0);
});

test("un clic en el grafo abre el detalle y atrás y adelante recuperan la ubicación interna", async ({ app, window: page }) => {
  await openStacks(page);
  await card(page).getByRole("heading", { name: TITLE, exact: true }).click();
  await expect(heading(page)).toBeVisible();

  await page.keyboard.press("Meta+ArrowLeft");
  await expect(page.getByRole("heading", { name: "Stacks de PR", exact: true })).toBeVisible();
  await expect(heading(page)).toHaveCount(0);

  await page.keyboard.press("Meta+ArrowRight");
  await expect(heading(page)).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Ubicación" })).toContainText("demo#1");
  expect(await openedUrls(app)).toEqual([]);
});

test("la lista abre el mismo remoto con clic y con Enter, sin abrir GitHub", async ({ app, window: page }) => {
  await openStacks(page);
  await page.getByRole("tab", { name: "Lista", exact: true }).click();
  const row = page.getByRole("listitem").filter({ hasText: TITLE });
  const button = row.getByRole("button");
  await button.click();
  await expect(heading(page)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(row).toBeVisible();
  await button.focus();
  await button.press("Enter");
  await expect(heading(page)).toBeVisible();
  expect(await openedUrls(app)).toEqual([]);
});

test("el commit remoto se puede revisar por separado y A vuelve al diff completo", async ({ window: page }) => {
  await openRemotePr(page);
  await page.getByRole("tab", { name: "Commits 1", exact: true }).click();
  const commits = page.getByRole("listitem").filter({ hasText: COMMIT });
  await expect(commits).toHaveCount(1);
  await expect(commits.getByRole("button")).toContainText(COMMIT);
  await snapBoth(page, "pr-remoto-commits");

  await commits.getByRole("button").click();
  const files = page.getByTestId("local-pr-files");
  await expect(files.getByRole("region", { name: FILE, exact: true })).toBeVisible();
  await expect(files.locator("tr[data-kind='add']")).toHaveCount(40);
  await expect(page.getByRole("combobox", { name: "Qué commits ver" })).toContainText(COMMIT);
  await expect(page.getByRole("button", { name: "Anterior", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Siguiente", exact: true })).toBeDisabled();

  await page.keyboard.press("a");
  await expect(page.getByRole("combobox", { name: "Qué commits ver" })).toContainText("Todos los commits (1)");
  await expect(files.getByRole("region")).toHaveCount(1);
  await expect(files.locator("tr[data-kind='add']")).toHaveCount(40);
});

test("Archivos muestra las 40 líneas y la barra del diff permanece sobre el área de scroll", async ({ window: page }) => {
  await openRemotePr(page);
  await page.getByRole("tab", { name: "Archivos 1", exact: true }).click();
  const files = page.getByTestId("local-pr-files");
  const file = files.getByRole("region", { name: FILE, exact: true });
  const toolbar = page.getByTestId("local-pr-files-toolbar");
  await expect(file).toBeVisible();
  await expect(file.locator("tr[data-kind='add']")).toHaveCount(40);
  await expect(file.getByText("lint.txt 0", { exact: true })).toBeVisible();
  await expect(file.getByText("lint.txt 39", { exact: true })).toHaveCount(1);
  await snapBoth(page, "pr-remoto-archivos");

  expect(await files.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  const before = (await toolbar.boundingBox())!;
  await files.evaluate((el) => el.scrollBy(0, 1200));
  await expect.poll(() => files.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  const after = (await toolbar.boundingBox())!;
  expect(after.y).toBe(before.y);
  const scroller = (await files.boundingBox())!;
  expect(scroller.y).toBeGreaterThanOrEqual(after.y + after.height - 1);
  const tabs = (await page.getByRole("tablist").boundingBox())!;
  expect(after.y).toBeGreaterThanOrEqual(tabs.y + tabs.height);
  await expect(file.getByText("lint.txt 39", { exact: true })).toBeInViewport();
});

test("S muestra el remoto lado a lado con ambos lados del mismo ancho", async ({ window: page }) => {
  await openRemotePr(page);
  await page.getByRole("tab", { name: "Archivos 1", exact: true }).click();
  const file = page.getByTestId("local-pr-files").getByRole("region", { name: FILE, exact: true });
  await expect(file.locator("tr[data-kind='add']")).toHaveCount(40);
  await page.keyboard.press("s");

  const pairs = file.locator("tr[data-kind='pair']");
  await expect(pairs).toHaveCount(40);
  const pair = pairs.first();
  await expect(pair.locator("td[data-side='old'][data-kind='empty']")).toHaveCount(1);
  await expect(pair.locator("td[data-side='new'][data-kind='add']")).toHaveText("1");
  const [left, right] = await Promise.all([pair.locator("td").nth(2).boundingBox(), pair.locator("td").nth(5).boundingBox()]);
  expect(Math.abs(left!.width - right!.width)).toBeLessThan(2);
  await snapBoth(page, "pr-remoto-lado-a-lado");

  await page.keyboard.press("s");
  await expect(file.locator("tr[data-kind='add']")).toHaveCount(40);
});

test("marcar el archivo remoto como visto lo pliega y recuerda el progreso al volver", async ({ window: page }) => {
  await openRemotePr(page);
  await page.getByRole("tab", { name: "Archivos 1", exact: true }).click();
  const file = page.getByTestId("local-pr-files").getByRole("region", { name: FILE, exact: true });
  await expect(file.locator("tr[data-kind='add']")).toHaveCount(40);
  await file.getByRole("checkbox", { name: `Marcar ${FILE} como visto` }).click();
  await expect(page.getByText("1 de 1 archivos vistos", { exact: true })).toBeVisible();
  await expect(file.locator("tr")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await openRemotePr(page);
  await page.getByRole("tab", { name: "Archivos 1", exact: true }).click();
  await expect(page.getByText("1 de 1 archivos vistos", { exact: true })).toBeVisible();
  await expect(file.getByRole("checkbox", { name: `Marcar ${FILE} como visto` })).toBeChecked();
  await expect(file.locator("tr")).toHaveCount(0);
  await file.getByRole("checkbox", { name: `Marcar ${FILE} como visto` }).click();
  await expect(page.getByText("0 de 1 archivos vistos", { exact: true })).toBeVisible();
  await expect(file.locator("tr[data-kind='add']")).toHaveCount(40);
});

test("solo Abrir en GitHub, O o su acción de la paleta abren el navegador", async ({ app, window: page }) => {
  await openRemotePr(page);
  expect(await openedUrls(app)).toEqual([]);

  await page.getByRole("button", { name: "Abrir en GitHub", exact: true }).click();
  await expect.poll(() => openedUrls(app)).toEqual([URL]);
  await expect(heading(page)).toBeVisible();

  await page.keyboard.press("o");
  await expect.poll(() => openedUrls(app)).toEqual([URL, URL]);
  await expect(heading(page)).toBeVisible();

  await page.getByRole("button", { name: /Buscar/ }).first().click();
  await page.getByPlaceholder("Busca un proyecto, una corrida o una acción…").fill("github");
  await page.getByRole("option", { name: /Abrir PR en GitHub/ }).click();
  await expect.poll(() => openedUrls(app)).toEqual([URL, URL, URL]);
  await expect(heading(page)).toBeVisible();
});
