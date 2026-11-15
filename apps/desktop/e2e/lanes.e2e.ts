import type { Page } from "@playwright/test";
import { expect, setTheme, snap, test } from "./harness";

// La vista de Operación contra el escenario `lanes` del core de demo (`packages/testkit/src/lanes-scenario.ts`):
// dev lleno, una corrida estacionada con su PR prestado a un rebase en mantenimiento y el breaker de GitHub abierto.
test.use({ scenario: "lanes" });
test.describe.configure({ mode: "serial" });

const sidebar = (page: Page) => page.locator("[data-sidebar=sidebar]");
const lane = (page: Page, name: string) => page.getByRole("region", { name });

async function snapBoth(page: Page, view: string): Promise<void> {
  // Los toasts de la acción anterior taparían la captura.
  const hideToasts = await page.addStyleTag({ content: "[data-sonner-toaster] { visibility: hidden !important; }" });
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await snap(page, view, theme);
  }
  await hideToasts.evaluate((style: Element) => style.remove());
}

test("los carriles se ven por separado: un rebase corre en mantenimiento con dev lleno", async ({ window: page }) => {
  await sidebar(page).getByRole("button", { name: /Boundaries de engines/ }).click();
  await expect(page.getByRole("heading", { name: "Boundaries de engines" })).toBeVisible();

  const dev = lane(page, "Carril dev");
  await expect(dev.getByText("1/1", { exact: true })).toBeVisible();
  await expect(dev.getByText("Separar el cálculo de comisiones")).toBeVisible();
  // El stepper sale del flujo real: el parallel de reviews es el paso actual.
  await expect(dev.getByRole("list", { name: "Pasos del flujo" })).toBeVisible();
  await expect(dev.locator('[aria-current="step"]')).toContainText("reviews");

  const maintenance = lane(page, "Carril mantenimiento");
  await expect(maintenance.getByText("1/2", { exact: true })).toBeVisible();
  await expect(maintenance.getByText("rebase v1")).toBeVisible();
  await expect(maintenance.getByText(/PR prestado de/)).toBeVisible();
});

test("la corrida estacionada va aparte con su decisión y el breaker abierto dice cuándo se reintenta", async ({ window: page }) => {
  const parked = page.getByRole("heading", { name: /Estacionadas/ }).locator("xpath=ancestor::section[1]");
  await expect(parked.getByText("necesita a una persona")).toBeVisible();
  await expect(parked.getByText(/implement se pasó del tope de gasto/)).toBeVisible();
  await expect(parked.getByText(/Su PR está prestado al carril de mantenimiento/)).toBeVisible();

  const breaker = page.getByRole("region", { name: "Breakers abiertos" });
  await expect(breaker.getByText("En pausa: github")).toBeVisible();
  await expect(breaker.getByText("límite de GitHub")).toBeVisible();
  await expect(breaker.getByText(/Próximo reintento/)).toBeVisible();

  const stats = page.getByLabel("Métricas");
  await expect(stats).toContainText("PRs abiertos");
  await expect(stats).toContainText("Decisiones pendientes");

  // La cola: la issue de menos prioridad está arriba porque alguien la subió; la saltada va en Bloqueadas.
  const queue = page.getByRole("heading", { name: /En cola/ }).locator("xpath=ancestor::section[1]");
  await expect(queue.getByRole("listitem").first()).toContainText("Documentar los boundaries en el README");
  const blocked = page.getByRole("heading", { name: /Bloqueadas/ }).locator("xpath=ancestor::section[1]");
  await expect(blocked.getByText("saltada", { exact: true })).toBeVisible();

  await snapBoth(page, "proyecto-carriles");
});

test("pausar y reanudar el proyecto con el botón y con ⇧⌘Y", async ({ window: page }) => {
  await page.getByRole("button", { name: /^Pausar/ }).click();
  await expect(page.getByText("pausado", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Reanudar/ }).click();
  await expect(page.getByText("activo", { exact: true })).toBeVisible();

  await page.keyboard.press("Meta+Shift+Y");
  await expect(page.getByText("pausado", { exact: true })).toBeVisible();
  await page.keyboard.press("Meta+Shift+Y");
  await expect(page.getByText("activo", { exact: true })).toBeVisible();
});

test("subir una issue en la cola y devolver la saltada desde el menú contextual", async ({ window: page }) => {
  const queue = page.getByRole("heading", { name: /En cola/ }).locator("xpath=ancestor::section[1]");
  const row = queue.getByRole("listitem").filter({ hasText: "Reglas de boundaries para engines nuevas" });
  // Con la fila pegada al borde de la ventana el menú se abre hacia arriba y soltar el botón derecho cae sobre un ítem: se sube la fila antes.
  await row.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: /Subirla en la cola/ }).click();
  await expect(queue.getByRole("listitem").first()).toContainText("Reglas de boundaries para engines nuevas");

  const blocked = page.getByRole("heading", { name: /Bloqueadas/ }).locator("xpath=ancestor::section[1]");
  await blocked.getByRole("button", { name: /Volver/ }).click();
  await expect(page.getByRole("heading", { name: /Bloqueadas/ })).toBeHidden();
  await expect(queue.getByRole("listitem")).toHaveCount(3);
});

test("el paralelismo se cambia desde el menú del proyecto y desde ⌘K", async ({ window: page }) => {
  await page.getByRole("button", { name: "Más acciones del proyecto" }).click();
  await page.getByRole("menuitem", { name: "Cambiar paralelismo" }).click();
  await page.getByRole("menuitemradio", { name: /^2 corridas/ }).click();
  await expect(lane(page, "Carril dev").getByText("1/2", { exact: true })).toBeVisible();

  // ⌘K es un atajo del menú nativo, que Playwright no dispara: se abre con el buscador del header.
  // Al cerrarse el menú el foco vuelve a su botón y su tooltip se abre: Esc lo cierra para que no tape el buscador.
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Buscar o ejecutar/ }).click();
  await page.getByRole("option", { name: /Cambiar paralelismo/ }).click();
  await page.getByRole("option", { name: /^1 corrida a la vez/ }).click();
  await expect(lane(page, "Carril dev").getByText("1/1", { exact: true })).toBeVisible();
});
