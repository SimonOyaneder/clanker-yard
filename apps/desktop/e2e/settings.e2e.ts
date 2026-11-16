import { createClient } from "@clanker/api";
import { readCoreJson } from "@clanker/api/node";
import type { Page } from "@playwright/test";
import { expect, setTheme, snap, test } from "./harness";

// Ajustes del proyecto contra el core de demo: un proyecto propio (con su tracker local y su cola) para no depender de lo que
// dejaron otros archivos en el mismo core.
test.use({ scenario: "default" });
test.describe.configure({ mode: "serial" });

const sidebar = (page: Page) => page.locator("[data-sidebar=sidebar]");
const section = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const select = async (page: Page, name: string, option: string | RegExp) => {
  await page.getByRole("combobox", { name }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
};

// Ajustes es más alto que cualquier pantalla: cada vista se captura arriba y abajo, con el scroll de su contenedor.
async function snapBoth(page: Page, view: string): Promise<void> {
  // Los toasts de la acción anterior taparían la captura.
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

test.beforeAll(async ({ window: page, home }) => {
  const client = coreClient(home);
  const project = await client.projects.create({ slug: "ajustes", name: "Ajustes demo", tracker: "local", defaultFlowId: "juguete", defaultProfileId: "juguete" });
  await client.issues.createLocal({ projectId: project.id, title: "Ajustar las rondas de review" });
  await sidebar(page).getByRole("button", { name: /Ajustes demo/ }).click();
  await expect(page.getByRole("heading", { name: "Ajustes demo" })).toBeVisible();
});

test("⇧⌘3 abre Ajustes, y cambiar reviewRounds se ve en el siguiente runs.start", async ({ window: page, home }) => {
  const client = coreClient(home);
  const project = (await client.projects.list()).find((p) => p.slug === "ajustes")!;

  await page.keyboard.press("Meta+Shift+3");
  await expect(page.getByRole("tab", { name: "Ajustes" })).toHaveAttribute("aria-selected", "true");
  // Con el flujo juguete no hay parámetros con default: la sección lo dice y no inventa campos.
  await expect(section(page, "Flujo y parámetros").getByText("El flujo juguete no declara parámetros con default.")).toBeVisible();

  // El flujo por defecto trae sus parámetros con el default como placeholder.
  await select(page, "Flujo por defecto", "techlead-clasico");
  await expect(page.getByLabel("Rondas de review")).toHaveAttribute("placeholder", "3");
  await expect(page.getByText(/También lo leen: council \(default 2\), rebase-conflicto/).first()).toBeVisible();

  // El repo del proyecto (el que registró el core de demo) y su label.
  await select(page, "Agregar un repo registrado", "demo");
  await page.getByLabel("Labels de demo").fill("backend");
  await page.getByLabel("Labels de demo").press("Enter");

  await page.getByLabel("Rondas de review").fill("5");
  await page.getByRole("button", { name: /Guardar cambios/ }).click();
  await expect(page.getByText(/Ajustes de Ajustes demo guardados: repos, flujo, parámetros del flujo/)).toBeVisible();
  await expect(page.getByRole("region", { name: "Cambios sin guardar" })).toBeHidden();
  await expect.poll(async () => (await client.projects.get({ id: project.id })).flowParams).toEqual({ reviewRounds: 5 });

  // La siguiente corrida arranca con las 5 rondas; los defaults del flujo quedaron intactos.
  const [issue] = await client.issues.list({ projectId: project.id });
  const run = await client.runs.start({ projectId: project.id, issueId: issue!.id });
  expect(run.flow.slug).toBe("techlead-clasico");
  expect(run.params).toMatchObject({ reviewRounds: 5, checkRounds: 3, externalRounds: 3, base: expect.any(String) });
  await client.runs.cancel({ id: run.id });

  await snapBoth(page, "ajustes");
});

test("un valor inválido dice qué escribir y no deja guardar; ⌘S guarda y Deshacer devuelve el valor", async ({ window: page, home }) => {
  const client = coreClient(home);
  const project = (await client.projects.list()).find((p) => p.slug === "ajustes")!;
  // El toast del guardado del test anterior también tiene "Deshacer", y deshacerlo devolvería otro valor: se espera a que se vaya.
  // Con el puntero encima un toast no se cierra: se saca de donde quedó tras pulsar "Guardar cambios".
  await page.mouse.move(0, 0);
  await expect(page.getByRole("button", { name: "Deshacer" })).toHaveCount(0, { timeout: 15_000 });

  await page.getByLabel("Rondas de review").fill("0");
  await expect(page.getByRole("alert").filter({ hasText: "Escribe un entero de 1 en adelante (el flujo usa 3)" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Guardar cambios/ })).toBeDisabled();
  await snapBoth(page, "ajustes-error");

  await page.getByLabel("Rondas de review").fill("8");
  await page.keyboard.press("Meta+s");
  await expect.poll(async () => (await client.projects.get({ id: project.id })).flowParams).toEqual({ reviewRounds: 8 });

  await page.getByRole("button", { name: "Deshacer" }).click();
  await expect.poll(async () => (await client.projects.get({ id: project.id })).flowParams).toEqual({ reviewRounds: 5 });
  await expect(page.getByLabel("Rondas de review")).toHaveValue("5");
});

test("los filtros de la cola se editan desde 'Filtros de la cola' y la cola vacía ofrece Editar filtros", async ({ window: page, home }) => {
  const client = coreClient(home);
  const project = (await client.projects.list()).find((p) => p.slug === "ajustes")!;

  await page.keyboard.press("Meta+Shift+1");
  await page.getByRole("button", { name: "Más acciones del proyecto" }).click();
  await page.getByRole("menuitem", { name: "Filtros de la cola" }).click();
  await expect(page.getByRole("tab", { name: "Ajustes" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Labels que debe tener")).toBeFocused();

  await page.getByLabel("Labels que debe tener").fill("clanker");
  await page.getByLabel("Labels que debe tener").press("Enter");
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect.poll(async () => (await client.projects.get({ id: project.id })).queueFilter).toEqual({ labels: ["clanker"] });

  // Ninguna issue tiene ese label: la cola queda vacía y dice cómo arreglarlo.
  await page.keyboard.press("Meta+Shift+1");
  await expect(page.getByText(/0 issues en todo con el label clanker/)).toBeVisible();
  await page.getByRole("button", { name: "Editar filtros" }).click();
  await expect(page.getByRole("tab", { name: "Ajustes" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Labels que debe tener")).toBeFocused();
});

test("el mapeo de estados de un proyecto de Linear se ajusta por estado", async ({ window: page, home }) => {
  const client = coreClient(home);
  const linear = await client.projects.create({ slug: "ajustes-linear", name: "Ajustes Linear", tracker: "linear", trackerRef: "boundaries", defaultFlowId: "juguete" });
  await sidebar(page).getByRole("button", { name: /Ajustes Linear/ }).click();
  await page.keyboard.press("Meta+Shift+3");

  const mapping = section(page, "Mapeo de estados");
  await mapping.getByLabel("Nombre de un estado del tracker").fill("In Staging");
  await mapping.getByRole("button", { name: "Agregar estado" }).click();
  await select(page, "Categoría de In Staging", "En review");
  await page.getByRole("button", { name: "Guardar cambios" }).click();

  await expect.poll(async () => (await client.projects.get({ id: linear.id })).statusMapping).toEqual({ "In Staging": "in_review" });
  // La captura empieza en la sección del mapeo.
  const hideToasts = await page.addStyleTag({ content: "[data-sonner-toaster] { visibility: hidden !important; }" });
  await mapping.evaluate((el) => el.scrollIntoView({ block: "start" }));
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await snap(page, "ajustes-mapeo", theme);
  }
  await hideToasts.evaluate((style: Element) => style.remove());
});
