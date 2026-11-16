import type { Page } from "@playwright/test";
import { expect, setTheme, snap, test } from "./harness";

// La biblioteca de Flujos contra el core de demo: los flujos incluidos, duplicar uno y archivar la copia.
test.describe.configure({ mode: "serial" });

const sidebar = (page: Page) => page.locator("[data-sidebar=sidebar]");

async function snapBoth(page: Page, view: string): Promise<void> {
  const hideToasts = await page.addStyleTag({ content: "[data-sonner-toaster] { visibility: hidden !important; }" });
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await snap(page, view, theme);
  }
  await hideToasts.evaluate((style: Element) => style.remove());
}

test("los flujos incluidos se ven con su grafo y su historial de versiones", async ({ window: page }) => {
  await sidebar(page).getByRole("button", { name: /^Flujos/ }).click();
  const list = page.getByRole("list", { name: "Flujos", exact: true });
  const row = list.getByRole("listitem").filter({ hasText: "techlead-clasico" });
  await expect(row).toContainText("incluido");
  await row.getByRole("button").click();
  await expect(page.getByRole("group", { name: "Grafo del flujo techlead-clasico" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Versiones" })).toContainText("vigente");
  await snapBoth(page, "flujos-biblioteca");
});

test("duplicar un incluido da uno tuyo, se edita en el canvas y como JSON, con diff e historial, y archivarlo lo saca de la lista", async ({ window: page }) => {
  await page.getByRole("button", { name: "Duplicar para editar" }).click();
  const list = page.getByRole("list", { name: "Flujos", exact: true });
  await expect(list.getByRole("listitem").filter({ hasText: "manda sobre el incluido" })).toHaveCount(1);
  await expect(list.getByRole("listitem").filter({ hasText: "reemplazado por el tuyo" })).toHaveCount(1);

  // Editar: un campo inválido se marca en su línea; arreglado, Guardar muestra el diff y crea la versión 2.
  await page.getByRole("button", { name: "Editar", exact: true }).click();
  await expect(page.getByRole("group", { name: /^Canvas del flujo/ })).toBeVisible();
  await page.getByText("plan", { exact: true }).first().click();
  await expect(page.getByRole("complementary", { name: "Propiedades de plan" })).toBeVisible();
  await snapBoth(page, "flujos-canvas");
  await page.getByRole("tab", { name: "JSON" }).click();
  const editor = page.getByRole("textbox", { name: /en JSON/ });
  const original = await editor.inputValue();
  const broken = JSON.stringify({ ...JSON.parse(original), name: 42 }, null, 2);
  await editor.fill(broken);
  const problems = page.getByRole("list", { name: "Problemas por arreglar" });
  await expect(problems).toContainText("campo `name`");
  await snapBoth(page, "flujos-editor-error");
  await editor.fill(JSON.stringify({ ...JSON.parse(original), name: "Mi techlead" }, null, 2));
  await expect(page.getByRole("status")).toHaveText("1 cambio por guardar");
  await page.getByRole("button", { name: "Guardar…" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByRole("list", { name: "Cambios" })).toContainText("Mi techlead");
  await snapBoth(page, "flujos-editor-diff");
  await dialog.getByRole("button", { name: "Guardar versión nueva" }).click();
  const versions = page.getByRole("region", { name: "Versiones" });
  await expect(versions).toContainText("versión 2");
  await versions.getByRole("button", { name: "Volver a la versión 1" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Volver a esta versión" }).click();
  await expect(versions).toContainText("versión 3");

  await page.getByRole("button", { name: "Archivar", exact: true }).click();
  await expect(list.getByRole("listitem").filter({ hasText: "reemplazado por el tuyo" })).toHaveCount(0);
  await expect(page.getByText(/Mostrar archivados \(1\)/)).toBeVisible();
});
