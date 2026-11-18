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

  await expect(page.locator(".react-flow__node")).toHaveCount(11, { timeout: 30_000 });
  const card = (title: string) => page.getByRole("group", { name: new RegExp(title) });
  await expect(card("Renombrar Payments::Ledger").getByText("Riesgo alto")).toBeVisible();
  await expect(card("Arreglar el scroll").getByText("En cola")).toBeVisible();
  await expect(card("Migrar el job de conciliación").getByText("Cola falló")).toBeVisible();
  await expect(card("Migrar los tooltips").getByText("Hold")).toBeVisible();
  await expect(card("Lint de imports").getByText("Listo para merge")).toBeVisible();
  await expect(card("Pantalla de resumen del pago").getByText("Sin riesgo")).toBeVisible();
  await expect(card("Cerrar la conciliación").getByText("Base combinada")).toBeVisible();
  // Las señales salen del pack: sin el riesgo (que es de un label) en la tarjeta del stack se ve el de cada nivel.
  await expect(card("Agregar checks de boundaries").getByText("Riesgo bajo")).toBeVisible();
  const local = page.getByRole("group", { name: "engine-rules-docs Documentar las reglas de boundaries" });
  await expect(local.getByText("Local", { exact: true })).toBeVisible();
  await expect(local.getByText("engine-rules-docs")).toBeVisible();
  await expect(local.getByRole("link")).toHaveCount(0);

  await snapBoth(page, "stacks-grafo");
});

test("el local explica cuándo se publica y actualizar solo relee los remotos", async ({ window: page }) => {
  const local = page.getByRole("group", { name: "engine-rules-docs Documentar las reglas de boundaries" });
  await local.getByText("Local", { exact: true }).hover();
  await expect(page.getByRole("tooltip").first()).toHaveText("Vive solo en tu máquina. Se publica en GitHub cuando se mergee engine-rules.");
  await snapBoth(page, "stacks-local");
  await page.mouse.move(0, 0);
  const previousRead = await page.locator("header time").getAttribute("datetime");
  await page.getByRole("button", { name: "Actualizar", exact: true }).click();
  await expect(page.locator("header time")).not.toHaveAttribute("datetime", previousRead!);
  await expect(page.getByText(/No pude actualizar/)).toHaveCount(0);
  await expect(local.getByText("Local", { exact: true })).toBeVisible();
});

test("la base combinada explica en su tooltip de quién sale", async ({ window: page }) => {
  const chip = page.getByRole("group", { name: /Cerrar la conciliación/ }).getByText("Base combinada");
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
  await expect(row(page, "Documentar las reglas").getByText("Local", { exact: true })).toBeVisible();
  await snapBoth(page, "stacks-lista");

  await page.getByRole("group", { name: "Señales" }).getByRole("button", { name: /Riesgo alto/ }).click();
  await expect(row(page, "Renombrar Payments::Ledger")).toBeVisible();
  await expect(row(page, "Arreglar el scroll")).toBeHidden();
  await page.getByRole("group", { name: "Señales" }).getByRole("button", { name: /Riesgo alto/ }).click();
});

test("el menú y la paleta de un local conservan ver corrida pero no acciones de GitHub", async ({ window: page }) => {
  const local = row(page, "Documentar las reglas de boundaries");
  await openMenu(local);
  await expect(page.getByRole("menuitem", { name: "Copiar branch" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Ver corrida/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /GitHub|Mergear|hold|review del bot|Rebasear|Copiar link/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Buscar/ }).first().click();
  await page.getByPlaceholder("Busca un proyecto, una corrida o una acción…").fill("engine-rules-docs");
  await expect(page.getByText("Documentar las reglas de boundaries", { exact: true }).last()).toBeVisible();
  await page.keyboard.press("Escape");

  await openMenu(local);
  await page.getByRole("menuitem", { name: /Ver corrida/ }).click();
  await expect(page.getByRole("heading", { name: "Saluda al mundo", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: /Grafo del flujo juguete/ })).toBeVisible();

  await sidebar(page).getByRole("button", { name: /Stacks de PR/ }).click();
  await page.getByRole("tab", { name: "Lista" }).click();
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
