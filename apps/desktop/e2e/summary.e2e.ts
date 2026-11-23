import { createClient } from "@clanker/api";
import { readCoreJson } from "@clanker/api/node";
import type { Page } from "@playwright/test";
import { expect, setTheme, snap, test } from "./harness";

// El Resumen contra el escenario `summary` del core de demo (`packages/testkit/src/summary-scenario.ts`): lo importado del
// clanker-loop (`fixtures/legacy`) y corridas de Yard del flujo `de-issue-a-pr` en el mismo proyecto.
test.use({ scenario: "summary" });
test.describe.configure({ mode: "serial" });

const sidebar = (page: Page) => page.locator("[data-sidebar=sidebar]");
const card = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const tile = (page: Page, label: string) => page.getByRole("region", { name: "Métricas" }).getByText(label, { exact: true }).locator("xpath=..");
const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

async function snapBoth(page: Page, view: string): Promise<void> {
  const hideToasts = await page.addStyleTag({ content: "[data-sonner-toaster] { visibility: hidden !important; }" });
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await snap(page, view, theme);
  }
  await hideToasts.evaluate((style: Element) => style.remove());
}

test.beforeAll(async ({ app, window: page }) => {
  // El Resumen es largo: la ventana crece para que cada captura traiga todas sus tarjetas.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 1500));
  await sidebar(page).getByRole("button", { name: /Lote demo/ }).click();
  await expect(page.getByRole("heading", { name: "Lote demo" })).toBeVisible();
});

test("el Resumen abre desde la pestaña y sus totales son los de projects.summary", async ({ window: page, home }) => {
  const info = readCoreJson(home)!;
  const client = createClient({ url: `http://127.0.0.1:${info.port}/rpc`, token: info.token, origin: "cli" });
  const project = (await client.projects.list()).find((p) => p.slug === "demo-lote-0a1b2c3d4e5f")!;
  const summary = await client.projects.summary({ id: project.id });

  await page.getByRole("tab", { name: "Resumen" }).click();

  await expect(tile(page, "Gasto total")).toContainText(usd(summary.costMicros));
  await expect(tile(page, "Corridas cerradas")).toContainText(String(summary.runs));
  await expect(tile(page, "Costo por corrida")).toContainText(usd(Math.round(summary.avgCostMicros!)));
  // Cada rol sale con el gasto exacto del core, de mayor a menor.
  const bars = card(page, "Gasto por rol").getByRole("img");
  await expect(bars).toHaveCount(summary.byRole.length);
  for (const [i, role] of summary.byRole.entries()) await expect(bars.nth(i)).toHaveAccessibleName(new RegExp(`^${role.role}: \\${usd(role.costMicros)},`));
  // Lo importado y lo nuevo conviven: gasto por paso solo de Yard, rondas por issue de las dos fuentes.
  await expect(card(page, "Gasto por paso del flujo").getByRole("img").first()).toHaveAccessibleName(/^implement:/);
  await expect(card(page, "Rondas por issue").getByRole("row").filter({ hasText: "DEMO-4" })).toContainText("review 4 · bot 3 · ci 2 · external 1");

  await snapBoth(page, "resumen");
});

test("al pasar el mouse por una barra el tooltip dice rol, gasto y tokens", async ({ window: page }) => {
  await card(page, "Gasto por rol").getByRole("img").first().hover();

  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText("dev");
  await expect(tooltip).toContainText("tokens");
  await snapBoth(page, "resumen-tooltip");
  await page.mouse.move(0, 0);
});

test("el origen separa lo importado del clanker-loop de lo que corrió Yard, y cada rol conserva su color", async ({ window: page }) => {
  const swatchOf = async (role: string) =>
    card(page, "Gasto por rol")
      .getByRole("img", { name: new RegExp(`^${role}:`) })
      .locator("span > span")
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
  const devColor = await swatchOf("dev");

  await page.getByRole("radio", { name: "Importadas" }).click();
  await expect(tile(page, "Corridas cerradas")).toContainText("5");
  await expect(card(page, "Gasto por paso del flujo")).toContainText("no guardan sus pasos");
  expect(await swatchOf("dev")).toBe(devColor);
  await snapBoth(page, "resumen-importadas");

  await page.getByRole("radio", { name: "Yard" }).click();
  await expect(tile(page, "Corridas cerradas")).toContainText("4");
  await expect(card(page, "Gasto por rol").getByRole("img", { name: /^techlead:/ })).toHaveCount(0);
  expect(await swatchOf("dev")).toBe(devColor);
  await snapBoth(page, "resumen-yard");
});

test("T cambia los gráficos por sus tablas, O cambia el origen y ⇧⌘1 vuelve a Operación", async ({ window: page }) => {
  await page.getByRole("radio", { name: "Todas" }).click();
  await page.keyboard.press("t");
  await expect(card(page, "Gasto por día").getByRole("table")).toBeVisible();
  await expect(card(page, "Gasto por rol").getByRole("table")).toBeVisible();
  await snapBoth(page, "resumen-tablas");
  await page.keyboard.press("t");
  await expect(card(page, "Gasto por rol").getByRole("table")).toHaveCount(0);

  await page.keyboard.press("o");
  await expect(page.getByRole("radio", { name: "Importadas" })).toBeChecked();
  await page.keyboard.press("o");
  await page.keyboard.press("o");
  await expect(page.getByRole("radio", { name: "Todas" })).toBeChecked();

  await page.keyboard.press("Meta+Shift+1");
  await expect(page.getByRole("tab", { name: "Operación" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Meta+Shift+2");
  await expect(page.getByRole("tab", { name: "Resumen" })).toHaveAttribute("aria-selected", "true");
});

test("un rango personalizado sin cierres dice por qué y ofrece volver a todo el historial", async ({ window: page }) => {
  await page.getByRole("combobox", { name: "Rango de fechas" }).click();
  await page.getByRole("option", { name: "Personalizado" }).click();
  await page.getByLabel("Desde").fill("2026-01-01");
  await page.getByLabel("Hasta").fill("2026-01-31");
  await expect(page.getByText(/No cerró ninguna corrida con este rango/)).toBeVisible();
  await snapBoth(page, "resumen-vacio");

  await page.getByRole("button", { name: "Ver todo el historial" }).click();
  await expect(tile(page, "Corridas cerradas")).toContainText("9");
});
