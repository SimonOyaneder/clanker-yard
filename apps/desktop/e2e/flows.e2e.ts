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

test("duplicar un incluido da uno tuyo y archivarlo lo saca de la lista", async ({ window: page }) => {
  await page.getByRole("button", { name: "Duplicar para editar" }).click();
  const list = page.getByRole("list", { name: "Flujos", exact: true });
  await expect(list.getByRole("listitem").filter({ hasText: "manda sobre el incluido" })).toHaveCount(1);
  await expect(list.getByRole("listitem").filter({ hasText: "reemplazado por el tuyo" })).toHaveCount(1);
  await page.getByRole("button", { name: "Archivar", exact: true }).click();
  await expect(list.getByRole("listitem").filter({ hasText: "reemplazado por el tuyo" })).toHaveCount(0);
  await expect(page.getByText(/Mostrar archivados \(1\)/)).toBeVisible();
});
