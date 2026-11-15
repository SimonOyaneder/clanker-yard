import type { Locator, Page } from "@playwright/test";
import { expect, setTheme, snap, test } from "./harness";

// Stacks de PR contra el escenario `prs` del core de demo (`packages/testkit/src/prs-scenario.ts`): PRs en el GitHub
// simulado con el pack de ejemplo, leídos por el core (`prs.refresh`) y servidos por `prs.list`.
test.use({ scenario: "prs" });
test.describe.configure({ mode: "serial" });

const sidebar = (page: Page) => page.locator("[data-sidebar=sidebar]");
const row = (page: Page, title: string) => page.getByRole("listitem").filter({ hasText: title });

// Abre el menú contextual sin soltar un botón del mouse: Radix selecciona el ítem que quede bajo el puntero al soltarlo, y un
// menú que se abre cerca del borde de la ventana se corre justo debajo de él (y "Abrir PR en GitHub" abriría el navegador).
async function openMenu(target: Locator): Promise<void> {
  const button = target.getByRole("button");
  const box = (await button.boundingBox())!;
  await button.dispatchEvent("contextmenu", { button: 2, clientX: box.x + 60, clientY: box.y + box.height / 2 });
}

async function snapBoth(page: Page, view: string): Promise<void> {
  // Los toasts de la acción anterior taparían la captura.
  const hideToasts = await page.addStyleTag({ content: "[data-sonner-toaster] { visibility: hidden !important; }" });
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await snap(page, view, theme);
  }
  await hideToasts.evaluate((style: Element) => style.remove());
}

test("el grafo muestra los PRs del core con riesgo alto, en cola, la cola caída, hold y la base combinada", async ({ window: page }) => {
  await sidebar(page).getByRole("button", { name: /Stacks de PR/ }).click();
  await expect(page.getByRole("heading", { name: "Stacks de PR" })).toBeVisible();

  // Los 9 PRs que el escenario siembra, cada uno una tarjeta del grafo.
  await expect(page.locator(".react-flow__node")).toHaveCount(9, { timeout: 30_000 });
  const card = (title: string) => page.getByRole("link", { name: new RegExp(title) });
  await expect(card("Renombrar Payments::Ledger").getByText("Riesgo alto")).toBeVisible();
  await expect(card("Arreglar el scroll").getByText("En cola")).toBeVisible();
  await expect(card("Migrar el job de conciliación").getByText("Cola falló")).toBeVisible();
  await expect(card("Migrar los tooltips").getByText("Hold")).toBeVisible();
  await expect(card("Lint de imports").getByText("Listo para merge")).toBeVisible();
  await expect(card("Pantalla de resumen del pago").getByText("Sin riesgo")).toBeVisible();
  await expect(card("Cerrar la conciliación").getByText("Base combinada")).toBeVisible();
  // Las señales salen del pack: sin el riesgo (que es de un label) en la tarjeta del stack se ve el de cada nivel.
  await expect(card("Agregar checks de boundaries").getByText("Riesgo bajo")).toBeVisible();

  await snapBoth(page, "stacks-grafo");
});

test("la base combinada explica en su tooltip de quién sale", async ({ window: page }) => {
  const chip = page.getByRole("link", { name: /Cerrar la conciliación/ }).getByText("Base combinada");
  await chip.hover();
  await expect(page.getByRole("tooltip").first()).toContainText("rama sintética que junta a");
  await expect(page.getByRole("tooltip").first()).toContainText("demo#4");
  await expect(page.getByRole("tooltip").first()).toContainText("demo#5");
  await snapBoth(page, "stacks-base-combinada");
  await page.mouse.move(0, 0);
});

test("la lista agrupa los stacks y la señal del pack filtra por nivel", async ({ window: page }) => {
  await page.getByRole("tab", { name: "Lista" }).click();
  await expect(row(page, "Lint de imports entre engines")).toBeVisible();
  await snapBoth(page, "stacks-lista");

  await page.getByRole("group", { name: "Señales" }).getByRole("button", { name: /Riesgo alto/ }).click();
  await expect(row(page, "Renombrar Payments::Ledger")).toBeVisible();
  await expect(row(page, "Arreglar el scroll")).toBeHidden();
  await page.getByRole("group", { name: "Señales" }).getByRole("button", { name: /Riesgo alto/ }).click();
});

test("marcar y quitar hold desde el menú contextual lo escribe en el core", async ({ window: page }) => {
  const radix = row(page, "Migrar los tooltips a Radix");
  await expect(radix.getByText("Hold")).toBeVisible();

  await openMenu(radix);
  await page.getByRole("menuitem", { name: "Quitar hold" }).click();
  await expect(radix.getByText("Listo para merge")).toBeVisible();

  await openMenu(radix);
  await page.getByRole("menuitem", { name: /Marcar hold/ }).click();
  await expect(radix.getByText("Hold")).toBeVisible();
});

test("mergear confirma, comenta el comando del pack y el PR pasa a en cola", async ({ window: page }) => {
  const lint = row(page, "Lint de imports entre engines");
  await openMenu(lint);
  await page.getByRole("menuitem", { name: /^Mergear…/ }).click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByText("¿Mergear demo#1?")).toBeVisible();
  await expect(dialog.getByText("/merge", { exact: true })).toBeVisible();
  await snapBoth(page, "stacks-confirmar-merge");
  await dialog.getByRole("button", { name: "Mergear" }).click();

  await expect(lint.getByText("En cola")).toBeVisible();
  // Ya en cola no se vuelve a ofrecer: el ítem queda apagado.
  await openMenu(lint);
  await expect(page.getByRole("menuitem", { name: /^Mergear…/ })).toBeDisabled();
  await page.keyboard.press("Escape");
});

test("pedir review al bot avisa y ver corrida va a la corrida que abrió el PR", async ({ window: page }) => {
  const lint = row(page, "Lint de imports entre engines");
  await openMenu(lint);
  await page.getByRole("menuitem", { name: /Pedir review del bot/ }).click();
  await expect(page.getByText("Le pedí review al bot en demo#1")).toBeVisible();

  await openMenu(lint);
  await page.getByRole("menuitem", { name: /Ver corrida/ }).click();
  await expect(page.getByRole("group", { name: /Grafo del flujo juguete/ })).toBeVisible();
});
