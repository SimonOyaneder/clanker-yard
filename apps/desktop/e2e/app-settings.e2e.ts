import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@clanker/api";
import { readCoreJson } from "@clanker/api/node";
import type { Page } from "@playwright/test";
import { expect, setTheme, snap, test } from "./harness";

// Ajustes de la app contra el core de demo: instalar y quitar un pack desde una carpeta y cambiar los defaults de proyectos
// nuevos, sin reiniciar. Deja el core como lo encontró (el core de demo se comparte con otros archivos del mismo escenario).
test.describe.configure({ mode: "serial" });

const sidebar = (page: Page) => page.locator("[data-sidebar=sidebar]");
const section = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

async function snapBoth(page: Page, view: string): Promise<void> {
  const hideToasts = await page.addStyleTag({ content: "[data-sonner-toaster] { visibility: hidden !important; }" });
  const scroller = page.locator("main main");
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await scroller.evaluate((el) => el.scrollTo(0, 0));
    await snap(page, view, theme);
    await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await snap(page, `${view}-abajo`, theme);
  }
  await scroller.evaluate((el) => el.scrollTo(0, 0));
  await hideToasts.evaluate((style: Element) => style.remove());
}

const coreClient = (home: string) => {
  const info = readCoreJson(home)!;
  return createClient({ url: `http://127.0.0.1:${info.port}/rpc`, token: info.token, origin: "cli" });
};

test("Ajustes tiene sus cuatro secciones y los carriles cambian al instante", async ({ window: page, home }) => {
  await sidebar(page).getByRole("button", { name: "Ajustes" }).click();
  await expect(page.getByRole("navigation", { name: "Ubicación" })).toContainText("Ajustes");
  for (const name of ["Carriles", "Packs", "Proyectos nuevos", "Avanzado"]) await expect(section(page, name)).toBeVisible();
  await expect(section(page, "Avanzado")).toContainText(home);

  await section(page, "Carriles").getByRole("button", { name: "Subir la capacidad del carril dev" }).click();
  await expect(section(page, "Carriles").getByRole("status", { name: "Capacidad del carril dev", exact: true })).toHaveText("5");
  expect((await coreClient(home).system.lanes()).dev.capacity).toBe(5);
  await section(page, "Carriles").getByRole("button", { name: "Bajar la capacidad del carril dev" }).click();
  await expect.poll(async () => (await coreClient(home).system.lanes()).dev.capacity).toBe(4);
});

test("instalar un pack desde una carpeta rige sin reiniciar, y quitarlo lo saca", async ({ window: page, home }) => {
  const client = coreClient(home);
  const dir = join(home, "pack-acme");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pack.json"), JSON.stringify({ id: "acme", version: 1, activate: { githubOrgs: ["acme-co"] } }));
  const packs = section(page, "Packs");

  await packs.getByRole("button", { name: "Escribir la ruta" }).click();
  await packs.getByLabel("Carpeta del pack").fill(join(home, "no-hay-nada"));
  await packs.getByRole("button", { name: "Instalar", exact: true }).click();
  await expect(packs.getByRole("alert")).toContainText("pack.json");

  await packs.getByLabel("Carpeta del pack").fill(dir);
  await packs.getByRole("button", { name: "Instalar", exact: true }).click();
  await expect(packs.getByText("GitHub: acme-co")).toBeVisible();
  await expect(packs.getByText("Instalado")).toBeVisible();
  expect((await client.packs.list()).map((p) => p.id)).toContain("acme");
  await snapBoth(page, "ajustes-app");

  await packs.getByRole("button", { name: "Acciones de acme" }).click();
  await page.getByRole("menuitem", { name: "Quitar" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Quitar" }).click();
  await expect(packs.getByText("GitHub: acme-co")).toBeHidden();
  expect((await client.packs.list()).map((p) => p.id)).not.toContain("acme");
});

test("los defaults de proyectos nuevos se guardan y el siguiente proyecto los toma", async ({ window: page, home }) => {
  const client = coreClient(home);
  const defaults = section(page, "Proyectos nuevos");
  const before = await client.projects.defaults();

  await defaults.getByLabel("Corridas a la vez").fill("3");
  await defaults.getByLabel("Tope de gasto por corrida (USD)").fill("7.5");
  await page.getByRole("button", { name: /Guardar cambios/ }).click();
  await expect(page.getByRole("region", { name: "Cambios sin guardar" })).toBeHidden();
  await expect.poll(() => client.projects.defaults()).toMatchObject({ parallel: 3, maxCostUsd: 7.5 });

  const created = await client.projects.create({ slug: "con-defaults", name: "Con defaults", tracker: "local" });
  expect(created).toMatchObject({ parallel: 3, maxCostUsd: 7.5 });

  await client.projects.setDefaults({ parallel: before.parallel, maxCostUsd: before.maxCostUsd });
  await client.projects.update({ id: created.id, status: "archived" });
});
