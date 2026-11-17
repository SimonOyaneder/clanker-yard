import type { Page } from "@playwright/test";
import { expect, setTheme, snap, test } from "./harness";

// La vista de un PR local (stacks locales) contra el escenario `prs` del core de demo: `engine-rules-docs` vive solo en el
// repo del demo (`seedLocalPrBranches`), con tres commits y un servicio Ruby largo. Se revisa como en GitHub: descripción,
// commits, el diff entero o commit por commit, unificado o lado a lado, y archivos vistos.
test.use({ scenario: "prs" });
test.describe.configure({ mode: "serial" });

const TITLE = "Documentar las reglas de boundaries";
const SERVICE = "app/services/boundaries/rules_service.rb";

async function snapBoth(page: Page, view: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await snap(page, view, theme);
  }
}

async function openLocalPr(page: Page): Promise<void> {
  await page.locator("[data-sidebar=sidebar]").getByRole("button", { name: /Stacks de PR/ }).click();
  const card = page.getByRole("group", { name: `engine-rules-docs ${TITLE}` });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.focus();
  await card.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
}

test("Enter abre la vista del PR local con su branch en el breadcrumb y Esc vuelve a los stacks", async ({ window: page }) => {
  await openLocalPr(page);

  await expect(page.getByRole("navigation", { name: "Ubicación" })).toContainText("engine-rules-docs");
  await expect(page.getByRole("heading", { name: "Qué cambia" })).toBeVisible();
  await expect(page.getByText("Boundaries::RulesService").first()).toBeVisible();
  await expect(page.getByRole("tab", { name: /Commits 3/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Archivos 2/ })).toBeVisible();
  await snapBoth(page, "pr-local-descripcion");

  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Stacks de PR" })).toBeVisible();
});

test("los commits se listan en orden y abrir uno muestra solo lo que cambió", async ({ window: page }) => {
  await openLocalPr(page);
  await page.getByRole("tab", { name: /Commits 3/ }).click();
  const commits = page.getByRole("listitem").filter({ hasText: /\(boundaries\)/ });
  await expect(commits).toHaveCount(3);
  await expect(commits.nth(0)).toContainText("servicio de reglas entre engines");
  await expect(commits.nth(2)).toContainText("Cada regla dice que ya se revisó.");
  await snapBoth(page, "pr-local-commits");

  await commits.nth(1).getByRole("button").click();
  const files = page.getByTestId("local-pr-files");
  await expect(files.getByRole("region", { name: "docs/boundaries.md" })).toBeVisible();
  await expect(files.getByRole("region", { name: SERVICE })).toHaveCount(0);

  await page.keyboard.press("]");
  await expect(files.getByRole("region", { name: SERVICE })).toBeVisible();
  await expect(files.getByRole("region", { name: "docs/boundaries.md" })).toHaveCount(0);
  await page.keyboard.press("a");
  await expect(files.getByRole("region")).toHaveCount(2);
});

test("la barra del diff queda fija arriba: al hacer scroll el código no pasa por detrás de ella", async ({ window: page }) => {
  await openLocalPr(page);
  await page.getByRole("tab", { name: /Archivos 2/ }).click();
  const toolbar = page.getByTestId("local-pr-files-toolbar");
  const files = page.getByTestId("local-pr-files");
  await expect(files.getByRole("region", { name: SERVICE })).toBeVisible();
  // Un archivo largo no se encoge para caber: la lista desborda y hace scroll.
  expect(await files.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  const before = (await toolbar.boundingBox())!;

  await files.evaluate((el) => el.scrollBy(0, 1200));
  await expect.poll(() => files.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  const after = (await toolbar.boundingBox())!;
  expect(after.y).toBe(before.y);
  // El área que hace scroll empieza justo debajo de la barra: nada se dibuja entre las pestañas y la barra.
  const scroller = (await files.boundingBox())!;
  expect(scroller.y).toBeGreaterThanOrEqual(after.y + after.height - 1);
  const tabs = (await page.getByRole("tablist").boundingBox())!;
  expect(after.y).toBeGreaterThanOrEqual(tabs.y + tabs.height);
  await snapBoth(page, "pr-local-archivos-scroll");
});

test("el código sale con el color de su lenguaje, y S lo muestra lado a lado con los dos lados del mismo ancho", async ({ window: page }) => {
  await openLocalPr(page);
  await page.getByRole("tab", { name: /Archivos 2/ }).click();
  const service = page.getByTestId("local-pr-files").getByRole("region", { name: SERVICE });
  await expect(service.locator(".hljs-keyword").first()).toBeVisible();

  await page.keyboard.press("s");
  const pair = service.locator("tr[data-kind='pair']").filter({ has: page.locator("td[data-kind='add']") }).first();
  await expect(pair).toBeVisible();
  const [left, right] = await Promise.all([pair.locator("td").nth(2).boundingBox(), pair.locator("td").nth(5).boundingBox()]);
  expect(Math.abs(left!.width - right!.width)).toBeLessThan(2);
  await snapBoth(page, "pr-local-lado-a-lado");
  await page.keyboard.press("s");
});

test("marcar un archivo como visto lo pliega, suma al progreso y se recuerda al volver", async ({ window: page }) => {
  await openLocalPr(page);
  await page.getByRole("tab", { name: /Archivos 2/ }).click();
  const service = page.getByTestId("local-pr-files").getByRole("region", { name: SERVICE });
  await expect(service.locator("tr").first()).toBeVisible();

  await service.getByRole("checkbox", { name: `Marcar ${SERVICE} como visto` }).click();
  await expect(page.getByText("1 de 2 archivos vistos")).toBeVisible();
  await expect(service.locator("tr")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await openLocalPr(page);
  await page.getByRole("tab", { name: /Archivos 2/ }).click();
  await expect(page.getByText("1 de 2 archivos vistos")).toBeVisible();
  await service.getByRole("checkbox", { name: `Marcar ${SERVICE} como visto` }).click();
  await expect(page.getByText("0 de 2 archivos vistos")).toBeVisible();
});
